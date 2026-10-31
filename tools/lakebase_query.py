# /// script
# requires-python = ">=3.10"
# dependencies = ["psycopg[binary]>=3"]
# ///
"""Query the Lakebase synced tables (serving.dim_facility, serving.facility_capacity_factor)
over a plain Postgres connection and print timings.

Part of Lakebase demo 1 (see lakebase/README.md). The synced tables are defined in
resources/lakebase.yml; this script is the "terminal" half of the demo: one Postgres
connection, three point queries, per-query timings.

Shells out to the `databricks` CLI for everything credential-related, so it needs whatever
auth you've already set up for it -- a CLI profile, or DATABRICKS_HOST/DATABRICKS_TOKEN env
vars, or a wrapper around either -- or pass `--profile <name>`. It:

  1. finds the branch's compute endpoint host (`databricks postgres list-endpoints` / `get-endpoint`),
  2. mints a short-lived OAuth database credential (`generate-database-credential`, ~1h TTL),
  3. connects with sslmode=require, using your Databricks user name as the Postgres role.

The credential is used as the Postgres password and is never printed. Run it with uv, which
installs psycopg into a throwaway environment from the header above:

    uv run tools/lakebase_query.py
    uv run tools/lakebase_query.py --project openelec --branch production --facility <code>
    python3 tools/lakebase_query.py --print-sql      # no network, no psycopg needed

The compute scales to zero when idle, and a wake-up happens on connection, so the `connect:`
line includes TLS/auth and any scale-from-zero wake-up (a second or more after a quiet spell).
Connect time and query times are reported separately; the first query is labelled because
caches are cold, not because of wake-up.

Usage: uv run tools/lakebase_query.py [--project ID] [--branch ID] [--facility CODE]
                                      [--print-sql] [--profile NAME]
"""

import argparse
import json
import subprocess
import sys
import time

DATABASE = "databricks_postgres"

# The facility used when --facility isn't given: the largest by registered capacity.
Q_DEFAULT_FACILITY = """
SELECT facility_code
FROM serving.dim_facility
ORDER BY capacity_registered_mw DESC NULLS LAST
LIMIT 1
"""

Q_FACILITY = """
SELECT facility_code, facility_name, network_region, primary_fueltech_group,
       fueltech_groups, unit_count, capacity_registered_mw
FROM serving.dim_facility
WHERE facility_code = %s
"""

Q_LAST_7_DAYS = """
SELECT nem_date, energy_mwh, capacity_factor
FROM serving.facility_capacity_factor
WHERE facility_code = %s
ORDER BY nem_date DESC
LIMIT 7
"""

# `?` is the jsonb "contains this top-level string" operator (fueltech_groups was ARRAY<STRING>
# in Unity Catalog; the sync stores it as jsonb). psycopg uses %s placeholders, so a literal `?`
# is safe, and the value is still sent as a parameter.
Q_BATTERY_FACILITIES = """
SELECT facility_code, facility_name, fueltech_groups
FROM serving.dim_facility
WHERE fueltech_groups ? %s
ORDER BY facility_name
LIMIT 10
"""

BATTERY_GROUP = "battery_discharging"


def print_sql() -> None:
    queries = [
        ("default facility (when --facility is omitted)", Q_DEFAULT_FACILITY, None),
        ("1. dim_facility point lookup", Q_FACILITY, "<facility_code>"),
        ("2. latest 7 days of facility_capacity_factor", Q_LAST_7_DAYS, "<facility_code>"),
        ("3. jsonb array-contains", Q_BATTERY_FACILITIES, BATTERY_GROUP),
    ]
    for title, sql, param in queries:
        print(f"-- {title}" + (f"   [param: {param}]" if param else ""))
        print(sql.strip() + ";\n")


def dbx(profile: str | None, *args: str) -> dict | list:
    cmd = ["databricks"]
    if profile:
        cmd += ["--profile", profile]
    result = subprocess.run([*cmd, *args, "-o", "json"], capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"databricks {' '.join(args)} failed:\n{result.stderr}")
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as e:
        # Report the parse error position only; stdout may hold a credential.
        raise RuntimeError(f"databricks {' '.join(args)} did not return JSON ({e.msg} at char {e.pos}).")


def _key_names(obj) -> str:
    """Describe a CLI JSON response by key names only (never values: it may hold a credential)."""
    if isinstance(obj, dict):
        return str(sorted(obj))
    if isinstance(obj, list):
        return f"a list of {len(obj)} item(s)" + (f" with keys {sorted(obj[0])}" if obj and isinstance(obj[0], dict) else "")
    return f"a {type(obj).__name__}"


