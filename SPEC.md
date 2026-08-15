# openelec-dbx — Pipeline Spec

Spec-driven build log for the bronze→silver→gold pipeline. See [CLAUDE.md](CLAUDE.md) for
project-wide conventions and constraints; this file is the detailed plan **and** the
running record of what's actually done. Update the checkboxes and Status table as work
lands — this is the source of truth for progress, not the CLAUDE.md next-steps list.

## Status

| Phase | State | Notes |
|---|---|---|
| 0 — Foundation | 🔄 In progress | `databricks.yml` + `setup.sql` written, `bundle validate --strict` passing. Deploy, DDL execution, and egress test still pending. |
| 1 — Bronze | ⬜ Not started | |
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

1. **Free Edition serverless has no outbound internet.** It is a DNS-level account
   allowlist, not a firewall quirk — arbitrary calls fail with `[Errno -3] Temporary
   failure in name resolution`. PyPI is allowlisted; OpenElectricity is not. So
   **ingestion runs locally** and lands raw JSON into a UC Volume; Databricks does
   transform/serve only. (LinkedIn identity verification reportedly unlocks egress, but
   nobody has published what it actually permits — not worth blocking on.)
2. **There is a bulk path, and it beats the API for backfill.**
   `data.openelectricity.org.au` is a live, unauthenticated static JSON bucket — the one
   OpenElectricity's own frontend consumes. Full history back to 1998-12, no key, no rate
   limits, no range caps. The free API "Community" plan is capped at 2 years.
3. **`import dlt` is legacy.** Current idiom is `from pyspark import pipelines as dp`.
   Critical trap: `@dp.table` means **streaming table**, while `@dlt.table` used to mean
   either — `@dp.materialized_view` is the MV. A mechanical rename silently converts MVs
   into streaming tables.

Decisions made: local fetch → Volume; NEM only; dedicated `openelec` catalog with
`bronze`/`silver`/`gold` schemas; hybrid sourcing (bucket for backfill, API for
incremental); no AEMO price/demand in this scope.

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
  fetch_bucket.py                    # no auth, backfill
  fetch_api.py                       # keyed, incremental
  README.md
.env.example
```

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
- [ ] `bundle deploy` to `dev`.
- [ ] Run `setup.sql` against the SQL warehouse; confirm `SHOW SCHEMAS IN openelec`
      lists all three.
- [ ] Settle egress empirically, in a scratch notebook: `requests.get(...)` against both
      `api.openelectricity.org.au` and `data.openelectricity.org.au`. `Errno -3` on both
      confirms the local-ingest design; anything else is a bonus worth redesigning for.

**Verify:** `dbx bundle validate` clean → `dbx bundle deploy` → `dbx bundle summary`;
`SHOW SCHEMAS IN openelec` lists all three.

---

## Phase 1 — Bronze

Two sub-steps. **1a is independently deployable and needs no API key** — get it green
before starting 1b.

### 1a — Bucket backfill (no auth)

- [ ] `ingestion/fetch_bucket.py`, plain `httpx`, no key:
  - `facilities` → `v4/facilities/au_facilities.json` (1.4 MB, one GET).
  - `stats` → `v4/stats/au/NEM/{REGION}/energy/{YYYY}.json` for 1999–2026 × 5 NEM
    regions. ~150 files, ~15 MB total — the entire 28-year backfill in one run, with no
    quota risk.
  - `power` → `v4/stats/au/NEM/power/7d.json` for the rolling 5-minute window.
  - Writes verbatim `response.text` to
    `.staging/<source>/<partition>/fetched_at=<iso>/part-NNN.json`. No parsing.
- [ ] Upload via the existing auth path: `dbx fs cp -r .staging/ /Volumes/openelec/bronze/raw/`.

### 1b — API incremental (keyed)

- [ ] `ingestion/fetch_api.py` — same raw-`httpx` discipline, `OPENELECTRICITY_API_KEY`
      from env. Key already in 1Password (vault `Dev`, item
      `7vlh7nkxgesxzkk6rfocdyrx7a`), wired into the generic `dbx`-style env-file lookup.
      Chunks facility codes in 30s and date ranges per interval cap. Default: trailing
      window at `1d`, plus a short `5m` window for recency. Logs `rate_limit.remaining`;
      backs off on 429.

### Bronze tables

- [ ] `pipelines/transformations/bronze.py` — one streaming table per source, one row
      per file, JSON preserved as text:

```python
@dp.table(name="stats_energy_raw", comment="Verbatim OpenElectricity static-bucket responses.")
def stats_energy_raw():
    return (spark.readStream.format("cloudFiles")
        .option("cloudFiles.format", "text").option("wholetext", "true")
        .load("/Volumes/openelec/bronze/raw/stats")
        .select("value",
                F.col("_metadata.file_path").alias("source_file"),
                F.col("_metadata.file_modification_time").alias("ingested_at")))
```

Text + `wholetext` keeps payloads byte-faithful and hands schema ownership to silver's
explicit `from_json` — important because both sources nest awkwardly for JSON inference
(the API uses positional `[ts, value]` pairs; the bucket uses flat arrays keyed off
`start` + `interval`). **Verify `wholetext` behaves under `cloudFiles` on first run; if
not, fall back to `cloudFiles.format = "binaryFile"` + `decode(content)`.**

- [ ] `resources/pipeline.yml`: `serverless: true`, `catalog: openelec`,
      `schema: bronze`, `root_path: ../pipelines`,
      `libraries: [{glob: {include: ../pipelines/transformations/**}}]`. Omit
      `photon`/`edition`/`clusters` — classic-compute concepts, undefined under
      serverless. Use `schema:`, not the deprecated `target:` (confirmed live via
      `databricks bundle schema` — `target` is explicitly marked legacy/deprecated).

**Verify:** files under the Volume; pipeline green; `count(*)` on each bronze table;
spot-check one `value` parses as JSON.

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

- [ ] `resources/job.yml`: one task, `pipeline_task` referencing
      `${resources.pipelines.openelec.id}`, daily `quartz_cron_expression`. No cluster
      key — serverless is implied by omission.
- [ ] Decide and implement the ingestion-automation tier (manual → local cron → GitHub
      Actions). GitHub Actions is the natural fit long-term: egress, holds both secrets,
      can `databricks fs cp`.

**The asymmetry is unavoidable and worth stating plainly:** the *pipeline* can be
scheduled in Databricks, but *ingestion cannot* — no egress. The backfill is a
**one-time** run; only the rolling 5-minute and recent-API windows need recurring
fetches, which keeps the automation surface small.

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

End to end from clean: `dbx bundle validate` → `dbx bundle deploy` →
`python ingestion/fetch_bucket.py facilities stats` → `dbx fs cp` → trigger the pipeline →
confirm row counts at all three layers → the gold marts should answer "what was the
renewable share in SA1 in 2010 versus 2025?" correctly, which the API-only design could
not have answered at all.
