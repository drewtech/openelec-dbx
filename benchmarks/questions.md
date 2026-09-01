# Genie benchmark questions

Written before looking at any agent output (`docs/genie-spec.md` G0), against the 5 gold
marts that existed at G0 time — `generation_mix_daily`, `renewable_share_daily`,
`emissions_intensity_daily`, `facility_daily`, `facility_capacity_factor`. No `dim_facility`
yet, so no fueltech-filtered facility questions (that mart lands in G1).

Chat-mode scoring compares result sets and caps at 5,000 rows, so every gold query below has
a bounded result and a stable `ORDER BY`. The `id` is the 32-char hex id used verbatim in
`resources/openelec.geniespace.json`'s `benchmarks.questions[]` — keep this file and that JSON
in sync by hand (no compiler, per the "Authoring model" section of the spec).

Two are deliberately trap questions the uncurated baseline is expected to get wrong and the
curated agent (G3) is expected to fix: #4 (region synonym — "South Australia" vs `SA1`) and
#16 (coverage-window mismatch between the deep-history region marts and the ~370-day facility
marts).

---

### 1 — `40000000000000000000000000000001`
**Questions:**
- What was the total generation by fueltech group in NSW1 for the last full calendar year?
- Which fuel technologies generated the most electricity in New South Wales last year?

**Gold SQL:**
```sql
SELECT fueltech_group, SUM(generated_mwh) AS total_mwh
FROM openelec.gold.generation_mix_daily
WHERE network_region = 'NSW1' AND YEAR(nem_date) = YEAR(CURRENT_DATE()) - 1
GROUP BY fueltech_group
ORDER BY total_mwh DESC, fueltech_group ASC;
```

### 2 — `40000000000000000000000000000002`
**Questions:**
- Which NEM region generated the most electricity from wind in the last full calendar year?

**Gold SQL:**
```sql
SELECT network_region, SUM(generated_mwh) AS wind_mwh
FROM openelec.gold.generation_mix_daily
WHERE fueltech_group = 'wind' AND YEAR(nem_date) = YEAR(CURRENT_DATE()) - 1
GROUP BY network_region
ORDER BY wind_mwh DESC, network_region ASC;
```

### 3 — `40000000000000000000000000000003`
**Questions:**
- How has coal's share of generation in Victoria changed between 2000 and 2024?

**Gold SQL:**
```sql
WITH yearly AS (
  SELECT YEAR(nem_date) AS yr,
         SUM(CASE WHEN fueltech_group = 'coal' THEN generated_mwh ELSE 0 END) AS coal_mwh,
         SUM(generated_mwh) AS total_mwh
  FROM openelec.gold.generation_mix_daily
  WHERE network_region = 'VIC1' AND YEAR(nem_date) IN (2000, 2024)
  GROUP BY YEAR(nem_date)
)
SELECT yr, coal_mwh, total_mwh, coal_mwh / total_mwh AS coal_share
FROM yearly
ORDER BY yr ASC;
```

### 4 — `40000000000000000000000000000004`
**Questions:**
- Total generation in South Australia for the last full calendar year, by fueltech group.
- What did SA1 generate by fuel type last year?

**Gold SQL:**
```sql
SELECT fueltech_group, SUM(generated_mwh) AS total_mwh
FROM openelec.gold.generation_mix_daily
WHERE network_region = 'SA1' AND YEAR(nem_date) = YEAR(CURRENT_DATE()) - 1
GROUP BY fueltech_group
ORDER BY total_mwh DESC, fueltech_group ASC;
```

### 5 — `40000000000000000000000000000005`
**Questions:**
- What was the average renewable share by region for the last full calendar year?

**Gold SQL:**
```sql
SELECT network_region, AVG(renewable_share) AS avg_renewable_share
FROM openelec.gold.renewable_share_daily
WHERE YEAR(nem_date) = YEAR(CURRENT_DATE()) - 1
GROUP BY network_region
ORDER BY avg_renewable_share DESC, network_region ASC;
```

### 6 — `40000000000000000000000000000006`
**Questions:**
- Which day had the highest renewable share in Tasmania in the last 5 years?

**Gold SQL:**
```sql
SELECT nem_date, renewable_share
FROM openelec.gold.renewable_share_daily
WHERE network_region = 'TAS1'
  AND nem_date >= date_sub(current_date(), 1825)
  AND renewable_share IS NOT NULL
ORDER BY renewable_share DESC, nem_date ASC
LIMIT 1;
```

### 7 — `40000000000000000000000000000007`
**Questions:**
- What's the renewable share trend in South Australia, by year, 2015 through 2024?

**Gold SQL:**
```sql
SELECT YEAR(nem_date) AS yr, AVG(renewable_share) AS avg_renewable_share
FROM openelec.gold.renewable_share_daily
WHERE network_region = 'SA1' AND YEAR(nem_date) BETWEEN 2015 AND 2024
GROUP BY YEAR(nem_date)
ORDER BY yr ASC;
```

### 8 — `40000000000000000000000000000008`
**Questions:**
- Which NEM region has the lowest average emissions intensity over the last full calendar year?

**Gold SQL:**
```sql
SELECT network_region, AVG(emissions_intensity_tco2e_per_mwh) AS avg_intensity
FROM openelec.gold.emissions_intensity_daily
WHERE YEAR(nem_date) = YEAR(CURRENT_DATE()) - 1
GROUP BY network_region
ORDER BY avg_intensity ASC, network_region ASC;
```

### 9 — `40000000000000000000000000000009`
**Questions:**
- What was the average grid emissions intensity in Queensland by calendar year, 2019 to 2024?

