# Databricks notebook source
# One-time backfill from the OpenElectricity static bucket (unauthenticated,
# no API key). Lands verbatim JSON bytes into the bronze Volume — no parsing,
# no schema decisions here. Run ad hoc (databricks jobs submit); NOT a
# scheduled bundle resource, matching how setup.sql handles one-time DDL.
#
# Sources landed:
#   facilities -> v4/facilities/au_facilities.json           (one file)
#   stats      -> v4/stats/au/NEM/{REGION}/energy/{YEAR}.json (5 regions x 28 years)
#
# `power` (rolling 5-min bucket data) is deliberately NOT fetched here: nothing
# in silver/gold consumes it yet. Add it back when a consumer exists.

import os
import time
from datetime import datetime, timezone

import requests

BASE = "https://data.openelectricity.org.au"
VOLUME_ROOT = "/Volumes/openelec/bronze/raw"
NEM_REGIONS = ["NSW1", "QLD1", "VIC1", "SA1", "TAS1"]
YEARS = range(1999, 2027)  # bucket confirmed live through 2026 at time of writing


def fetched_at_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H%M%SZ")


def land(source: str, partition: str, content: bytes) -> str:
    ts = fetched_at_stamp()
    dir_path = f"{VOLUME_ROOT}/{source}"
    if partition:
        dir_path += f"/{partition}"
    dir_path += f"/fetched_at={ts}"
    os.makedirs(dir_path, exist_ok=True)
    path = f"{dir_path}/part-000.json"
    with open(path, "wb") as f:
        f.write(content)
    return path


def fetch(url: str) -> requests.Response | None:
    try:
        r = requests.get(url, timeout=30)
        r.raise_for_status()
        return r
    except requests.exceptions.RequestException as e:
        print(f"FAILED {url}: {e}")
        return None


results = {"facilities": 0, "stats": 0, "failed": []}

# facilities: one file, no partition
r = fetch(f"{BASE}/v4/facilities/au_facilities.json")
if r is not None:
    land("facilities", "", r.content)
    results["facilities"] = 1
else:
    results["failed"].append("facilities")

# stats: region x year grid. Not every combination exists (e.g. some regions
# have shorter history) -- 404s are expected and skipped, not fatal.
for region in NEM_REGIONS:
    for year in YEARS:
        url = f"{BASE}/v4/stats/au/NEM/{region}/energy/{year}.json"
        r = fetch(url)
        if r is not None:
            land("stats", f"region={region}/year={year}", r.content)
            results["stats"] += 1
        else:
            results["failed"].append(f"stats/{region}/{year}")
        time.sleep(0.1)  # be polite to an undocumented, unauthenticated endpoint

print(f"Landed: {results['facilities']} facilities file(s), {results['stats']} stats file(s)")
print(f"Failed: {len(results['failed'])} -> {results['failed']}")

dbutils.notebook.exit(
    f"facilities={results['facilities']} stats={results['stats']} failed={len(results['failed'])}"
)
