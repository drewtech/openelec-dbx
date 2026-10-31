# Lakebase demo 1: synced tables

Two gold marts copied into **Lakebase** (Databricks-managed Postgres) as *synced tables*, so
they answer Postgres point lookups next to the SQL-warehouse path Genie and the dashboard use.

| Unity Catalog source | Synced table (UC entry) | Postgres table | Primary key |
|---|---|---|---|
| `openelec.gold.dim_facility` (545 rows) | `openelec.serving.dim_facility` | `serving.dim_facility` | `facility_code` |
| `openelec.gold.facility_capacity_factor` (117,087 rows at 2026-10-31; 116,695 synced, see Verify) | `openelec.serving.facility_capacity_factor` | `serving.facility_capacity_factor` | `facility_code, nem_date` |

Defined in [`resources/lakebase.yml`](../resources/lakebase.yml) (root bundle). Status and
findings: [SPEC.md](../SPEC.md) Phase 8. Checks to paste into the warehouse / Lakebase SQL
editor: [`checks.sql`](checks.sql). Terminal demo: [`tools/lakebase_query.py`](../tools/lakebase_query.py).

`dbx` below means the `databricks` CLI with your auth applied (see [CLAUDE.md](../CLAUDE.md)).

## Prerequisites

- The medallion pipeline has run, so `openelec.gold.dim_facility` and
  `openelec.gold.facility_capacity_factor` exist.
- Databricks CLI >= 1.23.0 (the `postgres_synced_tables` bundle resource and `postgres`
  commands are **Beta**; the resource was validated against 1.23.0 via an offline
  `databricks bundle schema` check). The bundle's `databricks_cli_version` now requires `>=1.23.0`.