**Gold SQL:**
```sql
SELECT YEAR(nem_date) AS yr, AVG(emissions_intensity_tco2e_per_mwh) AS avg_intensity
FROM openelec.gold.emissions_intensity_daily
WHERE network_region = 'QLD1' AND YEAR(nem_date) BETWEEN 2019 AND 2024
GROUP BY YEAR(nem_date)
ORDER BY yr ASC;
```

### 10 — `4000000000000000000000000000000a`
**Questions:**
- Which facility generated the most energy in the last 30 days?

**Gold SQL:**
```sql
SELECT facility_code, facility_name, network_region, SUM(energy_mwh) AS total_mwh
FROM openelec.gold.facility_daily
WHERE nem_date >= date_sub(current_date(), 30)
GROUP BY facility_code, facility_name, network_region
ORDER BY total_mwh DESC, facility_code ASC
LIMIT 10;
```

### 11 — `4000000000000000000000000000000b`
**Questions:**
- Top 10 facilities by market value over the last 90 days.

**Gold SQL:**
```sql
SELECT facility_code, facility_name, network_region, SUM(market_value_aud) AS total_market_value_aud
FROM openelec.gold.facility_daily
WHERE nem_date >= date_sub(current_date(), 90)
GROUP BY facility_code, facility_name, network_region
ORDER BY total_market_value_aud DESC, facility_code ASC
LIMIT 10;
```

### 12 — `4000000000000000000000000000000c`
**Questions:**
- Total energy generated by facility in NSW1 over the last 30 days, ranked highest to lowest.

**Gold SQL:**
```sql
SELECT facility_code, facility_name, SUM(energy_mwh) AS total_mwh
FROM openelec.gold.facility_daily
WHERE network_region = 'NSW1' AND nem_date >= date_sub(current_date(), 30)
GROUP BY facility_code, facility_name
ORDER BY total_mwh DESC, facility_code ASC;
```

### 13 — `4000000000000000000000000000000d`
**Questions:**
- Which facilities had the highest capacity factor over the last 30 days?

**Gold SQL:**
```sql
SELECT facility_code, facility_name, network_region, AVG(capacity_factor) AS avg_capacity_factor
FROM openelec.gold.facility_capacity_factor
WHERE nem_date >= date_sub(current_date(), 30) AND capacity_factor IS NOT NULL
GROUP BY facility_code, facility_name, network_region
ORDER BY avg_capacity_factor DESC, facility_code ASC
LIMIT 10;
```

### 14 — `4000000000000000000000000000000e`
**Questions:**
- What was the average capacity factor by region over the last 90 days?

**Gold SQL:**
```sql
SELECT network_region, AVG(capacity_factor) AS avg_capacity_factor
FROM openelec.gold.facility_capacity_factor
WHERE nem_date >= date_sub(current_date(), 90) AND capacity_factor IS NOT NULL
GROUP BY network_region
ORDER BY avg_capacity_factor DESC, network_region ASC;
```

### 15 — `4000000000000000000000000000000f`
**Questions:**
- Which 5 facilities had the lowest capacity factor over the last 30 days, among those with at least 10 days of data?

**Gold SQL:**
```sql
SELECT facility_code, facility_name, network_region, AVG(capacity_factor) AS avg_capacity_factor, COUNT(*) AS days
FROM openelec.gold.facility_capacity_factor
WHERE nem_date >= date_sub(current_date(), 30) AND capacity_factor IS NOT NULL
GROUP BY facility_code, facility_name, network_region
HAVING COUNT(*) >= 10
ORDER BY avg_capacity_factor ASC, facility_code ASC
LIMIT 5;
```

### 16 — `40000000000000000000000000000010`
**Questions:**
- What was the average renewable share in South Australia over the same period the facility-level data covers?

**Gold SQL** (coverage-window trap — must scope to `facility_daily`'s actual window, not all of 1999-present):
```sql
WITH window AS (
  SELECT MIN(nem_date) AS start_date, MAX(nem_date) AS end_date
  FROM openelec.gold.facility_daily
)
SELECT AVG(r.renewable_share) AS avg_renewable_share
FROM openelec.gold.renewable_share_daily r, window w
WHERE r.network_region = 'SA1'
  AND r.nem_date BETWEEN w.start_date AND w.end_date;
```

### 17 — `40000000000000000000000000000011`
**Questions:**
- What was the total market value generated by SA1 facilities in the last 30 days?

**Gold SQL:**
```sql
SELECT SUM(market_value_aud) AS total_market_value_aud
FROM openelec.gold.facility_daily
WHERE network_region = 'SA1' AND nem_date >= date_sub(current_date(), 30);
```

### 18 — `40000000000000000000000000000012`
**Questions:**
- How many distinct NEM regions are in the generation data, and what are they?

**Gold SQL:**
```sql
SELECT DISTINCT network_region
FROM openelec.gold.generation_mix_daily
ORDER BY network_region ASC;
```

### 19 — `40000000000000000000000000000013`
**Questions:**
- What was the highest single-day total generation recorded in Queensland since 1999?

**Gold SQL:**
```sql
SELECT nem_date, SUM(generated_mwh) AS total_mwh
FROM openelec.gold.generation_mix_daily
WHERE network_region = 'QLD1'
GROUP BY nem_date
ORDER BY total_mwh DESC, nem_date ASC
LIMIT 1;
```

### 20 — `40000000000000000000000000000014`
**Questions:**
- Were there any days with negative total generation for a fueltech group in NSW1 over the last 90 days, and which groups and dates?

**Gold SQL:**
```sql
SELECT nem_date, fueltech_group, generated_mwh
FROM openelec.gold.generation_mix_daily
WHERE network_region = 'NSW1'
  AND nem_date >= date_sub(current_date(), 90)
  AND generated_mwh < 0
ORDER BY nem_date ASC, fueltech_group ASC;
```
