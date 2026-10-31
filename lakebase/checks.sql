-- Lakebase demo 1 checks. Two halves, run in two different places:
--
--   [WAREHOUSE]  paste into the SQL editor / a notebook on the SQL warehouse (Unity Catalog).
--   [POSTGRES]   paste into the Lakebase SQL editor (project -> branch `production` -> SQL
--                Editor), or run through any Postgres client against the endpoint.
--
-- Run order: A (before deploying) -> deploy -> B (counts, both sides) -> C (lookups).
-- See lakebase/README.md. Replace 'ABC' below with a facility_code that exists
-- (the first row of the query in C0 will give you one).


-- ===========================================================================
-- A. [WAREHOUSE] Pre-check: primary-key quality. Run BEFORE `bundle deploy`.
--    Synced-table primary keys become NOT NULL in Postgres; rows with a NULL key are
--    silently dropped and duplicate keys fail the sync. A1 must return ZERO rows, and A2
--    must show no duplicates. Known and accepted (2026-10-31): A2 returns 392 rows with a
--    NULL facility_code (an unattributed per-date bucket from the left join), which the
--    sync will drop. Anything else: stop; the fix is in the gold mart (or a
--    `timeseries_key`), not here.
-- ===========================================================================

-- A1. dim_facility, key (facility_code)
SELECT facility_code, count(*) AS n
FROM openelec.gold.dim_facility
GROUP BY facility_code
HAVING count(*) > 1 OR facility_code IS NULL;

-- A2. facility_capacity_factor, key (facility_code, nem_date). This mart comes from a left
--     join grouped by name and region (gold.py), so a facility_code could repeat or be NULL.
SELECT facility_code, nem_date, count(*) AS n
FROM openelec.gold.facility_capacity_factor
GROUP BY facility_code, nem_date
HAVING count(*) > 1 OR facility_code IS NULL OR nem_date IS NULL;


-- ===========================================================================
-- B. Row counts. Compare the two sides: they must match, minus the NULL-key rows
--    reported in B1. Expect dim_facility 0 dropped; facility_capacity_factor 392 fewer
--    rows in Postgres (116,695 vs 117,087 as of 2026-10-31 data; drifts as data grows,
--    so the rule is source count minus B1's null_key_rows).
-- ===========================================================================

-- B1. [WAREHOUSE] source counts, plus how many rows have a NULL key column
SELECT 'dim_facility' AS tbl, count(*) AS n, count_if(facility_code IS NULL) AS null_key_rows
FROM openelec.gold.dim_facility
UNION ALL
SELECT 'facility_capacity_factor', count(*),
       count_if(facility_code IS NULL OR nem_date IS NULL)
FROM openelec.gold.facility_capacity_factor;

-- B2. [POSTGRES] synced-copy counts. UC `openelec.serving.x` is Postgres `serving.x`.
SELECT 'dim_facility' AS tbl, count(*) AS n FROM serving.dim_facility
UNION ALL
SELECT 'facility_capacity_factor', count(*) FROM serving.facility_capacity_factor;

-- B3. [POSTGRES] column types the sync chose. Expect fueltech_groups -> jsonb (from
--     ARRAY<STRING>), nem_date -> date, DOUBLE -> double precision, BIGINT -> bigint.
SELECT table_name, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'serving'
ORDER BY table_name, ordinal_position;


-- ===========================================================================
-- C. [POSTGRES] Demo lookups -- what the synced tables are for.
-- ===========================================================================

-- C0. Pick a facility: the three biggest by registered capacity.
SELECT facility_code, facility_name, network_region, primary_fueltech_group,
       capacity_registered_mw
FROM serving.dim_facility
ORDER BY capacity_registered_mw DESC NULLS LAST
LIMIT 3;

-- C1. Point lookup by primary key.
SELECT *
FROM serving.dim_facility
WHERE facility_code = 'ABC';

-- C2. Latest 7 days for one facility (composite primary key: facility_code, nem_date).
SELECT nem_date, energy_mwh, capacity_factor
FROM serving.facility_capacity_factor
WHERE facility_code = 'ABC'
ORDER BY nem_date DESC
LIMIT 7;

-- C3. jsonb array-contains: facilities that include a battery. The `?` operator
--     tests whether a string is a top-level element of the jsonb array
--     (fueltech_groups was ARRAY<STRING> in Unity Catalog). Some Postgres clients treat `?`
--     as a parameter placeholder; use `jsonb_exists(fueltech_groups, 'battery_discharging')`
--     there.
SELECT facility_code, facility_name, fueltech_groups
FROM serving.dim_facility
WHERE fueltech_groups ? 'battery_discharging'
ORDER BY facility_name
LIMIT 20;

-- C4. The lookups use the primary-key index (expect "Index Scan using ..._pkey" /
--     "Index Cond: (facility_code = ...)" -- not a Seq Scan). Tiny tables can still
--     pick a Seq Scan, so this is informational rather than a pass/fail.
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM serving.dim_facility WHERE facility_code = 'ABC';

EXPLAIN (ANALYZE, BUFFERS)
SELECT nem_date, energy_mwh, capacity_factor
FROM serving.facility_capacity_factor
WHERE facility_code = 'ABC'
ORDER BY nem_date DESC
LIMIT 7;
