from pyspark import pipelines as dp
from pyspark.sql import functions as F
from pyspark.sql.window import Window

from utils.fueltech import RENEWABLE_GROUPS

# Two source families, matching the two grains established in silver:
#   - deep history (1999-present): generation_daily_by_fueltech (bucket)
#   - recent detail (~370 days): facility_generation (API), joined to dim_unit
# Plus a facility-grain dimension (dim_facility) rolled up from dim_unit, with
# no time series of its own -- the latest registry snapshot.
#
# Each daily family gets a private pivoted helper (metric rows -> wide columns)
# so the public marts below don't repeat the same explode/pivot logic.
#
# Column comments (schema= below) are load-bearing for Genie (Phase 6) -- see
# docs/genie-spec.md G1. Every public mart states its coverage window, unit,
# and NULL semantics explicitly so a natural-language agent does not have to
# guess.
#
# Checked empirically against this warehouse (a Lakeflow Pipelines skill
# reference doc claims SUM over an all-NULL group returns 0, not NULL -- that
# does NOT hold here: a direct SELECT SUM(CAST(NULL AS DOUBLE)) and every
# fully-decommissioned facility's capacity_registered_mw_operating both come
# back NULL, matching plain Spark SQL semantics). So "NULL means no data,
# never coalesce" holds without exception in these marts -- no caveat needed.


@dp.materialized_view(
    name="_generation_daily_wide",
    private=True,
    comment=(
        "Pivoted generation_daily_by_fueltech: one row per (nem_date, network_region, "
        "fueltech_id), energy/emissions/market_value as columns instead of long-format "
        "rows. Energy converted GWh -> MWh for unit consistency with the API-sourced marts."
    ),
)
def _generation_daily_wide():
    src = spark.read.table("openelec.silver.generation_daily_by_fueltech")
    pivoted = (
        src.groupBy("nem_date", "network_region", "fueltech_id", "fueltech_group", "is_renewable")
        .pivot("metric", ["energy", "emissions", "market_value"])
        .agg(F.sum("generated"))
    )
    return pivoted.select(
        "nem_date",
        "network_region",
        "fueltech_id",
        "fueltech_group",
        "is_renewable",
        (F.col("energy") * 1000).alias("generated_mwh"),
        F.col("emissions").alias("emissions_tco2e"),
        F.col("market_value").alias("market_value_aud"),
    )


@dp.materialized_view(
    name="openelec.gold.generation_mix_daily",
    comment=(
        "Daily generation by NEM region and fueltech group, 1998-12-31 to present. The "
        "headline generation-mix mart -- 28 years makes the fuel transition visible, not "
        "a toy."
    ),
    schema="""
        nem_date DATE COMMENT 'NEM local calendar date, fixed UTC+10, no DST. Derived as date_add(history_start, pos) against the bucket series -- a positional index, not a timestamp conversion. Deep-history coverage: 1998-12-31 to present.',
        network_region STRING COMMENT 'NEM region code: NSW1, QLD1, SA1, TAS1, VIC1. No ACT (folded into NSW1) and no WA -- this project is NEM only.',
        fueltech_group STRING COMMENT 'One of coal, gas, solar, wind, hydro, bioenergy, distillate, pumps, battery_charging, battery_discharging. Renewable = solar, wind, hydro, bioenergy only -- pumps and battery are excluded from renewable share.',
        generated_mwh DOUBLE COMMENT 'Energy generated, MWh, converted from the source GWh. NULL means no data reported for that region/fueltech/day, never a measured zero -- do not coalesce.'
    """,
)
def generation_mix_daily():
    wide = spark.read.table("_generation_daily_wide")
    return wide.groupBy("nem_date", "network_region", "fueltech_group").agg(
        F.sum("generated_mwh").alias("generated_mwh")
    )


