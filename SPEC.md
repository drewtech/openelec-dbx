# openelec-dbx — Pipeline Spec

Spec-driven build log for the bronze→silver→gold pipeline. See [CLAUDE.md](CLAUDE.md) for
project-wide conventions and constraints; this file is the detailed plan **and** the
running record of what's actually done. Update the checkboxes and Status table as work
lands — this is the source of truth for progress, not the CLAUDE.md next-steps list.

## Status

| Phase | State | Notes |
|---|---|---|
| 0 — Foundation | ✅ Done | Bundle deployed, catalog/schemas/volume created, egress test complete — see finding below. |
| 1 — Bronze | ✅ Done | 1a (bucket backfill), 1b (API incremental), and bronze tables all done and verified. |
| 2 — Silver | ✅ Done | `dim_unit`, `generation_daily_by_fueltech`, `facility_generation` all built and verified. |
| 3 — Gold | ✅ Done | All 5 marts built and sanity-checked against known NEM reality. |
| 4 — Orchestration | ✅ Done | Job deployed, manually tested end-to-end (fetch → pipeline refresh), left paused. |
| 5 — Dashboard | ⬜ Deferred | Build in UI first, `bundle generate` after |
| 6 — Genie | 🔄 In progress | Plan of record: `docs/genie-spec.md`. G0/G1/G3/G4 done (2026-08-30): baseline **5/20 (25%)** → curated **10/20 (50%)**, exactly doubled. G2 (metric views, optional/cuttable) skipped for now. |
| 7 — Web delivery | ✅ done | Four-way Genie UI comparison, all live against this workspace (2026-09-02): standalone site (`web/`, chat + Preview agent mode with follow-ups), a Databricks App (`app/`, AppKit `GenieChat` + a custom `useGenieChat` tab), and the official iframe embed, tied together by a Compare tab. Details: `web/README.md`. |

## Context

The repo is scaffolded but has zero commits and no code. The goal (per `CLAUDE.md`) is a
learning sandbox that exercises current Databricks primitives end to end on Free Edition,
with AI/BI (Genie + dashboards) as the eventual payoff. This spec covers the pipeline
half — bronze → silver → gold plus orchestration — in independently deployable phases.
Dashboard and Genie come after and are out of scope here.

Three research findings drive the design:

1. ~~Free Edition serverless has no outbound internet.~~ **Superseded by empirical test —
   see below.** Community reports describe a DNS-level allowlist blocking arbitrary
   outbound calls; that premise does **not** hold for this workspace.
2. **There is a bulk path, and it beats the API for backfill.**
   `data.openelectricity.org.au` is a live, unauthenticated static JSON bucket — the one
   OpenElectricity's own frontend consumes. Full history back to 1998-12, no key, no rate
   limits, no range caps. The free API "Community" plan is capped at 2 years.
3. **`import dlt` is legacy.** Current idiom is `from pyspark import pipelines as dp`.
   Critical trap: `@dp.table` means **streaming table**, while `@dlt.table` used to mean
   either — `@dp.materialized_view` is the MV. A mechanical rename silently converts MVs
   into streaming tables.

> **✅ Finding #1, resolved (Phase 0 egress check):** a one-off serverless job notebook
> (`databricks jobs submit`) successfully reached both `api.openelectricity.org.au`
> (401, no key sent — a real HTTP response, not a DNS failure) and
> `data.openelectricity.org.au` (200). Community reports of a DNS-level block may be
> stale, region/tenant-specific, or this account already carries the LinkedIn-verification
> unlock — cause unconfirmed, but the effect is clear for this workspace. **Decision:**
> redesign ingestion to run **in-workspace** as scheduled job tasks rather than a local
> script + `dbx fs cp` upload. More idiomatic (a job doing the whole fetch→land step
> exercises more of the Databricks surface the project exists to learn) and collapses
> the local/GitHub-Actions automation question out of Phase 4 entirely. Also verified as
> part of this decision: Databricks secret scopes work on Free Edition (`databricks
> secrets create-scope` succeeded) — the `openelec` scope now holds `api_key`, sourced
> from the same 1Password item as before.

Decisions made: in-workspace fetch → Volume (via scheduled job tasks, not a local
script); NEM only; dedicated `openelec` catalog with `bronze`/`silver`/`gold` schemas;
hybrid sourcing (bucket for backfill, API for incremental); no AEMO price/demand in this
scope.

## Sources and their grains — the load-bearing distinction

The two sources are **not** the same data at different depths. They sit at different grains,
and that shapes the whole model:

