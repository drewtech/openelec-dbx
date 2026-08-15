from pyspark import pipelines as dp
from pyspark.sql import functions as F

VOLUME_ROOT = "/Volumes/openelec/bronze/raw"


@dp.table(
    name="facilities_raw",
    comment="Verbatim OpenElectricity facility registry snapshots from the static bucket.",
)
def facilities_raw():
    return (
        spark.readStream.format("cloudFiles")
        .option("cloudFiles.format", "text")
        .option("wholeText", "true")
        .load(f"{VOLUME_ROOT}/facilities")
        .select(
            F.col("value").alias("raw_json"),
            F.col("_metadata.file_path").alias("source_file"),
            F.col("_metadata.file_modification_time").alias("ingested_at"),
        )
    )


@dp.table(
    name="stats_energy_raw",
    comment="Verbatim OpenElectricity static-bucket daily energy-by-fueltech responses.",
)
def stats_energy_raw():
    return (
        spark.readStream.format("cloudFiles")
        .option("cloudFiles.format", "text")
        .option("wholeText", "true")
        .load(f"{VOLUME_ROOT}/stats")
        .select(
            F.col("value").alias("raw_json"),
            F.col("_metadata.file_path").alias("source_file"),
            F.col("_metadata.file_modification_time").alias("ingested_at"),
        )
    )


@dp.table(
    name="facility_data_raw",
    comment="Verbatim OpenElectricity API responses: per-unit power/energy/emissions/market_value.",
)
def facility_data_raw():
    return (
        spark.readStream.format("cloudFiles")
        .option("cloudFiles.format", "text")
        .option("wholeText", "true")
        .load(f"{VOLUME_ROOT}/facility_data")
        .select(
            F.col("value").alias("raw_json"),
            F.col("_metadata.file_path").alias("source_file"),
            F.col("_metadata.file_modification_time").alias("ingested_at"),
        )
    )
