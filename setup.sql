-- One-time catalog/schema/volume DDL for openelec-dbx.
--
-- Deliberately NOT bundle-managed: Free Edition has one workspace and no
-- dev/prod split, so `mode: development` name-prefixing on schema resources
-- is pure friction for one-time setup. The bundle owns the pipeline and job
-- (resources/*.yml) — the things that actually change.
--
-- Run once via a SQL warehouse (e.g. `dbx bundle run` doesn't apply here;
-- paste into a notebook/SQL editor cell, or `dbx api ... ` a statement
-- execution, whichever is easiest at the time).

CREATE CATALOG IF NOT EXISTS openelec
  COMMENT 'OpenElectricity NEM generation data — bronze/silver/gold medallion layers.';

CREATE SCHEMA IF NOT EXISTS openelec.bronze
  COMMENT 'Raw OpenElectricity API/bucket responses, minimally transformed.';

CREATE SCHEMA IF NOT EXISTS openelec.silver
  COMMENT 'Typed, deduped facility/unit dimension and generation fact tables.';

CREATE SCHEMA IF NOT EXISTS openelec.gold
  COMMENT 'Aggregated marts: generation mix, renewable share, emissions intensity.';

CREATE VOLUME IF NOT EXISTS openelec.bronze.raw
  COMMENT 'Landing zone for verbatim ingestion JSON before Auto Loader picks it up.';