@dp.materialized_view(
    name="openelec.gold.renewable_share_daily",
    comment="Renewable vs total generation share by NEM region and day, 1998-12-31 to present.",
    schema="""
        nem_date DATE COMMENT 'NEM local calendar date, fixed UTC+10, no DST. Deep-history coverage: 1998-12-31 to present.',
        network_region STRING COMMENT 'NEM region code: NSW1, QLD1, SA1, TAS1, VIC1. No ACT (folded into NSW1) and no WA.',
        renewable_mwh DOUBLE COMMENT 'Sum of generated_mwh across solar, wind, hydro, bioenergy for the region-day. Coalesced to 0 when the region-day has generation rows but none are renewable -- the one deliberate exception to this project NULL-means-no-data rule, because a region-day already known to have data genuinely has zero renewable generation in that case, not unknown renewable generation.',
        total_mwh DOUBLE COMMENT 'Sum of generated_mwh across all fueltech groups for the region-day, MWh. NULL only if every underlying row is null.',
        renewable_share DOUBLE COMMENT 'renewable_mwh / total_mwh. NULL when total_mwh is NULL or 0 -- never computed as a 0/0 or divide-by-null artifact.'
    """,
)
def renewable_share_daily():
    wide = spark.read.table("_generation_daily_wide")
    by_day = wide.groupBy("nem_date", "network_region").agg(
        F.coalesce(
            F.sum(F.when(F.col("is_renewable"), F.col("generated_mwh"))), F.lit(0.0)
        ).alias("renewable_mwh"),
        F.sum("generated_mwh").alias("total_mwh"),
    )
    return by_day.withColumn(
        "renewable_share",
        F.when(
            F.col("total_mwh").isNull() | (F.col("total_mwh") == 0), F.lit(None)
        ).otherwise(F.col("renewable_mwh") / F.col("total_mwh")),
    )


@dp.materialized_view(
    name="openelec.gold.emissions_intensity_daily",
    comment=(
        "Grid emissions intensity (tCO2e/MWh) by NEM region and day, 1998-12-31 to "
        "present. Computed as sum(emissions)/sum(energy) across all fueltechs per "
        "region-day -- aggregate-then-divide, not an average of per-fueltech ratios."
    ),
    schema="""
        nem_date DATE COMMENT 'NEM local calendar date, fixed UTC+10, no DST. Deep-history coverage: 1998-12-31 to present.',
        network_region STRING COMMENT 'NEM region code: NSW1, QLD1, SA1, TAS1, VIC1. No ACT (folded into NSW1) and no WA.',
        emissions_tco2e DOUBLE COMMENT 'Total tonnes CO2-equivalent across all fueltechs for the region-day. NULL means no data, never a measured zero -- do not coalesce.',
        generated_mwh DOUBLE COMMENT 'Total energy generated across all fueltechs for the region-day, MWh.',
        emissions_intensity_tco2e_per_mwh DOUBLE COMMENT 'emissions_tco2e / generated_mwh, aggregate-then-divide. Lower is cleaner. Not an average of per-fueltech intensities.'
    """,
)
def emissions_intensity_daily():
    wide = spark.read.table("_generation_daily_wide")
    by_day = wide.groupBy("nem_date", "network_region").agg(
        F.sum("emissions_tco2e").alias("emissions_tco2e"),
        F.sum("generated_mwh").alias("generated_mwh"),
    )
    return by_day.withColumn(
        "emissions_intensity_tco2e_per_mwh", F.col("emissions_tco2e") / F.col("generated_mwh")
    )


# --- recent detail (API-sourced, ~370 days), facility grain ----------------


@dp.materialized_view(
    name="_facility_daily_wide",
    private=True,
    comment=(
        "Pivoted facility_generation (interval='1d' only -- the table also carries a 5m "
        "window over the trailing 7 days, which would double-count if included here), "
        "joined to dim_unit for facility identity. One row per (facility, nem_date)."
    ),
)
def _facility_daily_wide():
    fg = spark.read.table("openelec.silver.facility_generation").filter(F.col("interval") == "1d")
    dim = spark.read.table("openelec.silver.dim_unit")
    joined = fg.join(dim, "unit_code", "left").withColumn(
        # NEM is fixed UTC+10, no DST -- from_utc_timestamp gives the correct
        # local wall-clock date to bucket by.
        "nem_date",
        F.to_date(F.from_utc_timestamp(F.col("interval_ts_utc"), "Etc/GMT-10")),
    )
    pivoted = (
        joined.groupBy("facility_code", "facility_name", "network_region", "nem_date")
        .pivot("metric", ["energy", "emissions", "market_value"])
        .agg(F.sum("value"))
    )
    return pivoted.select(
        "facility_code",
        "facility_name",
        "network_region",
        "nem_date",
        F.col("energy").alias("energy_mwh"),
        F.col("emissions").alias("emissions_tco2e"),
        F.col("market_value").alias("market_value_aud"),
    )