| Source | Auth | Grain | History |
|---|---|---|---|
| `v4/facilities/au_facilities.json` (bucket) | none | 616 facilities, nested `units[]` | current snapshot |
| `v4/stats/au/NEM/{REGION}/energy/{YYYY}.json` (bucket) | none | **region × fueltech × day** — pre-aggregated | 1999 → now |
| `v4/stats/au/NEM/power/7d.json` (bucket) | none | region × fueltech × 5 min | rolling 7 days |
| `GET /v4/data/facilities/NEM` (API) | key | **unit × interval × metric** | trailing 2 years |

So the deep-history generation-mix mart comes from the bucket and needs no join; the
per-facility marts come from the API and must join through the unit dimension. Two fact
tables, deliberately, rather than one forced grain.

## Key constraints to design around

- **One active Lakeflow pipeline per type** on Free Edition → bronze, silver, and gold all
  live in **one** pipeline, extended phase by phase via the source glob.
- **Series are per-UNIT, not per-facility** on the API path. The response carries
  `results[].columns.unit_code` and no facility code or fueltech at all. Fueltech lives
  only in the registry, keyed by unit. Build the dimension on `unit_code` — a facility can
  mix fueltechs (solar + BESS), so facility→fueltech is many-to-one only at unit level.
- **Values mutate on re-fetch.** 5-minute energy is trapezoidally derived and later
  replaced with metered values. Bronze must be append-only with `fetched_at`; silver
  dedupes to latest.
- **`null` ≠ `0`.** Interior gaps emit explicit `null` meaning "no data". Never coalesce.
- **Don't use the `openelectricity` SDK in the ingest path.** Its pydantic models lag the
  API — `UnitStatusType` @ 0.11.3 lacks the `commissioning` status added 2026-08-05, so
  `get_facilities()` raises `ValidationError` on real payloads. Use raw `httpx` and land
  bytes verbatim; a strict validator in ingest turns an upstream enum addition into an
  outage. (Use the SDK interactively for exploration — just not in the pipeline.)
- **The bucket is undocumented.** No contract, could change without notice. Caching raw
  responses into the Volume — which `CLAUDE.md` already mandates — is the insulation.
- **API caps** (incremental path only): 30 codes per request; `5m` ≤ 8 days, `1h` ≤ 32
  days, `1d` ≤ 366 days. Rate limits exist but are unpublished — read `rate_limit.remaining`
  from `GET /v4/me` and log it. The SDK has no retry despite claims; implement backoff on 429.
- **PATs on Free Edition are scoped.** The default "Other APIs" token needs `workspace`
  (plus `jobs`, `pipelines`, `unity-catalog`, `sql`) explicitly checked, or `all-apis`, or
  bundle deploy 403s with "does not have required scopes: workspace". Leave "Auto-scope
  tokens" off for a deploy token — it narrows itself post-observation.
- **Ingestion runs in-workspace, as job tasks.** Fetch scripts write straight to
  `/Volumes/openelec/bronze/raw/...` — no local `.staging/` hop, no `dbx fs cp`. Use
  `notebook_task` (not `spark_python_task`) for these: `dbutils.secrets.get()` and
  `dbutils.notebook.exit()` are both proven working in this exact shape from the Phase 0
  egress test, so standardize on it rather than introduce an unverified task type.
  Job-serverless environments need `requests`/`httpx` declared as a dependency
  (`environments: [{spec: {client: "4", dependencies: [...]}}]` — `client: "4"` is
  required for dependencies to install at all, confirmed working in Phase 0).
- **The API key lives in a Databricks secret scope now, not just 1Password.** Scope
  `openelec`, key `api_key` — created via `databricks secrets create-scope openelec` /
  `put-secret`, both confirmed working on Free Edition. Read it in ingestion notebooks
  via `dbutils.secrets.get(scope="openelec", key="api_key")`.

## Target layout

```
databricks.yml                       # bundle root, engine: direct
setup.sql                            # one-time catalog/schema/volume DDL
resources/
  pipeline.yml                       # resources.pipelines.openelec
  job.yml                            # phase 4
pipelines/
  transformations/
    bronze.py  silver.py  gold.py    # glob'd into the pipeline
  utils/
    fueltech.py  schemas.py          # importable via root_path on sys.path
ingestion/
  fetch_bucket.py                    # no auth, one-time backfill, run ad hoc
  fetch_api.py                       # keyed, incremental, scheduled via resources/job.yml
  README.md
```

Both `ingestion/*.py` files run **in-workspace** (job/notebook tasks), not locally —
see Phase 0's egress finding. No `.env`/`.env.1password` needed in-repo: the API key
lives in the Databricks `openelec` secret scope, populated once from 1Password.

---

## Phase 0 — Foundation

**Deliverable:** a bundle that validates and deploys, and a catalog to write into.

