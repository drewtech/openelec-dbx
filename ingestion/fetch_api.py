# Databricks notebook source
# Keyed, incremental fetch from the OpenElectricity REST API (per-facility
# generation, unit grain). Runs in-workspace as a scheduled job task (see
# resources/job.yml) -- unlike fetch_bucket.py, this one IS meant to run
# repeatedly. Raw requests, not the openelectricity SDK: the SDK's pydantic
# models lag the live API (see SPEC.md key constraints) and a strict
# validator in the ingest path turns an upstream enum addition into an
# outage. Land verbatim bytes; schema decisions happen in silver.
#
# Facility codes come from the already-landed bronze facilities_raw table
# (populated by fetch_bucket.py) rather than an extra keyed API call --
# same codes, one less request against an unpublished rate limit.

import json
import os
import time
from datetime import datetime, timedelta, timezone

import requests

API_BASE = "https://api.openelectricity.org.au/v4"
VOLUME_ROOT = "/Volumes/openelec/bronze/raw"
METRICS = ["power", "energy", "emissions", "market_value"]
FACILITY_CHUNK = 30  # API hard cap on facility_code params per request
DAILY_LOOKBACK_DAYS = 366  # 1d interval range cap
FIVE_MIN_LOOKBACK_DAYS = 7  # 5m interval range cap is 8 days; 7 leaves margin

API_KEY = dbutils.secrets.get(scope="openelec", key="api_key")
HEADERS = {"Authorization": f"Bearer {API_KEY}", "Accept": "application/json"}

# NEM has no DST -- fixed UTC+10 year-round. date_start/date_end are sent as
# naive local time per the API's documented best practice.
NEM_OFFSET = timedelta(hours=10)
nem_now = (datetime.now(timezone.utc) + NEM_OFFSET).replace(tzinfo=None)


def fetched_at_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H%M%SZ")


def land(partition: str, content: bytes) -> str:
    ts = fetched_at_stamp()
    dir_path = f"{VOLUME_ROOT}/facility_data/{partition}/fetched_at={ts}"
    os.makedirs(dir_path, exist_ok=True)
    path = f"{dir_path}/part-000.json"
    with open(path, "wb") as f:
        f.write(content)
    return path


def get_nem_facility_codes() -> list[str]:
    row = spark.sql(
        "SELECT raw_json FROM openelec.bronze.facilities_raw ORDER BY ingested_at DESC LIMIT 1"
    ).collect()[0]
    facilities = json.loads(row.raw_json)["data"]
    return sorted({f["code"] for f in facilities if f.get("network_id") == "NEM"})


def chunked(seq: list, size: int):
    for i in range(0, len(seq), size):
        yield seq[i : i + size]


def fetch_with_backoff(params: list[tuple[str, str]], max_retries: int = 5):
    for attempt in range(max_retries):
        r = requests.get(
            f"{API_BASE}/data/facilities/NEM", params=params, headers=HEADERS, timeout=60
        )
        if r.status_code == 429:
            wait = 2**attempt
            print(f"429, backing off {wait}s (attempt {attempt + 1})")
            time.sleep(wait)
            continue
        return r
    raise RuntimeError(f"Exceeded retries against {API_BASE}/data/facilities/NEM")


# Log rate-limit headroom -- unpublished, so this is the only way to learn it.
me = requests.get(f"{API_BASE}/me", headers=HEADERS, timeout=30)
if me.ok:
    print(f"rate_limit: {me.json().get('data', {}).get('rate_limit', {})}")
else:
    print(f"WARN: /me failed ({me.status_code}); continuing without rate-limit visibility")

facility_codes = get_nem_facility_codes()
print(f"{len(facility_codes)} NEM facility codes, in chunks of {FACILITY_CHUNK}")

results = {"1d": 0, "5m": 0, "failed": []}
windows = [
    ("1d", nem_now - timedelta(days=DAILY_LOOKBACK_DAYS)),
    ("5m", nem_now - timedelta(days=FIVE_MIN_LOOKBACK_DAYS)),
]

for chunk_idx, chunk in enumerate(chunked(facility_codes, FACILITY_CHUNK)):
    for interval, date_start in windows:
        params = [("metrics", m) for m in METRICS]
        params += [("facility_code", c) for c in chunk]
        params += [
            ("interval", interval),
            ("date_start", date_start.strftime("%Y-%m-%dT%H:%M:%S")),
            ("date_end", nem_now.strftime("%Y-%m-%dT%H:%M:%S")),
        ]
        r = fetch_with_backoff(params)
        if r.ok:
            land(f"interval={interval}/chunk={chunk_idx:03d}", r.content)
            results[interval] += 1
        else:
            results["failed"].append(f"{interval}/chunk{chunk_idx}: {r.status_code}")
        time.sleep(0.2)  # unpublished rate limit -- stay polite

print(f"Landed: 1d={results['1d']} chunks, 5m={results['5m']} chunks")
print(f"Failed: {len(results['failed'])} -> {results['failed']}")

dbutils.notebook.exit(
    f"1d={results['1d']} 5m={results['5m']} failed={len(results['failed'])}"
)
