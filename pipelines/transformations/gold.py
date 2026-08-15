from pyspark import pipelines as dp
from pyspark.sql import functions as F

# Two source families, matching the two grains established in silver:
#   - deep history (1999-present): generation_daily_by_fueltech (bucket)
#   - recent detail (~370 days): facility_generation (API), joined to dim_unit
#
# Each family gets a private pivoted helper (metric rows -> wide columns) so
# the public marts below don't repeat the same explode/pivot logic.


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
        "Daily generation by NEM region and fueltech group, 1999-present. The headline "
        "generation-mix mart -- 28 years makes the fuel transition visible, not a toy."
    ),
)
def generation_mix_daily():
    wide = spark.read.table("_generation_daily_wide")
    return wide.groupBy("nem_date", "network_region", "fueltech_group").agg(
        F.sum("generated_mwh").alias("generated_mwh")
    )


@dp.materialized_view(
    name="openelec.gold.renewable_share_daily",
    comment="Renewable vs total generation share by NEM region and day, 1999-present.",
)
def renewable_share_daily():
    wide = spark.read.table("_generation_daily_wide")
    by_day = wide.groupBy("nem_date", "network_region").agg(
        F.sum(F.when(F.col("is_renewable"), F.col("generated_mwh"))).alias("renewable_mwh"),
        F.sum("generated_mwh").alias("total_mwh"),
    )
    return by_day.withColumn(
        "renewable_share", F.col("renewable_mwh") / F.col("total_mwh")
    )


@dp.materialized_view(
    name="openelec.gold.emissions_intensity_daily",
    comment=(
        "Grid emissions intensity (tCO2e/MWh) by NEM region and day, 1999-present. "
        "Computed as sum(emissions)/sum(energy) across all fueltechs per region-day -- "
        "aggregate-then-divide, not an average of per-fueltech ratios."
    ),
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
        F.col("emissions").alias("emissions_tco2"),
        F.col("market_value").alias("market_value_aud"),
    )


@dp.materialized_view(
    name="openelec.gold.facility_daily",
    comment="Per-facility daily energy, emissions, and market value. Trailing ~370 days (API window).",
)
def facility_daily():
    return spark.read.table("_facility_daily_wide")


@dp.materialized_view(
    name="openelec.gold.facility_capacity_factor",
    comment=(
        "Daily capacity factor per facility: energy generated vs registered capacity. "
        "capacity_factor = energy_mwh / (capacity_registered_mw * 24h). Trailing ~370 days."
    ),
)
def facility_capacity_factor():
    daily = spark.read.table("_facility_daily_wide")
    dim = spark.read.table("openelec.silver.dim_unit")
    facility_capacity = dim.groupBy("facility_code").agg(
        F.sum("capacity_registered_mw").alias("capacity_registered_mw")
    )
    joined = daily.join(facility_capacity, "facility_code", "left")
    return joined.select(
        "facility_code",
        "facility_name",
        "network_region",
        "nem_date",
        "energy_mwh",
        "capacity_registered_mw",
        (F.col("energy_mwh") / (F.col("capacity_registered_mw") * 24)).alias("capacity_factor"),
    )