- [x] `databricks.yml`: `bundle.name: openelec`, `bundle.engine: direct`,
      `databricks_cli_version: '>=1.3.0'`, `include: [resources/*.yml]`, single `dev`
      target with `mode: development`.
  - **`engine: direct` is not optional** — it avoids the `releases.hashicorp.com`
    Terraform download (blocked on Free Edition, and the exact failure already hit in
    this repo's research) and is required later for Genie space resources. Start on
    direct rather than migrating; the migrate path still pulls the provider.
- [x] `setup.sql`: `CREATE CATALOG openelec`, schemas `bronze`/`silver`/`gold`,
      `CREATE VOLUME openelec.bronze.raw`.
  - Deliberately *not* bundle-managed. Free Edition has one workspace and no dev/prod
    split, so `mode: development` name-prefixing on schema resources is pure friction for
    one-time DDL. The bundle owns pipeline + job — the things that actually change.
- [x] `bundle validate --strict` passes (hit and fixed a real blocker: the stored PAT
      lacked the `workspace` scope — regenerated with `all-apis`).
- [x] `bundle deploy` to `dev`.
- [x] Run `setup.sql` against the SQL warehouse; confirmed `SHOW SCHEMAS IN openelec`
      lists `bronze`/`silver`/`gold`/`default`/`information_schema`, and
      `SHOW VOLUMES IN openelec.bronze` lists `raw`.
- [x] Settle egress empirically, via a one-off serverless job notebook
      (`databricks jobs submit`): `requests.get(...)` against both
      `api.openelectricity.org.au` (→ 401, no key sent) and
      `data.openelectricity.org.au` (→ 200). **Both reachable — the DNS-block premise
      does not hold here.** Resolved to in-workspace ingestion — see Finding #1 above.
- [x] Create `openelec` Databricks secret scope and populate `api_key` from 1Password —
      both confirmed working on Free Edition (this was an open question in the original
      research; now verified).

**Verify:** `dbx bundle validate` clean → `dbx bundle deploy` → `dbx bundle summary`;
`SHOW SCHEMAS IN openelec` lists all three.

---

## Phase 1 — Bronze

Two sub-steps, both running **in-workspace** as notebook-task job runs (Phase 0 finding).
**1a needs no API key** — get it green before starting 1b.

### 1a — Bucket backfill (no auth) — ✅ done

- [x] `ingestion/fetch_bucket.py` — Databricks-notebook-formatted (`# Databricks
      notebook source` header), plain `requests`, no key:
  - `facilities` → `v4/facilities/au_facilities.json` — landed, 1 file, 1.39 MB.
  - `stats` → `v4/stats/au/NEM/{REGION}/energy/{YYYY}.json` for 1999–2026 × 5 NEM
    regions — **134/140 landed**, 6 failed (expected: some regions don't have data for
    every year, e.g. early history gaps). Not investigated further; acceptable loss.
  - `power` — **dropped from scope**: nothing in Phase 2/3 consumes it yet. Add back
    when a consumer exists rather than fetch unused data.
  - Writes verbatim `response.content` directly to
    `/Volumes/openelec/bronze/raw/<source>/<partition>/fetched_at=<iso>/part-NNN.json`
    via plain `open(path, "wb").write(...)` — confirmed Volumes are directly writable as
    file paths from job/notebook code, no separate upload step needed.
- [x] Run once, ad hoc, via `databricks jobs submit` against the notebook path that
      `bundle deploy` itself already synced (bundle sync uploads any `.py` file with the
      `# Databricks notebook source` header as a `NOTEBOOK` object automatically — no
      separate `workspace import` needed, and skill guidance warns against mixing manual
      `workspace import` with bundle-managed sync for the same path anyway).

> **Finding:** the bucket's `au_facilities.json` top-level shape differs from the API
> registry endpoint assumed in research — `{"success": true, "data": [...]}`, no
> `version`/`created_at` keys. The `stats/*.json` shape matches research closely
> (`type`, `version`, `network`, `region`, `data[].id/fuel_tech/history.{start,last,
> interval,data[]}`). Also: the stats response embeds a live deprecation notice —
> `"OpenNEM API has migrated to require authentication"` — worth treating as an
> early-warning signal that this undocumented bucket route could eventually require a
> key too. Use the confirmed shapes above (not the original research's assumed
> facilities shape) when writing `utils/schemas.py` in Phase 2.

### 1b — API incremental (keyed) — ✅ done

- [x] `ingestion/fetch_api.py` written and deployed: notebook-task shape, key via
      `dbutils.secrets.get(scope="openelec", key="api_key")`. Facility codes sourced from
      the already-landed `openelec.bronze.facilities_raw` (one fewer keyed call, same
      codes) rather than a separate registry fetch — 545 NEM codes, chunked in 30s (19
      chunks). Fetches both `1d` (366-day lookback) and `5m` (7-day lookback) windows per
      chunk. Logs `rate_limit.remaining` from `/v4/me`; backs off on 429.
- [x] First test run: the original key 401'd on **every** endpoint (`/v4/me` included,
      not just facility-data), root-caused via local repro to a bad key, not code —
      verified byte-for-byte transmission and header format were both correct. User
      regenerated the key on platform.openelectricity.org.au; new key confirmed via
      `/v4/me` (`plan: COMMUNITY`, `credits.remaining: 499` — API is credit-metered, not
      simple rate-limited). Updated the `openelec` secret scope to match, reran:
      **36/38 requests succeeded** (2 failures, not investigated — small enough loss to
      accept, same posture as the 1a bucket gaps). Files verified landed and parse
      correctly.