@dp.materialized_view(
    name="openelec.gold.facility_daily",
    comment="Per-facility daily energy, emissions, and market value. Trailing ~370 days (API window).",
    schema="""
        facility_code STRING COMMENT 'Facility identifier. Join to dim_facility or dim_unit for name/region/fueltech context.',
        facility_name STRING COMMENT 'Human-readable facility name.',
        network_region STRING COMMENT 'NEM region code: NSW1, QLD1, SA1, TAS1, VIC1.',
        nem_date DATE COMMENT 'NEM local calendar date, fixed UTC+10, no DST. Derived as to_date(from_utc_timestamp(interval_ts_utc, Etc/GMT-10)) -- a different derivation path than the bucket-sourced region marts (generation_mix_daily etc use a positional day offset instead), same column name and semantics. Coverage: trailing ~370 days only (the API window), not the deep history the region marts have -- do not assume this mart spans the same period as generation_mix_daily.',
        energy_mwh DOUBLE COMMENT 'Energy generated, MWh. NULL means no data reported, never a measured zero -- do not coalesce. Negative values are legitimate (battery charging, net load).',
        emissions_tco2e DOUBLE COMMENT 'Tonnes CO2-equivalent for the facility-day. NULL means no data, never a measured zero.',
        market_value_aud DOUBLE COMMENT 'Revenue in AUD, not a price -- this project has no price or demand data (region-level demand lives in silver.demand_daily, not yet promoted to gold).'
    """,
)
def facility_daily():
    return spark.read.table("_facility_daily_wide")


@dp.materialized_view(
    name="openelec.gold.facility_capacity_factor",
    comment=(
        "Daily capacity factor per facility: energy generated vs registered capacity. "
        "Trailing ~370 days. Two denominators exposed -- see column comments -- because "
        "dim_unit carries operating, committed, and retired units together; the default "
        "capacity_factor uses operating capacity only."
    ),
    schema="""
        facility_code STRING COMMENT 'Facility identifier. Join to dim_facility for name/region/fueltech context.',
        facility_name STRING COMMENT 'Human-readable facility name.',
        network_region STRING COMMENT 'NEM region code: NSW1, QLD1, SA1, TAS1, VIC1.',
        nem_date DATE COMMENT 'NEM local calendar date, fixed UTC+10, no DST. Same ~370-day API-window coverage as facility_daily, not the deep history the region marts have.',
        energy_mwh DOUBLE COMMENT 'Energy generated, MWh. NULL means no data, never a measured zero.',
        capacity_registered_mw DOUBLE COMMENT 'Registered capacity, MW, summed across all units at the facility regardless of status (operating, committed, or retired).',
        capacity_registered_mw_operating DOUBLE COMMENT 'Registered capacity, MW, summed across only units with status_id = operating. Excludes committed (not yet built) and retired units.',
        capacity_factor DOUBLE COMMENT 'energy_mwh / (capacity_registered_mw_operating * 24h). The recommended, default capacity factor -- dividing by all-status capacity understates historical utilisation because it counts capacity that was not actually generating.',
        capacity_factor_all_units DOUBLE COMMENT 'energy_mwh / (capacity_registered_mw * 24h), using all-status capacity. Kept for comparison against capacity_factor; not the recommended measure.'
    """,
)
def facility_capacity_factor():
    daily = spark.read.table("_facility_daily_wide")
    dim = spark.read.table("openelec.silver.dim_unit")
    facility_capacity = dim.groupBy("facility_code").agg(
        F.sum("capacity_registered_mw").alias("capacity_registered_mw"),
        F.sum(
            F.when(F.col("status_id") == "operating", F.col("capacity_registered_mw"))
        ).alias("capacity_registered_mw_operating"),
    )
    joined = daily.join(facility_capacity, "facility_code", "left")
    return joined.select(
        "facility_code",
        "facility_name",
        "network_region",
        "nem_date",
        "energy_mwh",
        "capacity_registered_mw",
        "capacity_registered_mw_operating",
        (F.col("energy_mwh") / (F.col("capacity_registered_mw_operating") * 24)).alias(
            "capacity_factor"
        ),
        (F.col("energy_mwh") / (F.col("capacity_registered_mw") * 24)).alias(
            "capacity_factor_all_units"
        ),
    )


