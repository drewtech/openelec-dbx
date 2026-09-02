# openelec-dbx

A personal learning project uplifting Databricks skills — particularly AI/BI (Genie +
AI/BI Dashboards) — by building a real medallion pipeline on **Databricks Free Edition**
against the Australian electricity market API, [OpenElectricity](https://docs.openelectricity.org.au/)
(formerly OpenNEM).

Not a production system — the goal is to exercise as much current Databricks surface
area as a free, serverless-only workspace allows: Lakeflow Declarative Pipelines,
Declarative Automation Bundles (DABs), Unity Catalog, AI/BI Dashboards, and Genie.

## Architecture

```
OpenElectricity API/bucket → bronze (raw JSON, UC Volume) → silver (typed, deduped)
  → gold (generation mix, renewable share, emissions marts) → AI/BI Dashboard + Genie
```

Ingestion runs locally rather than in-workspace, since Free Edition serverless compute
has no outbound internet access to arbitrary hosts. See [SPEC.md](SPEC.md) for the full
reasoning and the phased build plan.

## Status

This repo is under active, phased build-out. See [SPEC.md](SPEC.md) for the detailed
spec, phase-by-phase progress checklist, and design decisions with rationale.

## Docs

- [DEMO.md](DEMO.md) — 20-minute demo runbook: pipeline, Genie chat vs agent mode, the
  four UI options with pros/cons
- [CLAUDE.md](CLAUDE.md) — project conventions, Free Edition constraints, data source
  notes, auth/tooling setup
- [SPEC.md](SPEC.md) — pipeline spec and progress tracker (source of truth for what's
  done)

## Requirements

- A [Databricks Free Edition](https://www.databricks.com/learn/free-edition) account
- An [OpenElectricity API key](https://platform.openelectricity.org.au/) (only needed
  for the incremental/recent-data path — historical backfill uses an unauthenticated
  bulk source)
- Databricks CLI ≥ 1.3.0, authenticated via a Personal Access Token (OAuth isn't
  supported on Free Edition)
