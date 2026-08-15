"""Explicit schemas for OpenElectricity bronze JSON payloads.

Both sources are versioned, evolving payloads (see SPEC.md Phase 1 finding
about SDK schema drift) -- centralizing schemas here beats scattering
from_json literals across silver.py, and keeps enum-like fields
(fueltech_id, status_id) as plain STRING so an upstream addition (e.g. the
"commissioning" status added to the live API after this project's
research was written) never crashes parsing the way the openelectricity
SDK's pydantic models do.

Shapes below are confirmed against real landed bronze data, not just
research/docs -- see SPEC.md Phase 1/2 findings for the divergences found.
"""

from pyspark.sql.types import (
    ArrayType,
    BooleanType,
    DoubleType,
    StringType,
    StructField,
    StructType,
)

# --- facilities_raw (bucket: v4/facilities/au_facilities.json) -------------

_UNIT_SCHEMA = StructType(
    [
        StructField("code", StringType()),
        StructField("fueltech_id", StringType()),
        StructField("status_id", StringType()),
        StructField("dispatch_type", StringType()),
        StructField("capacity_registered", DoubleType()),
        StructField("capacity_maximum", DoubleType()),
        StructField("emissions_factor_co2", DoubleType()),
        StructField("commencement_date", StringType()),
        StructField("expected_closure_date", StringType()),
    ]
)

_LOCATION_SCHEMA = StructType(
    [
        StructField("lat", DoubleType()),
        StructField("lng", DoubleType()),
    ]
)

_FACILITY_SCHEMA = StructType(
    [
        StructField("code", StringType()),
        StructField("name", StringType()),
        StructField("network_id", StringType()),
        StructField("network_region", StringType()),
        StructField("location", _LOCATION_SCHEMA),
        StructField("units", ArrayType(_UNIT_SCHEMA)),
    ]
)

FACILITIES_SCHEMA = StructType(
    [
        StructField("success", BooleanType()),
        StructField("data", ArrayType(_FACILITY_SCHEMA)),
    ]
)

# --- stats_energy_raw (bucket: v4/stats/au/NEM/{region}/energy/{year}.json)

_HISTORY_SCHEMA = StructType(
    [
        StructField("start", StringType()),
        StructField("last", StringType()),
        StructField("interval", StringType()),
        # positional; index i -> start + i * interval. Nulls = no data,
        # never coalesce to 0 (see SPEC.md key constraints).
        StructField("data", ArrayType(DoubleType())),
    ]
)

_STATS_SERIES_SCHEMA = StructType(
    [
        StructField("id", StringType()),
        StructField("type", StringType()),  # metric, e.g. "energy"
        StructField("fuel_tech", StringType()),
        StructField("region", StringType()),
        StructField("units", StringType()),  # e.g. "GWh" -- don't assume MWh
        StructField("history", _HISTORY_SCHEMA),
    ]
)

STATS_SCHEMA = StructType(
    [
        StructField("type", StringType()),
        StructField("network", StringType()),
        StructField("region", StringType()),
        StructField("data", ArrayType(_STATS_SERIES_SCHEMA)),
    ]
)

# --- facility_data_raw (API: v4/data/facilities/NEM) ------------------------
# results[].data is an array of positional [timestamp, value] pairs -- kept
# as ARRAY<STRING> (Spark coerces the numeric value to its string form
# during schema-directed JSON parsing) and cast explicitly in silver.py,
# since a heterogeneous tuple has no clean StructType representation.

_COLUMNS_SCHEMA = StructType(
    [
        StructField("unit_code", StringType()),
    ]
)

_RESULT_SCHEMA = StructType(
    [
        StructField("name", StringType()),
        StructField("columns", _COLUMNS_SCHEMA),
        StructField("data", ArrayType(ArrayType(StringType()))),
    ]
)

_METRIC_BLOCK_SCHEMA = StructType(
    [
        StructField("metric", StringType()),
        StructField("unit", StringType()),
        StructField("interval", StringType()),
        StructField("results", ArrayType(_RESULT_SCHEMA)),
    ]
)

FACILITY_DATA_SCHEMA = StructType(
    [
        StructField("success", BooleanType()),
        StructField("data", ArrayType(_METRIC_BLOCK_SCHEMA)),
    ]
)