# --- dim_facility: facility-grain rollup of dim_unit, latest snapshot ------


@dp.materialized_view(
    name="openelec.gold.dim_facility",
    comment=(
        "Facility dimension rolled up from silver.dim_unit (unit grain) -- the latest "
        "registry snapshot, not a time series, so there is no nem_date here. Fills the "
        "gap that no other gold mart lets you slice by facility fueltech: dim_unit is "
        "silver-only, and the daily marts above carry facility_code/network_region but "
        "not a clean primary-fueltech label. Join on facility_code."
    ),
    schema="""
        facility_code STRING COMMENT 'Facility identifier. Join key for facility_daily and facility_capacity_factor.',
        facility_name STRING COMMENT 'Human-readable facility name.',
        network_region STRING COMMENT 'NEM region code: NSW1, QLD1, SA1, TAS1, VIC1.',
        primary_fueltech_group STRING COMMENT 'The fueltech group holding the most registered capacity at this facility (ties broken alphabetically), among mapped groups only -- unmapped fueltechs (nuclear, imports, exports, interconnector, aggregator_vpp, aggregator_dr) are never chosen as primary. NULL only if the facility has no units with a mapped fueltech group at all.',
        fueltech_groups ARRAY<STRING> COMMENT 'Sorted distinct fueltech groups across all units at the facility -- a facility can mix technologies, e.g. solar plus battery storage.',
        is_renewable BOOLEAN COMMENT 'True if primary_fueltech_group is one of solar, wind, hydro, bioenergy. A mixed facility (e.g. solar + battery) is classified by its primary technology, not by whether it has any renewable capacity at all -- check fueltech_groups directly for that.',
        unit_count BIGINT COMMENT 'Count of distinct units at the facility, any status (operating, committed, or retired).',
        capacity_registered_mw DOUBLE COMMENT 'Registered capacity, MW, summed across all units regardless of status.',
        capacity_registered_mw_operating DOUBLE COMMENT 'Registered capacity, MW, summed across only units with status_id = operating.',
        lat DOUBLE COMMENT 'Facility latitude.',
        lng DOUBLE COMMENT 'Facility longitude.'
    """,
)
def dim_facility():
    dim = spark.read.table("openelec.silver.dim_unit")

    mapped = dim.filter(F.col("fueltech_group").isNotNull())
    group_capacity = mapped.groupBy("facility_code", "fueltech_group").agg(
        F.sum("capacity_registered_mw").alias("group_capacity_mw")
    )
    rank_window = Window.partitionBy("facility_code").orderBy(
        F.col("group_capacity_mw").desc(), F.col("fueltech_group").asc()
    )
    primary = (
        group_capacity.withColumn("rn", F.row_number().over(rank_window))
        .filter(F.col("rn") == 1)
        .select("facility_code", F.col("fueltech_group").alias("primary_fueltech_group"))
    )

    agg = dim.groupBy("facility_code", "facility_name", "network_region").agg(
        F.sort_array(F.collect_set("fueltech_group")).alias("fueltech_groups"),
        F.countDistinct("unit_code").alias("unit_count"),
        F.sum("capacity_registered_mw").alias("capacity_registered_mw"),
        F.sum(
            F.when(F.col("status_id") == "operating", F.col("capacity_registered_mw"))
        ).alias("capacity_registered_mw_operating"),
        F.first("lat", ignorenulls=True).alias("lat"),
        F.first("lng", ignorenulls=True).alias("lng"),
    )

    joined = agg.join(primary, "facility_code", "left")
    return joined.select(
        "facility_code",
        "facility_name",
        "network_region",
        "primary_fueltech_group",
        "fueltech_groups",
        F.col("primary_fueltech_group").isin(*RENEWABLE_GROUPS).alias("is_renewable"),
        "unit_count",
        "capacity_registered_mw",
        "capacity_registered_mw_operating",
        "lat",
        "lng",
    )
