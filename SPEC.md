# openelec-dbx — Pipeline Spec

Spec-driven build log for the bronze→silver→gold pipeline. See [CLAUDE.md](CLAUDE.md) for
project-wide conventions and constraints; this file is the detailed plan **and** the
running record of what's actually done. Update the checkboxes and Status table as work
lands — this is the source of truth for progress, not the CLAUDE.md next-steps list.

## Status

| Phase | State | Notes |
|---|---|---|
| 0 — Foundation | ✅ Done | Bundle deployed, catalog/schemas/volume created, egress test complete — see finding below. |
| 1 — Bronze | 🔄 In progress | 1a (bucket backfill) + bronze tables done and verified. 1b (API incremental) written but blocked — API key returns 401 everywhere, waiting on user to regenerate. |
| 2 — Silver | ⬜ Not started | |
| 3 — Gold | ⬜ Not started | |
| 4 — Orchestration | ⬜ Not started | |
| 5 — Dashboard | ⬜ Deferred | Build in UI first, `bundle generate` after |
| 6 — Genie | ⬜ Deferred | Requires direct engine (already committed) |

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

### 1b — API incremental (keyed) — 🚧 blocked on a bad API key

- [x] `ingestion/fetch_api.py` written and deployed: notebook-task shape, key via
      `dbutils.secrets.get(scope="openelec", key="api_key")`. Facility codes sourced from
      the already-landed `openelec.bronze.facilities_raw` (one fewer keyed call, same
      codes) rather than a separate registry fetch. Chunks in 30s, fetches both `1d`
      (366-day lookback) and `5m` (7-day lookback) windows per chunk. Logs
      `rate_limit.remaining` from `/v4/me`; backs off on 429.
- [ ] **Blocked:** test run completed but `1d=0 5m=0 failed=38` — every request 401'd.
      Root-caused via local repro (bypassing Databricks entirely) to the key itself, not
      the code: `Authorization: Bearer <key>` fails on `/v4/me`, `/v4/facilities/`, *and*
      `/v4/data/facilities/NEM` alike — a blanket auth rejection, not an endpoint/scope
      issue. Verified the key is transmitted intact (byte-for-byte hex dump, no
      whitespace/truncation) and the header format matches documented usage, and that
      `X-API-Key` also fails — ruling out a header-scheme guess. The 1Password item was
      created the same day as this test; likely needs regeneration/activation on
      platform.openelectricity.org.au. **Waiting on the user to check/regenerate.**
- [ ] This **is** a bundled, scheduled job resource — see Phase 4. Not wired in yet;
      finish testing 1b standalone first.

### Bronze tables — ✅ done

- [x] `pipelines/transformations/bronze.py` — one streaming table per source
      (`facilities_raw`, `stats_energy_raw`), one row per file, JSON preserved as text
      via Auto Loader:

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

**Verify:** ✅ files under the Volume (135 total) → pipeline update `COMPLETED` on first
run → `count(*)`: `facilities_raw`=1, `stats_energy_raw`=134, matching files landed
exactly → spot-checked `raw_json` parses and matches the source API/bucket shape.

---

## Phase 2 — Silver

- [ ] `utils/fueltech.py` — fueltech → group / renewable-flag mapping. This exists only
      in the docs, never in either API, so it is hardcoded: `coal_black|coal_brown →
      coal`; `gas_ccgt|gas_ocgt|gas_recip|gas_steam|gas_wcmg → gas`; `solar_*` → solar;
      `wind|wind_offshore` → wind; `bioenergy_*` → bioenergy; plus `hydro`,
      `distillate`, and battery charge/discharge separately. `nuclear`, `imports`,
      `exports`, `interconnector` and the aggregator techs have no group — leave null
      rather than inventing one.
- [ ] `utils/schemas.py` — explicit `StructType` for each source. Both are versioned
      payloads that will drift; keeping schemas in one importable module beats
      scattering `from_json` literals across transformations.
- [ ] `silver.py` — `dim_unit` (materialized view from the bucket facilities blob, grain
      `unit_code`, carries fueltech/group/renewable flag, capacity, emissions factor,
      dispatch type, lat/lng).
- [ ] `silver.py` — `generation_daily_by_fueltech` (materialized view from bucket stats;
      positional value array → `posexplode` for timestamps; grain `nem_date ×
      network_region × fueltech_id × metric`; no join needed).
- [ ] `silver.py` — `facility_generation` (streaming table from API bronze, long format;
      explode metric → unit → `[ts, value]` pairs; derive `nem_time` from UTC points,
      not the naive envelope fields; dedupe re-fetches via `create_auto_cdc_flow` keyed
      on `(unit_code, interval_ts_utc, metric)`, sequenced by `fetched_at`).
- [ ] Expectations: `expect_or_drop` on null keys; warn-only `expect` on `value >= 0`
      for power/energy (negative is legitimate for load/battery-charging units).

**Verify:** `dim_unit` count ≈ NEM unit count, no null `fueltech_id` on operating units;
`generation_daily_by_fueltech` spans 1999→now with no date gaps; zero duplicate
`(unit_code, interval_ts_utc, metric)` in the fact; nulls survived rather than becoming zeros.

---

## Phase 3 — Gold

All materialized views. Two families, matching the two grains:

- [ ] `generation_mix_daily` — MWh by `nem_date × network_region × fueltech_group`.
- [ ] `renewable_share_daily` — renewable vs total.
- [ ] `emissions_intensity_daily` — tCO2/MWh by region.
- [ ] `facility_daily` — per-facility daily energy, emissions, market value (via API
      path, trailing 2 years, joined through `dim_unit`).
- [ ] `facility_capacity_factor` — generated vs `capacity_registered`.

Grain and naming matter more than usual here: this schema is what Genie will read, and
Genie answers are only as good as its column names. Prefer `generated_mwh` over `value`,
`nem_date` over `d`, and put a `comment` on every table and column — Genie uses them.

**Verify:** sanity SQL against known reality — coal dominates NSW1/QLD1 early; renewable
share trends up strongly post-2015; SA1 wind share is high; no date gaps in daily series.

---

## Phase 4 — Orchestration

Now that ingestion runs in-workspace too (Phase 0 finding), the whole thing schedules
together in one bundled job — no separate local cron / GitHub Actions tier needed.

- [ ] `resources/job.yml`, two tasks in one job:
  1. `fetch_api_incremental` — `notebook_task` running `ingestion/fetch_api.py`, no
     cluster key (serverless), `environment_key` pointing at a `client: "4"` spec with
     `requests` as a dependency.
  2. `refresh_pipeline` — `pipeline_task` referencing
     `${resources.pipelines.openelec.id}`, `depends_on: [fetch_api_incremental]`.
  Daily `quartz_cron_expression` on the job (not per-task).
- [ ] Confirm the one-time `fetch_bucket.py` backfill (Phase 1a) stays **out** of this
      bundled job — run once, ad hoc, not on the recurring schedule.

Guardrails, since blowing the fair-usage quota costs a full day of workspace compute (no
published DBU numbers exist): keep SQL warehouse auto-stop tight — one idling 2X-Small
outweighs the job itself — don't leave interactive notebooks attached, and stay under 5
concurrent tasks and 1 active pipeline. Design the pipeline to backfill gaps on the next
successful run rather than assuming every tick fires.

**Verify:** trigger the job manually, confirm a green pipeline update; check the schedule
registered — and note `mode: development` pauses schedules, so unpause deliberately.

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