def resolve_connection(profile: str | None, project: str, branch: str) -> tuple[str, str, str]:
    """Return (host, role, token) for the branch's first compute endpoint."""
    try:
        projects = dbx(profile, "postgres", "list-projects")
    except RuntimeError as e:
        raise SystemExit(
            f"Could not list Lakebase projects -- Lakebase may not be enabled on this "
            f"workspace, or the CLI is not authenticated.\n{e}"
        )
    names = [p.get("name") for p in projects] if isinstance(projects, list) else []
    if f"projects/{project}" not in names:
        raise SystemExit(
            f"No Lakebase project 'projects/{project}' found (have: {names or 'none'}). "
            "Create it first (lakebase/README.md) or pass --project."
        )

    branch_name = f"projects/{project}/branches/{branch}"
    step = "list-endpoints"
    last = None  # most recent CLI response; on KeyError only its key names are reported
    try:
        endpoints = last = dbx(profile, "postgres", "list-endpoints", branch_name)
        if isinstance(endpoints, dict):
            endpoints = endpoints.get("endpoints", [])
        if not endpoints:
            raise SystemExit(f"No compute endpoint on {branch_name}.")
        step = "list-endpoints (endpoint name)"
        last = endpoints[0]
        endpoint_name = endpoints[0]["name"]

        step = "get-endpoint (status.hosts.host)"
        endpoint = last = dbx(profile, "postgres", "get-endpoint", endpoint_name)
        host = endpoint["status"]["hosts"]["host"]

        step = "generate-database-credential (token)"
        cred = last = dbx(profile, "postgres", "generate-database-credential", endpoint_name)
        token = cred["token"]
        last = None  # never keep a reference the error path could look at

        step = "current-user me (userName)"
        me = last = dbx(profile, "current-user", "me")
        role = me["userName"]
    except RuntimeError as e:
        # dbx() puts only the CLI's stderr in the message, never stdout (which holds the token).
        raise SystemExit(f"Step '{step}' failed.\n{e}")
    except (KeyError, IndexError, TypeError) as e:
        raise SystemExit(
            f"Step '{step}': unexpected response shape ({type(e).__name__}: {e}). "
            f"Top-level keys returned: {_key_names(last)}. Values are not shown."
        )
    return host, role, token


def timed(cur, label: str, sql: str, params: tuple, note: str = "") -> list:
    start = time.perf_counter()
    cur.execute(sql, params)
    rows = cur.fetchall()
    ms = (time.perf_counter() - start) * 1000
    print(f"\n{label}  ({len(rows)} rows, {ms:.1f} ms{note})")
    cols = [d.name for d in cur.description]
    shown = [[("" if v is None else str(v)) for v in row] for row in rows]
    widths = [max(len(c), *(len(r[i]) for r in shown)) if shown else len(c) for i, c in enumerate(cols)]
    print("  " + "  ".join(c.ljust(w) for c, w in zip(cols, widths)))
    for r in shown:
        print("  " + "  ".join(v.ljust(w) for v, w in zip(r, widths)))
    return rows


def run(args: argparse.Namespace) -> int:
    import psycopg  # imported here so --help/--print-sql work without it installed

    print(f"Resolving endpoint for projects/{args.project}/branches/{args.branch}...", file=sys.stderr)
    host, role, token = resolve_connection(args.profile, args.project, args.branch)
    print(f"  host: {host}   role: {role}   (credential minted, not shown)", file=sys.stderr)

    start = time.perf_counter()
    conn = psycopg.connect(
        host=host, port=5432, dbname=DATABASE, user=role, password=token, sslmode="require"
    )
    print(f"connect: {(time.perf_counter() - start) * 1000:.1f} ms  (includes TLS/auth and any scale-from-zero wake-up)")

    with conn, conn.cursor() as cur:
        facility = args.facility
        first_note = ", first query: caches may be cold"
        if facility is None:
            rows = timed(cur, "default facility (largest by capacity)", Q_DEFAULT_FACILITY, (), first_note)
            if not rows:
                raise SystemExit("serving.dim_facility is empty -- has the first sync finished?")
            facility = rows[0][0]
            first_note = ""
        timed(cur, f"1. dim_facility lookup: {facility}", Q_FACILITY, (facility,), first_note)
        timed(cur, f"2. latest 7 days of facility_capacity_factor: {facility}", Q_LAST_7_DAYS, (facility,))
        timed(cur, f"3. facilities with {BATTERY_GROUP} in fueltech_groups (jsonb)", Q_BATTERY_FACILITIES, (BATTERY_GROUP,))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--project", default="openelec", help="Lakebase project ID (default: openelec)")
    parser.add_argument("--branch", default="production", help="Lakebase branch ID (default: production)")
    parser.add_argument("--facility", help="facility_code to look up (default: largest by registered capacity)")
    parser.add_argument("--print-sql", action="store_true", help="print the queries and exit (no network)")
    parser.add_argument("--profile", help="databricks CLI profile to use for every CLI call")
    args = parser.parse_args()

    if args.print_sql:
        print_sql()
        return 0
    return run(args)


if __name__ == "__main__":
    raise SystemExit(main())
