from pyspark import pipelines as dp
from pyspark.sql import functions as F

from utils.fueltech import fueltech_group_expr, is_renewable_expr
from utils.schemas import FACILITIES_SCHEMA, FACILITY_DATA_SCHEMA, STATS_SCHEMA

# Silver publishes outside the pipeline's default `bronze` schema, so every
# dataset here uses a fully-qualified name (see resources/pipeline.yml).


@dp.materialized_view(
    name="openelec.silver.dim_unit",
    comment=(
        "Generation/load unit dimension: fueltech, capacity, emissions factor, status. "
        "Sourced from the OpenElectricity facility registry (bucket), keyed at unit "
        "grain since a facility can mix fueltechs (e.g. solar + BESS)."
    ),
)
@dp.expect_or_drop("valid_unit_code", "unit_code IS NOT NULL")
def dim_unit():
    latest_snapshot = spark.read.table("facilities_raw").orderBy(F.col("ingested_at").desc()).limit(1)
    facilities = latest_snapshot.select(
        F.explode(F.from_json("raw_json", FACILITIES_SCHEMA)["data"]).alias("facility")
    ).filter(F.col("facility.network_id") == "NEM")  # bucket registry covers NEM + WEM; project scope is NEM only
    units = facilities.select(
        F.col("facility.code").alias("facility_code"),
        F.col("facility.name").alias("facility_name"),
        F.col("facility.network_id").alias("network_id"),
        F.col("facility.network_region").alias("network_region"),
        F.col("facility.location.lat").alias("lat"),
        F.col("facility.location.lng").alias("lng"),
        F.explode("facility.units").alias("unit"),
    )
    return units.select(
        F.col("unit.code").alias("unit_code"),
        "facility_code",
        "facility_name",
        "network_id",
        "network_region",
        "lat",
        "lng",
        F.col("unit.fueltech_id").alias("fueltech_id"),
        fueltech_group_expr(F.col("unit.fueltech_id")).alias("fueltech_group"),
        is_renewable_expr(F.col("unit.fueltech_id")).alias("is_renewable"),
        F.col("unit.status_id").alias("status_id"),
        F.col("unit.dispatch_type").alias("dispatch_type"),
        F.col("unit.capacity_registered").alias("capacity_registered_mw"),
        F.col("unit.capacity_maximum").alias("capacity_maximum_mw"),
        F.col("unit.emissions_factor_co2").alias("emissions_factor_co2"),
    )


@dp.materialized_view(
    name="openelec.silver.generation_daily_by_fueltech",
    comment=(
        "Daily energy by NEM region and fueltech, 1999-present. Sourced from the "
        "OpenElectricity static bucket -- already at fueltech grain, no join needed."
    ),
)
@dp.expect_or_drop(
    "valid_key", "nem_date IS NOT NULL AND network_region IS NOT NULL AND fueltech_id IS NOT NULL"
)
def generation_daily_by_fueltech():
    series = spark.read.table("stats_energy_raw").select(
        F.explode(F.from_json("raw_json", STATS_SCHEMA)["data"]).alias("series")
    )
    points = series.select(
        F.col("series.type").alias("metric"),
        F.col("series.fuel_tech").alias("fueltech_id"),
        F.col("series.region").alias("network_region"),
        F.col("series.units").alias("uom"),
        F.to_date(F.col("series.history.start")).alias("history_start"),
        F.posexplode("series.history.data").alias("pos", "generated"),
    )
    return points.select(
        F.date_add(F.col("history_start"), F.col("pos")).alias("nem_date"),
        "network_region",
        "fueltech_id",
        fueltech_group_expr(F.col("fueltech_id")).alias("fueltech_group"),
        is_renewable_expr(F.col("fueltech_id")).alias("is_renewable"),
        "metric",
        "generated",  # null = no data reported; 0 = measured zero. Never coalesced.
        "uom",
    )


# --- facility_generation: streaming, CDC-deduped on (unit_code, ts, metric) -

# Pre-processing lives in a temporary view, not a private streaming table --
# create_auto_cdc_flow's `source` must be a table/view name, and the skill
# guidance is explicit: don't materialize a streaming table just to feed a
# CDC flow, a temp view is the documented pattern.
@dp.temporary_view()
def _facility_generation_points():
    parsed = spark.readStream.table("facility_data_raw").select(
        "ingested_at",
        F.explode(F.from_json("raw_json", FACILITY_DATA_SCHEMA)["data"]).alias("block"),
    )
    per_unit = parsed.select(
        "ingested_at",
        F.col("block.metric").alias("metric"),
        F.col("block.unit").alias("uom"),
        F.explode("block.results").alias("result"),
    )
    per_point = per_unit.select(
        "ingested_at",
        "metric",
        "uom",
        F.col("result.columns.unit_code").alias("unit_code"),
        F.explode("result.data").alias("pair"),
    )
    return per_point.select(
        "unit_code",
        F.col("pair")[0].cast("timestamp").alias("interval_ts_utc"),
        "metric",
        F.col("pair")[1].cast("double").alias("value"),  # null = no data, never 0
        "uom",
        "ingested_at",
    )


dp.create_streaming_table(
    name="openelec.silver.facility_generation",
    comment=(
        "Deduped per-unit generation metrics (power/energy/emissions/market_value) at "
        "native API interval, keyed on (unit_code, interval_ts_utc, metric). SCD1: keeps "
        "the latest-fetched value per key, since recent 5-minute energy is trapezoidally "
        "derived and later replaced with metered values on re-fetch."
    ),
    expect_all_or_drop={
        "valid_unit_code": "unit_code IS NOT NULL",
        "valid_ts": "interval_ts_utc IS NOT NULL",
        "valid_metric": "metric IS NOT NULL",
    },
    expect_all={
        # warn-only: negative is legitimate for load/battery-charging units
        "non_negative_value": "value IS NULL OR value >= 0",
    },
)

dp.create_auto_cdc_flow(
    target="openelec.silver.facility_generation",
    source="_facility_generation_points",
    keys=["unit_code", "interval_ts_utc", "metric"],
    sequence_by="ingested_at",
    stored_as_scd_type=1,
)