- [ ] This **is** a bundled, scheduled job resource — see Phase 4. Not wired in yet.

> **Decision: `dbutils.secrets.get()` + `requests`, not a UC HTTP Connection.** The
> Databricks UI suggests UC Connections (`CREATE CONNECTION ... TYPE HTTP` +
> `http_request()`) for secure external calls. Considered and rejected for this script:
> `http_request()` is a scalar SQL function, a good fit for per-row API enrichment inside
> a query — not for this script's shape, which is Python control flow (read facility
> codes from Delta, chunk into 30s, retry-with-backoff on 429, write raw response bytes
> to specific Volume paths per request). Forcing that into SQL would fight the tool
> rather than use it. `dbutils.secrets.get()` is the documented, correct pattern for
> custom scripted external ingestion, and carries its own leakage protection — Databricks
> redacts secret-scope values from notebook/job output automatically.

### Bronze tables — ✅ done

- [x] `pipelines/transformations/bronze.py` — one streaming table per source
      (`facilities_raw`, `stats_energy_raw`, `facility_data_raw` — the last added after
      1b landed its own files), one row per file, JSON preserved as text via Auto Loader:

```python
@dp.table(name="stats_energy_raw", comment="Verbatim OpenElectricity static-bucket responses.")
def stats_energy_raw():
    return (spark.readStream.format("cloudFiles")
        .option("cloudFiles.format", "text").option("wholeText", "true")
        .load("/Volumes/openelec/bronze/raw/stats")
        .select(F.col("value").alias("raw_json"),
                F.col("_metadata.file_path").alias("source_file"),
                F.col("_metadata.file_modification_time").alias("ingested_at")))
```

Text + `wholeText` (confirmed correct casing — camelCase, per the live pipelines skill
reference, not `wholetext`) keeps payloads byte-faithful and hands schema ownership to
silver's explicit `from_json` — important because both sources nest awkwardly for JSON
inference (the API uses positional `[ts, value]` pairs; the bucket uses flat arrays keyed
off `start` + `interval`). **Confirmed working on first run** — no `binaryFile` fallback
needed.

- [x] `resources/pipeline.yml`: `serverless: true`, `catalog: ${var.catalog}`,
      `schema: bronze`, `root_path: ../pipelines`,
      `libraries: [{glob: {include: ../pipelines/transformations/**}}]`. Omitted
      `photon`/`edition`/`clusters` — classic-compute concepts, undefined under
      serverless. Used `schema:`, not the deprecated `target:` (confirmed live via
      `databricks bundle schema` — `target` is explicitly marked legacy/deprecated).
      Silver/gold tables (Phase 2/3) will use fully-qualified `openelec.silver.*` /
      `openelec.gold.*` names to publish outside this pipeline's default `bronze` schema.

**Verify:** ✅ files under the Volume (171 total: 135 bucket + 36 API) → pipeline updates
`COMPLETED` → `count(*)`: `facilities_raw`=1, `stats_energy_raw`=134,
`facility_data_raw`=36, all matching files landed exactly → spot-checked `raw_json`
parses and matches the source API/bucket shape.