- [`uv`](https://docs.astral.sh/uv/) for the terminal script (it installs `psycopg` on the fly).
  No local `psql` needed.
- Free Edition auth is PAT only; no OAuth login.

## Free Edition notes

- **One Lakebase project per account**, with scale-to-zero compute (official limitations page).
  The docs are silent on synced tables, and legacy online tables are unsupported; step 4 below
  proved a synced table works on Free Edition (SPEC.md Phase 8 Findings).
- Synced tables do work on Free Edition (SPEC.md Phase 8 Findings). Each synced table runs its own
  managed serverless sync pipeline. Three pipelines (the `openelec` pipeline plus one sync pipeline
  per table) were created and coexisted idle without hitting the "one active pipeline per type" cap.
  Running two of them at once was never tried, so whether that is blocked is unknown: keep the sync
  pipelines and the `openelec` pipeline from running at the same time (the deploy steps below do).
- Fair-usage quota applies: keep re-syncs manual (below).

## One-time setup

1. **Lakebase enabled and a project exists.** The project is deliberately not part of the bundle
   (Free Edition allows one, and `bundle destroy` would delete a bundled one).

   ```bash
   dbx postgres list-projects
   ```

   - Error: Lakebase is not enabled on this workspace. Record it in SPEC.md Phase 8 and stop.
   - A project already exists: reuse it, and point the bundle at it with
     `--var lakebase_branch=projects/<project_id>/branches/<branch_id>` on every
     `bundle validate/summary/deploy` (the default is `projects/openelec/branches/production`),
     or set it once per shell instead:
     `export BUNDLE_VAR_lakebase_branch=projects/<project_id>/branches/<branch_id>`.
     `tools/lakebase_query.py` takes `--project` / `--branch` for the same reason.
   - None exists: create one named `openelec` (UI, or the command below), then confirm the
     `production` branch and its endpoint, and that the endpoint scales to zero.

     ```bash
     dbx postgres create-project openelec --json '{"spec":{"display_name":"openelec"}}'
     dbx postgres list-branches projects/openelec
     dbx postgres list-endpoints projects/openelec/branches/production
     ```

2. **UC schema and key pre-check.** On the SQL warehouse, run the `openelec.serving` schema
   statement at the end of [`setup.sql`](../setup.sql), then block **A** of
   [`checks.sql`](checks.sql). Primary-key columns become `NOT NULL`, rows with a NULL key are
   silently dropped, and duplicate keys fail the sync. `facility_capacity_factor` comes from a left
   join grouped by name and region, so this is a real risk. A1 must return **zero rows**. A2 must
   show no duplicates; on 2026-10-31 it returned 392 rows with a NULL `facility_code` (one per date,
   an unattributed bucket from the left join, not a real facility). That drop was accepted (see
   SPEC.md Phase 8 Findings), so those NULL-key rows are expected; any duplicate, or a NULL-key row
   in `dim_facility`, is a stop: the fix is in the gold mart or a `timeseries_key`, not a workaround
   here.

## Deploy

Keep the `openelec` pipeline and the `openelec_refresh` job idle while deploying (a sync starts
when the table is created).

3. **Validate, and check the table IDs.**

   ```bash
   dbx bundle validate --strict
   dbx bundle summary        # synced_table_id must read openelec.serving.<table>
   ```

   If `bundle summary` doesn't show `synced_table_id`, check the resolved value with
   `dbx bundle validate -o json | jq '.resources.postgres_synced_tables'`.

   If the IDs show a `dev_<user>_` prefix (target is `mode: development`), stop and fix it before
   deploying: the Postgres schema/table would not be `serving.*`.

4. **Deploy one table first** as the cheapest proof (`dim_facility`, 545 rows). Comment out the
   whole `serving_facility_capacity_factor` block in `resources/lakebase.yml`, then:

   ```bash
   dbx bundle deploy
   dbx postgres get-synced-table synced_tables/openelec.serving.dim_facility
   ```

   Repeat the `get-synced-table` until the table reports online / the initial snapshot succeeded.
   If the bundle path fails, record the error in SPEC.md and use the CLI fallback below.
   If Free Edition rejects the table outright, that is the finding (SPEC.md Phase 8).

5. **Add the second table.** Un-comment the block and `dbx bundle deploy` again, then
   `get-synced-table synced_tables/openelec.serving.facility_capacity_factor`. It has its own
   `new_pipeline_spec` (same as the first table), so there is one sync pipeline per synced table.
   Sharing the first table's pipeline with
   `existing_pipeline_id: ${resources.postgres_synced_tables.serving_dim_facility.pipeline_id}`
   does not work: `bundle plan` fails with `cannot resolve "...serving_dim_facility.pipeline_id":
   schema mismatch: field "pipeline_id" not found in resources.PostgresSyncedTableConfig`
   (CLI 1.23.0, direct engine). The `pipeline_id` exists on the remote `get-synced-table` status but
   can't be interpolated. This is why the tables are deployed in two passes (steps 4 and 5): the
   sync pipelines never run together. Deployed this way the second table went online in about 70
   seconds, and was not blocked by the existing `openelec` and first sync pipelines (SPEC.md Phase 8
   Findings).

Editing a synced table's definition in YAML deletes and recreates it with a full re-snapshot
(definitions can't be changed in place). Harmless at this size, but don't edit casually.

## Verify

6. Row counts: block **B** of [`checks.sql`](checks.sql). B1 on the warehouse, B2 in the Lakebase SQL
   editor; they must match minus the NULL-key rows B1 reports. Expect `dim_facility` to drop 0 rows
   and `facility_capacity_factor` to have 392 fewer rows than the source (116,695 vs 117,087 as of
   2026-10-31 data; it drifts as data grows, so use "source count minus the NULL-key rows reported by
   B1"). B3 shows the column types; expect `fueltech_groups` as `jsonb`.
7. The terminal script:

   ```bash
   uv run tools/lakebase_query.py                 # defaults: --project openelec --branch production
   uv run tools/lakebase_query.py --facility <code> --profile <cli profile>
   python3 tools/lakebase_query.py --print-sql    # just show the queries; no network, no psycopg
   ```

   It prints a `dim_facility` lookup, the latest 7 days of `facility_capacity_factor` for that
   facility, and a `jsonb` array-contains query, with each query's time. Connect time is reported
   separately and includes TLS/auth and any scale-from-zero wake-up (the compute wakes on
   connection); the first query is labelled only because caches may be cold. This ran end to end
   on 2026-10-31: connect ~1.3 s (the endpoint was already active, so not a cold start) and about
   210 ms per query. Read that figure carefully: a bare `SELECT 1` costs the same (~217 ms), so
   it is almost entirely the network round trip (client in Australia, endpoint in us-east-2), not
   server execution time. For the server-side number, run the lookup under
   `EXPLAIN (ANALYZE)` in the Lakebase SQL editor and read "Execution Time" (measured values:
   step 3 of the demo walkthrough).
8. Run block **C** of `checks.sql` in the Lakebase SQL editor (project, branch `production`, SQL
   Editor); the same lookup should return the same row as the terminal script. Checked in the UI on
   2026-10-31: 1 row, with the editor showing 239 ms, which is again network round trip, not
   database time.

## Demo walkthrough (~5 min)

1. **Catalog Explorer**: open `openelec.serving.dim_facility`. It's a synced-table entry: show
   the source table, sync mode (Snapshot), the sync pipeline, and **Sync now**.
2. **Lakebase UI**: the `openelec` project, branch `production`, **Tables**
   (`serving.dim_facility`, `serving.facility_capacity_factor`), then **SQL Editor**: run C1, then C2
   from `checks.sql`.
3. **Terminal**: `uv run tools/lakebase_query.py`. Point out: it asked the CLI for a short-lived
   OAuth credential (valid ~1 hour, used as the Postgres password), the three timings, and the
   `jsonb` query on what was an array column in Unity Catalog. Be honest about the timings: from
   Australia to a us-east-2 endpoint each query is ~210 ms, and `SELECT 1` costs the same, so the
   demo shows correctness and the primary-key index (`EXPLAIN` shows an index scan on the PK index
   of a partition), not low server latency. Use `EXPLAIN (ANALYZE)` for the server-side time, and
   don't compare the terminal numbers with warehouse latency. The same applies in the SQL editor
   (step 2): right after **Run**, click **Explain (Analyze)** to show the execution time. As measured
   on 2026-10-31: `dim_facility` PK lookup 0.04 to 0.2 ms, `facility_capacity_factor` last-7-days
   query 0.08 ms, versus ~213 ms median client round trip (`SELECT 1`) and 239 ms shown by the editor
   for the same lookup. Your numbers will vary with location and endpoint region.
4. Talking points: the tables are **read-only** copies (writes go to the Delta source, never to
   Postgres); freshness is **the last sync time**, not real-time; the compute **scales to zero**,
   so the first connection after a quiet spell is slower (the wake-up lands in `connect:`). The
   endpoint's suspend timeout is 24 hours, so it is not a cold start unless the endpoint has been idle
   for more than 24 h; don't expect one in a demo run soon after the last connection.

## Re-sync

Sources are materialized views, so only SNAPSHOT mode is possible and re-sync is manual. After the
next `openelec` pipeline refresh, either click **Sync now** on the synced table in Catalog
Explorer, or:

```bash
dbx pipelines start-update <sync_pipeline_id>   # the table's pipeline_id, from get-synced-table
```

Then confirm the last sync time advanced. On 2026-10-31 the `dim_facility` sync pipeline update ran
(WAITING_FOR_RESOURCES -> COMPLETED in ~46 s) but `last_sync.sync_end_time` did not move and the
event log showed no data movement. Likely, but unproven, because the source MV had no new commit
since the first sync, so a re-sync only shows fresh data after a real `openelec` refresh. Don't run
this back-to-back with the `openelec`
pipeline (see Free Edition notes). Wiring a sync task into the `openelec_refresh` job is a possible
next step, not done here.

## How it works

- **Name mapping**: UC `catalog.schema.table` becomes Postgres `schema.table` in database
  `databricks_postgres`, so `openelec.serving.dim_facility` is `serving.dim_facility`. The UC
  schema `openelec.serving` is a separate schema from `openelec.gold` (the source) and holds the
  synced-table entries.
- **Types**: `ARRAY<STRING>` -> `jsonb` (`dim_facility.fueltech_groups`), `DATE` -> `date`,
  `DOUBLE` -> `double precision`, `BIGINT` -> `bigint`, boolean -> `boolean`, `STRING` -> `text`
  (verified live 2026-10-31).
- **Why SNAPSHOT**: TRIGGERED and CONTINUOUS need a change data feed on the source; materialized
  views don't support one, and every gold mart is a pipeline MV. Throughput is roughly 2,000 rows/s
  per compute unit, so ~117k rows is about a minute (observed: the second table, 116,695 rows, was
  online about 70 s after creation).
- **Primary keys**: PK columns become `NOT NULL`; NULL-key rows are silently dropped; duplicate keys
  fail the pipeline (unless a `timeseries_key` is set). Synced tables are stored partitioned in
  Postgres (the sync swaps in a staged copy), so the primary-key index shows up as a
  `__db_tmp_..._pkey` partition index in `EXPLAIN`.
- **Postgres access**: the user who created the synced tables can read them; no grants needed. A
  Databricks App's service principal would need its own Postgres role and grants (out of scope here).

## Teardown

Don't use `bundle destroy` for this: it removes the whole bundle (pipeline, job, Genie space too).
Instead delete the synced tables either by removing their blocks from `resources/lakebase.yml` and
running `dbx bundle deploy`, or directly:

```bash
dbx postgres delete-synced-table synced_tables/openelec.serving.facility_capacity_factor
dbx postgres delete-synced-table synced_tables/openelec.serving.dim_facility
```

The sources disagree on whether deleting the UC synced table also drops the Postgres table, so
check afterwards in the Lakebase SQL editor with
`SELECT * FROM information_schema.tables WHERE table_schema = 'serving'` and drop leftovers by
hand. Also check for a leftover sync pipeline (`dbx pipelines list-pipelines`, look for the
synced table's pipeline) and for leftover tables in `openelec.serving` (Catalog Explorer, or
`dbx tables list openelec serving`). The Lakebase project is not touched; delete it in the UI or with
`dbx postgres delete-project` only when you really are done (Free Edition allows just one).
`delete-project` soft-deletes by default; add `--purge` for a hard delete, and check whether a
soft-deleted project still counts toward the one-project cap (unverified).

## CLI fallback (if the bundle resource misbehaves)

The same table created with the CLI instead of the bundle. The JSON shape below is the request
body for the Postgres API and is still **unverified** (the bundle path worked, so this was never
used); check it against
`dbx postgres create-synced-table --help` first.

```bash
dbx postgres create-synced-table openelec.serving.dim_facility --json '{
  "spec": {
    "source_table_full_name": "openelec.gold.dim_facility",
    "primary_key_columns": ["facility_code"],
    "scheduling_policy": "SNAPSHOT",
    "branch": "projects/openelec/branches/production",
    "postgres_database": "databricks_postgres",
    "create_database_objects_if_missing": true,
    "new_pipeline_spec": {"storage_catalog": "openelec", "storage_schema": "serving"}
  }
}'
```

Never use the legacy `synced_database_tables` / online-tables resources; they are unsupported on
Free Edition.
