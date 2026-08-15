# openelec-dbx

## Purpose

Personal learning project to uplift Databricks knowledge, with a focus on **AI/BI**
(Genie + AI/BI Dashboards). Running on **Databricks Free Edition** under a personal
account. Data source is the Australian electricity market API formerly known as
OpenNEM, now **OpenElectricity**.

This is a learning sandbox, not production — optimize for "touches the most current
Databricks surface area" over "most robust pipeline."

## Data source: OpenElectricity

- Rebranded from OpenNEM. Docs: https://docs.openelectricity.org.au/ · API key
  signup: https://platform.openelectricity.org.au/
- Auth via API key, read from env var `OPENELECTRICITY_API_KEY` — never hardcode
  or commit it.
- Official Python client: `openelectricity` (PyPI).
- Coverage: generation, power, energy, renewables share, price, demand,
  curtailment, capacity, emissions, fuel technologies, facilities, batteries,
  rooftop solar, weather, interconnectors. NEM (QLD/NSW/VIC/SA/TAS/ACT) + WEM (WA).
- **Still in beta** — no published rate-limit/free-tier numbers as of last check.
  Cache raw API responses (bronze layer) rather than re-fetching on every run;
  don't build anything that polls it in a tight loop.

## Target architecture

Medallion pipeline, built to exercise current Databricks primitives end to end:

1. **Bronze** — ingest raw OpenElectricity API responses (JSON) into a Volume +
   append-only Delta table. Minimal transformation.
2. **Silver** — typed, cleaned, deduped tables: generation by facility/interval,
   price/demand by region/interval.
3. **Gold** — aggregated marts: daily generation mix by fuel type & region,
   renewables share over time, price vs. demand.
4. **Lakeflow Declarative Pipeline** (DLT) for bronze→silver→gold, rather than a
   plain notebook — the point is to learn the current idiomatic pipeline pattern.
5. **AI/BI Dashboard** on the gold tables (generation mix trend, price/demand,
   regional comparison).
6. **Genie space** over the gold schema for natural-language Q&A — this is the
   main "AI/BI" payoff of the project.
7. **Job** to schedule periodic refresh of the pipeline.

## Databricks Free Edition constraints

Serverless-only; design everything to fit inside these caps rather than treat them
as edge cases:

- One SQL warehouse, capped at 2X-Small.
- One active Lakeflow Declarative Pipeline per pipeline type.
- Max 5 concurrent job tasks per account.
- No custom/classic compute clusters.
- Exceeding the fair-usage quota shuts the workspace down for the rest of the day
  (sometimes the month) — avoid heavy backfills or unattended loops.

## Repo conventions

- `ingestion/` — API-pull scripts/notebooks (OpenElectricity → bronze).
- `pipelines/` — Lakeflow Declarative Pipeline definitions (silver/gold).
- `dashboards/` — AI/BI dashboard + Genie space definitions/exports.
- Secrets (API keys, workspace tokens) via env vars or Databricks secret scopes
  only — never committed. Add a `.env.example` alongside any script that needs one.
- Databricks CLI auth: PAT only — OAuth login isn't supported on Free Edition.
  Token lives in 1Password (vault `Dev`, item `Databricks Pipeline Deploy`).
  Use `dbx` (shell alias for `databricks` with the 1Password env-file lookup
  already wired in — set up outside this repo, at a generic location shared
  across projects) instead of calling `databricks` directly; no per-command
  `op run` prefix needed here.
  If `dbx` fails to resolve the token (locked 1Password session), run any `op`
  command first (e.g. `op vault list`) to trigger the Windows Hello unlock
  challenge via the desktop app integration, then retry.

## Status

Detailed spec, phase breakdown, and progress tracking live in [SPEC.md](SPEC.md) —
that file is the source of truth for what's done and what's next, not this section.