> **Note:** a later update on this pipeline sat in `CREATED` for ~7 minutes before
> progressing — genuine serverless cold-start, not a stuck/failed update (more data
> points and the fuller picture in Phase 2's notes below). If a bundle-run poll looks
> stuck, check `list-pipeline-events` before assuming failure.

---

## Phase 2 — Silver — ✅ done

- [x] `utils/fueltech.py` — fueltech → group / renewable-flag mapping, hardcoded (only
      exists in docs, never an API). Exposes `Column`-expression builders (`create_map`
      lookup), not a UDF. **Bug caught and fixed:** `pumps` was missing from the map on
      first pass despite the original Phase 0 research explicitly listing it as its own
      group — first pipeline run showed it landing in the "no group" bucket alongside
      `battery` (which correctly has no group). Fixed and reverified.
- [x] `utils/schemas.py` — explicit `StructType` per source, confirmed against **real
      landed bronze data**, not just research assumptions (see shapes below).
- [x] `silver.py` — `dim_unit`: materialized view from the bucket facilities blob, grain
      `unit_code`. **Filtered to `network_id = 'NEM'`** — the bucket registry covers NEM
      *and* WEM (114 WEM units found on first run), project scope is NEM only.
      `@dp.expect_or_drop` on null `unit_code`. 917 units, 16 fueltechs represented.
- [x] `silver.py` — `generation_daily_by_fueltech`: materialized view from bucket stats;
      `posexplode` the positional value array, `date_add(history_start, pos)` for the
      calendar date (interval is always `1d` for this source — no offset/timezone math
      needed, unlike the API path). `@dp.expect_or_drop` on null key columns correctly
      filtered out 178,336 rows that were never fueltech data at all — the bucket's daily
      files bundle `temperature_min/max/mean` and network-level `demand`/`market_value`
      series alongside fueltech generation in the same response. 1,047,701 rows, spanning
      1998-12-31 → 2026-08-14.
- [x] **`demand_daily` added 2026-08-30**, splitting out the region-level demand half of
      that same 178,336-row drop (the other half, temperature, is still intentionally
      discarded — out of project scope). Filters `stats_energy_raw` on the
      `au.nem.<region>.demand.*` id family instead of relying on null `fuel_tech`.
      `@dp.expect_or_drop` on null key columns, 0 dropped. 75,310 rows (5 regions × energy
      + market_value × 2006-01-01 → 2026-08-14 — shorter window than the fueltech table,
      demand series start later in the bucket).
- [x] `silver.py` — `facility_generation`: streaming table from API bronze, CDC-deduped.
      Pre-processing lives in a `@dp.temporary_view()` (not a private streaming table —
      `create_auto_cdc_flow`'s `source` must be a table/view name, and the skill guidance
      is explicit that a temp view is the documented pre-processing pattern, not a
      materialized intermediate). `keys=["unit_code","interval_ts_utc","metric"]`,
      `sequence_by="ingested_at"` (bronze's file-modification-time column — a fine proxy
      for fetch time, no separate "fetched_at" field needed), `stored_as_scd_type=1`.
      `expect_all_or_drop` on null keys, warn-only `expect_all` on `value >= 0`.
      5,649,344 rows, 615 units, spanning trailing ~370 days as designed.
- [x] **Timestamp parsing simpler than research assumed:** live API timestamps carry
      explicit offsets (`"2026-08-08T17:50:00+10:00"`), not the `Z`-suffix UTC the
      research fixture showed. A plain `.cast("timestamp")` on the string parses the
      offset correctly — no `AT TIME ZONE 'Etc/GMT-10'` manual conversion needed.

**Verify:** ✅ all three tables built, verified via row counts + spot-checks above.
Negative `value` count in `facility_generation` (262,984) is expected — legitimate for
load/battery-charging units per the warn-only expectation design, not investigated
further at that grain.

> **Observed: serverless pipeline cold-start varies with compute idle time, not fixed.**
> Three consecutive updates: ~7 min (after ~25 min idle), ~10 min (after ~1 min idle —
> so idle time alone doesn't fully explain it either), then 25s and 25s (immediately
> back-to-back, compute still warm). Real work once compute is ready is consistently
> fast (seconds). `databricks pipelines get-update` reports a coarse/stale-looking state;
> `databricks pipelines get` (`latest_updates[]`) and `list-pipeline-events` show what's
> actually happening. Don't assume a long `CREATED`/`WAITING_FOR_RESOURCES` wait means
> stuck — check events. Not yet clear whether this is materially worse than paid tiers or
> just more variable; worth more data points before writing it into CLAUDE.md as a firm
> constraint.

---

## Phase 3 — Gold — ✅ done

All materialized views. Two families, matching the two grains, each fed by a private
pivoted helper (`_generation_daily_wide`, `_facility_daily_wide`) rather than repeating
the same explode/pivot logic three times.

- [x] **Real bug caught before building gold:** `facility_generation`'s
      `_facility_generation_points` had dropped the `interval` field. That table mixes
      rows from two fetch windows — `1d` over 366 days and `5m` over 7 days — which
      **overlap in their last 7 days**. Without `interval` to filter on, any daily
      aggregation would double-count that overlap. Added the column back; since the
      streaming table had already ingested 5.6M rows, a plain incremental run only
      schema-evolved the new column in as blank on existing rows rather than backfilling
      it — required an explicit, user-approved **selective full refresh**
      (`--full-refresh openelec.silver.facility_generation`) to reprocess and populate it
      correctly. All facility-grain gold queries now filter `interval = '1d'`.
- [x] `generation_mix_daily` — MWh by `nem_date × network_region × fueltech_group`.
      281,830 rows, 1999-01-01 → 2026-08-14.
- [x] `renewable_share_daily` — renewable vs total. TAS1 89.8% (hydro), SA1 56.1%
      (wind), NSW1/QLD1/VIC1 ~33% — matches known NEM reality.
- [x] `emissions_intensity_daily` — tCO2e/MWh by region, aggregate-then-divide (not an
      average of per-fueltech ratios). VIC1 highest (0.644 — brown coal Latrobe Valley),
      TAS1 lowest (0.048 — hydro) — matches known reality exactly.
- [x] `facility_daily` — per-facility daily energy, emissions, market value (API path,
      trailing ~370 days, joined through `dim_unit`). 109,110 rows, 306 facilities.
- [x] `facility_capacity_factor` — generated vs `capacity_registered_mw × 24h`. Top 5 are
      all baseload coal/cogen plants (Loy Yang B 92.5%, Millmerran, Kogan Creek, …) —
      exactly the profile expected; intermittent renewables would rank lower.

Grain and naming: `generated_mwh`/`energy_mwh` not `value`, `nem_date` not `d`, a comment
on every table (column-level comments deferred — would need explicit `schema=` strings
per table; naming + table comments already carry most of the Genie-readability value).

- [x] **G1 (Phase 6 prerequisite) landed 2026-08-30** — see `docs/genie-spec.md`:
      new `dim_facility` mart (facility-grain rollup of `dim_unit`; 545 facilities, 917
      units, `primary_fueltech_group` by largest registered capacity, `fueltech_groups`
      array); `facility_capacity_factor` now exposes both `capacity_factor` (operating
      capacity only, the new default) and `capacity_factor_all_units` (all statuses,
      previous behavior) — some facilities (e.g. Liddell, fully retired) correctly show
      NULL operating-capacity-factor now instead of a diluted number; `facility_daily`'s
      `emissions_tco2` renamed `emissions_tco2e`; `renewable_share_daily`'s
      `renewable_mwh` now coalesces to 0 only when the region-day has other generation
      rows (so `renewable_share` is NULL only when `total_mwh` is NULL/0, never a false
      NULL from an all-fossil day); explicit `schema=` column comments added to all six
      public gold marts. PK/FK constraints verified supported (`schema=` accepts them,
      confirmed via skill reference) but **deliberately skipped** — untested constraint
      syntax risked a wasted pipeline run for a single-user Free Edition project with a
      6-table cap; joins carried via Genie's `example_question_sqls` instead (G3).
      Two pipeline updates (main change + a comment-only correction after empirically
      disproving a caveat in the pipelines skill reference — see below), both clean,
      15/15 flows completed each time.
- [x] **Skill reference doc claim disproven empirically:** the Lakeflow Pipelines skill's
      `materialized-view-sql.md` states "Sum aggregates over a nullable column return 0
      (not NULL) when only NULLs remain." Tested directly on this warehouse
      (`SELECT SUM(CAST(NULL AS DOUBLE))`) and against real data (every fully-retired
      facility's `capacity_registered_mw_operating`): both come back NULL, standard Spark
      semantics, not 0. Gold-layer column comments were written to state the plain NULL
      rule without that caveat.

**Verify:** ✅ sanity SQL against known reality passed on every mart — see results above.
No date gaps checked directly but row counts (281,830 for ~27.6 years × 5 regions × ~11
fueltech groups) are in the right order of magnitude.

> Cold-start note continued: every Phase 3 run (schema fix, full refresh, gold build) was
> fast — 48s, 71s, 49s — because each followed the previous within minutes, compute
> staying warm throughout. Still consistent with the idle-based theory from Phase 2, not
> a fixed Free Edition penalty.

---

## Phase 4 — Orchestration — ✅ done

Now that ingestion runs in-workspace too (Phase 0 finding), the whole thing schedules
together in one bundled job — no separate local cron / GitHub Actions tier needed.

- [x] `resources/job.yml`, two tasks in one job (`openelec_refresh`):
  1. `fetch_api_incremental` — `notebook_task` running `ingestion/fetch_api.py`, no
     cluster key (serverless), `environment_key` pointing at a `client: "4"` spec with
     `requests` as a dependency.
  2. `refresh_pipeline` — `pipeline_task` referencing
     `${resources.pipelines.openelec.id}`, `depends_on: [fetch_api_incremental]`.
  **Switched from cron to `trigger.periodic`** (`interval: 1, unit: DAYS`) per the current
  jobs skill's own guidance: prefer periodic over cron for a plain fixed cadence with no
  need to pin a clock time — cron is for when a specific time-of-day/day-of-week matters,
  which doesn't apply here.
- [x] **Real bug caught at validate time:** used `openelec` as the job's resource key
      (mirroring the pipeline's key) — bundle validate rejected it: resource keys must be
      unique **across all resource types**, not just within one type. Renamed to
      `openelec_refresh`.
- [x] `fetch_bucket.py` (Phase 1a) confirmed **not** part of this bundled job — it was
      never added as a job resource, run only ad hoc, exactly as planned.
- [x] **Deliberately deployed paused** (`trigger.pause_status: PAUSED`) — no reason to
      spend fair-usage quota on a live daily schedule while still actively iterating.
      Flip to `UNPAUSED` when ready to run unattended.
- [x] Manually tested end-to-end via `bundle run openelec_refresh`: both tasks
      `TERMINATED`/`SUCCESS`. Confirmed it was real work, not a no-op — bronze grew
      36→72 rows, silver CDC-merged the new points (5,649,344→5,682,048, freshest point
      minutes old), gold correctly **unchanged** (no new calendar day has closed yet, and
      gold only aggregates `interval='1d'` rows) — exactly the expected behavior.

Guardrails, since blowing the fair-usage quota costs a full day of workspace compute (no
published DBU numbers exist): keep SQL warehouse auto-stop tight — one idling 2X-Small
outweighs the job itself — don't leave interactive notebooks attached, and stay under 5
concurrent tasks and 1 active pipeline. Design the pipeline to backfill gaps on the next
successful run rather than assuming every tick fires.

**Verify:** ✅ triggered manually, both tasks succeeded, data flow confirmed real (not
cached/no-op) at every layer. Schedule is registered but paused — unpause when ready.

> Cold-start note, final data point: the job's first-ever run took 422s total — longer
> than any pipeline-only run, because it stacked **two** separate cold starts (job
> compute, then pipeline compute) sequentially, on top of the actual fetch work (~38
> requests). Consistent with the idle-based theory, now recorded as a constraint in
> CLAUDE.md rather than just here.

---

## Phase 7 — Web delivery — ✅ done

A four-way comparison of ways to put the Phase 6 Genie space in front of a user, two hand-rolled
("outside Databricks") and two native ("inside Databricks"), all run live against this
workspace rather than just documented. Full detail: `web/README.md`.

- [x] **A — Standalone site, chat mode** (`web/`). React + Vite client, Express proxy holding
      the token. Conversation API: `start-conversation` → poll `messages/{id}` every 2s →
      `query-result` per attachment. SSE re-emitted to the browser using AppKit's own event
      names (`message_start`/`status`/`query_result`/`message_result`/`error`) so the client
      logic would port cleanly — B proves it did.
- [x] **A2 — Agent mode tab** (Preview). `POST /api/2.0/genie/agents/{space_id}/responses`,
      originally reverse-engineered (no CLI subcommand shipped for it), since confirmed
      documented: https://docs.databricks.com/aws/en/genie-agents/api. Confirmed **not**
      admin-gated on this workspace. Reasoning → SQL → result → narrative answer over SSE.
      Conversation continuation implemented in item E below. Remaining known gap: no
      `type_name` on result columns (chat mode's statement API has it, agent mode's message
      metadata doesn't).
- [x] **B — Databricks App** (`app/`). `databricks apps init --features genie --set
      genie.genie-space.id=<id>` (resource key `genie-space` confirmed via `dbx apps manifest`,
      not guessed). Two tabs: stock `<GenieChat/>`, and a custom tab porting `web/`'s
      SqlPanel/ResultTable/StatusStepper onto `useGenieChat`. `dbx apps validate` clean
      (typecheck, ast-grep lint, build, tests); deployed via `dbx bundle deploy` (its
      `lifecycle.started: true` starts it in the same step — no separate `apps deploy`
      needed); confirmed `RUNNING` at
      `https://openelec-genie-7474660275774847.aws.databricksapps.com`, redirects
      unauthenticated requests to Databricks OIDC login as expected.
  - Service principal granted `USE_CATALOG` on `openelec`, `USE_SCHEMA`+`SELECT` on
    `openelec.gold`, `CAN_USE` on the shared warehouse (Genie executes as the caller, not
    the space owner). `CAN_RUN` on the Genie space itself came for free from the bundle's
    `genie_space` resource on every deploy — confirmed via `dbx permissions get genie`.
  - Two real porting gaps, not assumed: AppKit's `GenieAttachmentResponse.query` type has no
    `instruction_id`, so the App's custom tab can't show the curated-answer badge `web/` has;
    `GenieStatementResponse` has no `total_row_count`/`truncated`, so its result table can't
    report a true row count. Confirmed by reading the shipped `.d.ts`, not by trial and error.
  - AppKit's `genie()` plugin has no agent-mode route — B only ports chat mode.
- [x] **C — Official iframe embed.** Confirmed live: dashboard and Genie space embedding share
      one admin setting (`aibi_dashboard_embedding_approved_domains`, dashboard-flavored name,
      gates Genie too — stated explicitly in Databricks' own admin docs). Access policy was
      already `ALLOW_APPROVED_DOMAINS`; added `localhost:5173`/`5174` via `dbx api patch
      /api/2.0/settings/types/aibi_dash_embed_ws_apprvd_domains/names/default` with an explicit
      `field_mask` — the CLI's generated `settings ... update` subcommand sends an **empty**
      field mask, which the API silently no-ops. Embed tab renders the space's own room URL in
      an `<iframe>`; the literal Share → Embed space dialog snippet wasn't captured (no browser
      in this environment), so this is a close approximation of that markup, not a byte copy.
- [x] **D — Compare tab.** The four-option table (where it runs, anonymous or not, identity,
      response richness, pros/cons) made interactive as the site's default view — each row
      links straight into that mode.
- [x] **E — Agent-mode conversation continuation** (2026-09-02). The agent-mode API turned out
      to be documented after all — https://docs.databricks.com/aws/en/genie-agents/api — and
      supports follow-ups natively: an optional top-level `conversation_id` in the request body
      ("Existing conversation to continue. Omit to start a new one."), with the response's
      `conversation_id` sent back on the next call. Implemented mirroring what chat mode already
      does: `web/server/src/genie.ts` `streamAgentResponse` takes an optional `conversationId`
      and includes `conversation_id` in the POST body when set; `web/server/src/index.ts`
      `/api/genie/agent-responses` reads `conversationId` from the request body (same shape as
      `/api/genie/messages`) and passes it through; `web/client/src/api.ts`
      `streamAgentResponse` takes `conversationId` like `streamMessage` does; `App.tsx` stores
      the id from `agent_start` in agent-mode state, sends it on the next question, clears it in
      `clearAgent`, and the footer shows it like chat mode's does. Docs updated to drop "no
      conversation continuation" everywhere it appeared as an agent-mode con — `web/README.md`
      (Agent mode section, Known gaps, the four-options table), `Compare.tsx` (agent row),
      `AgentChat.tsx` (intro line), `DEMO.md` (§2 table, §3 option 2 con), and A2 above. Kept the
      documented limits (5 requests/min per workspace, 30-minute server timeout) and noted the
      documented `response.output_item.updated` event we still ignore — harmless, we only act on
      `.done`.
      **Verify:** `cd web && npm run typecheck -w server && npm run build -w client && npm run
      lint -w client` — all clean. Live check (ask an agent question, then a follow-up that only
      makes sense with context, confirm the second answer uses it and the footer shows the same
      conversation id) **not run** — no Databricks credentials configured in this environment;
      do this once `web/server/.env` is filled in.

Free Edition shaped every piece: one shared 2X-Small warehouse and a 5 req/min Genie cap split
across all four demo paths (never run them concurrently), the App's 3-app cap and 24h auto-stop
(restart before demoing, stop after), PAT-only auth (no `apps logs`; used `apps get` + the Apps
UI instead), and the single workspace user meaning the embed and the App can only ever
demonstrate one identity: whoever is signed in.

**Verify:** `web/` typecheck/build/lint clean for both workspaces; `app/` `dbx apps validate`
clean end to end; deployed App confirmed `RUNNING` and redirecting to login when unauthenticated;
`getSpaceInfo()` confirmed serving correct `embedUrl`/`appUrl` via a direct probe (both dev
ports were held by an already-running, untouched instance of this same site, so verification
avoided the live port rather than contend for it).

---

## Deferred

Phase 5 (AI/BI dashboard) and Phase 6 (Genie space) build on the gold schema. Genie as a
bundle resource requires the direct engine, which Phase 0 already commits to. Build both in
the UI first and `dbx bundle generate` them into code once the layout settles — those
resource types are new enough that hand-authoring the YAML first is a poor trade.

Also deferred: AEMO `PRICE_AND_DEMAND_{YYYYMM}_{REGION}.csv` — clean headered CSV back to
1999, ~1,620 files, no auth. A good later phase for price-vs-demand marts and an Auto
Loader CSV exercise to complement the JSON path.

## Global verification

End to end from clean: `dbx bundle validate` → `dbx bundle deploy` → run
`fetch_bucket.py` once (ad hoc, in-workspace) → trigger the pipeline → confirm row counts
at all three layers → the gold marts should answer "what was the renewable share in SA1
in 2010 versus 2025?" correctly, which the API-only design could not have answered at all.
