# Phase 6 — Genie Agent over the gold layer

> Implementation spec. Companion to `genie-integration-brief.md`, which sets the intent;
> this file is the plan of record. Status tracking stays in `SPEC.md`.

## Context

`SPEC.md` closed Phase 4 with bronze→silver→gold plus a scheduled orchestration job all
green. Phase 6 (Genie) was deferred with a one-line note. `docs/genie-integration-brief.md`
(untracked) sets the real target: not a tour of Genie settings, but a **falsifiable demo** —
a baseline agent scored against a benchmark set, then curation, then the same set re-scored,
with the delta recorded in the repo.

Priority has since moved up: this needs to be evaluable soon. So the plan is sequenced so a
deployed, working agent exists after G0+G3, and the curation/measurement story layers on top
rather than blocking first light.

**Deliverable:** `openelec.gold` fronted by a version-controlled Genie Agent that ships via
`databricks bundle deploy`, with before/after benchmark scores committed.

---

## Findings that change the brief

The brief's §9 asked for these to be confirmed first. Done, against CLI 1.12.1:

| Brief claim | Reality | Consequence |
|---|---|---|
| "No eval API — benchmark runs appear to be UI-only" | **False.** `genie genie-create-eval-run`, `genie-get-eval-run`, `genie-list-eval-runs`, `genie-list-eval-results`, `genie-get-eval-result-details` all ship (Beta) | Phase G0/G4 scoring is scriptable. The brief's "must not promise automated accuracy gating" caveat is lifted |
| Needs a `compile_agent.py` to make the JSON tractable | **Superseded.** `bundle generate genie-space` round-trips (incl. `--watch`/`--force`), and `genie_spaces.<key>.file_path` inlines a `.geniespace.json` at deploy time | Drop the compiler + golden-file tests. Keep a *validator* only |
| Engine flip may be needed | Already `engine: direct` in `databricks.yml` | No blast radius. Zero work |
| CLI ≥ 1.3.0 required | 1.12.1 installed | No work |
| §5 contested metrics: demand-weighted price, negative-price hours, peak demand | **No backing data.** AEMO price/demand is deferred in SPEC.md; `market_value_aud` is the only money column | §5's metric list collapses to renewable share / capacity factor / emissions intensity |
| §2/§8: reconcile with existing dashboards | **No dashboard exists.** No `dashboards/`, no `.lvdash.json` | Nothing to contradict. Genie becomes the definition *owner*; the future dashboard inherits |

Resolved at implementation (was: unresolved, 1Password locked in the drafting session):
- **Warehouse ID** — `5e6a78f2a3683e91`. See gate results above.

---

## Free Edition — what actually bites

Three of the four things this plan depends on are Beta or preview surfaces. On Free Edition
that is a real availability question, not a formality. **Run these gates before writing
anything**, in this order — each one can invalidate a downstream phase, and finding out on day
three costs a day of quota:

| Gate | Command | If it fails |
|---|---|---|
| Genie available at all | `dbx genie list-spaces`, then create + `trash-space` a throwaway one-table space | **Stop.** Everything below is moot. Free Edition advertises AI/BI Genie, but confirm on *this* account before any other work |
| Eval API enabled | `dbx genie genie-create-eval-run <throwaway_id> --json '{}'` — read the error | Fall back to `tools/run_benchmark.py` driving the **Conversation API** instead (below). Scoring survives; only the mechanism changes |
| Metric views supported | `CREATE VIEW ... WITH METRICS` on the 2X-Small | G2 degrades to plain views. Definitions still centralise; only the governance surface is lost |
| Agent mode | check which mode an eval run reports | Assume **chat mode** — see scoring note below |

**Gate results (2026-08-30, session 1):**
- **Genie available** ✅. `dbx genie list-spaces` returns one pre-existing space
  (`01f19843cb1a11469159b42873352195`, "Bakehouse Sales Starter Space", `samples.bakehouse`
  data, `warehouse_id: 5e6a78f2a3683e91`). Didn't create/trash a throwaway space — this
  existing space already proves availability with zero extra write.
- **Eval API enabled** ✅. Ran `genie genie-create-eval-run 01f19843...  --json '{}'` against
  the Bakehouse space (it already had 4 benchmark questions loaded) — got back a real
  `eval_run_id`, not an error. `genie-get-eval-run` after completion: `eval_run_status: DONE`,
  `num_questions: 4`, `num_correct: 3`, `num_done: 4`, `num_needs_review: 0`. This also
  incidentally validated `genie-list-eval-results` shape (below) for free.
- **Warehouse ID found**: `5e6a78f2a3683e91` ("Serverless Starter Warehouse", 2X-Small,
  currently STOPPED). This resolves the "Unresolved" item below — use this for
  `${var.warehouse_id}`.
- **Metric views / Agent mode**: not checked yet. Metric-views needs a warehouse cold start
  (an "expensive operation"), deferred to G2. Agent mode: neither `genie-get-eval-run` nor
  `genie-list-eval-results` surfaces a mode field over the CLI — no cheap way to confirm this
  without an eval run against a space with instructions written both ways. Sticking with the
  doc's default assumption (chat mode) until G4.

**Real `benchmarks` shape** (discovered by exporting the Bakehouse space's
`serialized_space`, since it already had 4 benchmarks authored in the UI — this replaces the
"create one benchmark in the UI" step under G0 below, no UI visit needed):
```json
"benchmarks": {
  "questions": [
    {
      "id": "01f198440ad814759a93ae93d7dd8a3b",
      "question": ["Which product generates the highest sales volume?"],
      "answer": [{"format": "SQL", "content": ["SELECT ...", "FROM ...", "..."]}]
    }
  ]
}
```
Note the correction to this doc's earlier assumption: `benchmarks` is a top-level object
with a **nested `questions` array** (not a bare top-level array), and each answer is
`{format: "SQL", content: [...]}`, not a bare `sql` array. `genie-list-eval-results` returns
per-question `benchmark_answer` (flattened string), `question`, `status`, `result_id` — no
per-question score/diff in that call; presumably `genie-get-eval-result-details` (not yet
called) carries the pass/fail detail. `genie-create-eval-run --json '{}'` with an empty body
ran *all* the space's existing benchmarks — that's the invocation shape for "run everything,"
useful for `tools/run_benchmark.py`.

**Update 2026-09-02:** confirmed live and NOT gated on this workspace — see `web/README.md`
Phase 7. Called `POST /api/2.0/genie/agents/{space_id}/responses` directly (no CLI subcommand
exists); took 3 iterations to find the working request shape, which mirrors the OpenAI
Responses API (`input: [{type:"message", role:"user", content:[{type:"input_text", text}]}]`).
Returns a full reasoning → SQL → result → written-answer trace over SSE. Below reflects the
state as originally written, before that test.

**Assume chat-mode scoring.** Agent mode is Beta and has been admin-gated/silently downgraded;
Free Edition is the least likely place to have it. Chat mode compares *result sets* against gold
SQL and caps at 5,000 rows — a correct answer whose rows exceed that cap in a different order
scores Bad. So the benchmark set must be authored for chat mode from the start: narrow result
sets, stable `ORDER BY` on every gold query. Designing for the LLM judge and discovering you got
chat mode means rewriting the whole set.

**The eval-API fallback is worth pre-building the interface for.** `tools/run_benchmark.py`
should take questions in and emit `{question, generated_sql, status, latency, score}` out, with
the eval API as one backend and a Conversation API driver (`start-conversation` per question →
poll `get-message` → pull `.attachments[].query.query` → execute gold SQL → compare result sets
locally) as the other. That driver is the brief's original `ask_and_observe.py` idea, demoted
from primary to fallback. Same output file either way, so G0 and G4 stay comparable even if the
backend changes underneath them.

**Quota is the schedule risk, not the technical risk.** Blowing fair usage kills compute for the
rest of the day — sometimes the month — which is flatly incompatible with "evaluate ASAP." The
expensive operations here are, in order: warehouse cold starts (25s–7min each, per SPEC.md's
observations), pipeline updates for G1, and eval runs (~20 questions × LLM call + SQL execution,
largely **serialised** on one 2X-Small — expect slow, not failed).

Budget accordingly:
- **One expensive operation per sitting.** Don't run G1's pipeline update and a benchmark run
  back to back on the same day.
- **Batch work while compute is warm.** SPEC.md Phase 2 recorded 7min → 10min → 25s → 25s across
  four consecutive updates. Cold start dominates everything; sequence edits to land together.
- **Leave `openelec_refresh` PAUSED** for the duration (it already is, per SPEC.md Phase 4). A
  daily refresh firing mid-eval contends for the same serverless pool.
- **Never run a pipeline update and an eval run concurrently** — one pipeline per type is only
  half the constraint; both draw the same quota.
- Keep warehouse auto-stop tight. An idling 2X-Small outweighs the eval run itself.

**No dev/prod split.** One workspace, one metastore. `mode: development` name-prefixes bundle
resources, so the space deploys as `[dev drewtechau] OpenElectricity NEM` — expected, not a bug.
Brief §5's promotion story stays structurally correct and empirically untestable here.

---

## Free Edition vs. Enterprise — what actually changes

You have Enterprise at work. Worth knowing up front which parts of this plan are *sandbox
artifacts* that vanish on Enterprise, which are the real work that transfers unchanged, and
which capabilities Enterprise adds that can't be demoed here at all.

| Area | Free Edition (here) | Enterprise | What it buys |
|---|---|---|---|
| **Quota** | Fair-use breach kills compute for the day, sometimes the month | Metered DBUs, no shutdown | The whole "one expensive operation per sitting" discipline disappears. **Biggest day-to-day difference** |
| **Warehouses** | One shared 2X-Small, serialises everything | Many, any size, dedicated per workload | Eval runs parallelise; a Genie-dedicated warehouse ends contention with pipeline updates |
| **Scoring mode** | Assume chat mode — result-set compare, 5,000-row cap, order-sensitive | Agent mode (LLM judge) if an admin enables it | Relaxes G0's "narrow result sets, stable `ORDER BY`" constraint. Scores semantically-correct-but-differently-shaped answers properly |
| **Benchmark scale** | ~20 questions, run deliberately | 100+, run on every PR via service principal | Turns the benchmark from a demo artifact into a regression gate |
| **Targets** | One workspace + metastore; `mode: development` prefixing is cosmetic | Real dev → staging → prod | Brief §5's promotion story becomes testable. **This is where hardcoded `openelec` would finally have to become `${var.catalog}`** |
| **Multi-user** | Single account; `genie.yml`'s `permissions:` block is inert | Groups + service principals | Sharing the space with a business-user group — i.e. Genie's actual reason to exist |
| **Row/column security** | Meaningless with one user | Row filters + column masks, attached to the **base table** | See below — this is a *capability*, not just speed |
| **Observability** (deferred phase) | Scrape the Conversation API | `system.access.audit`, `system.billing.usage`, `system.query` | Usage, cost attribution and lineage come out of system tables directly |
| **Metric views** | Gate-check; may not be available | Available, `GRANT SELECT` to consumer groups | G2 stops being the phase most likely to fail |
| **CI/CD** | PAT only — OAuth unsupported on Free Edition (per `CLAUDE.md`) | Service-principal OAuth | `validate_geniespace.py` + `run_benchmark.py` become a real PR gate |

**Row-level security is the one genuine capability gap.** Genie executes generated SQL **as the
calling user**, so a row filter attached to `gold.generation_mix_daily` governs every Genie
answer automatically — one space safely serving users with different data visibility, with
**zero change to the agent config**. That is the single most compelling Genie story for an
enterprise audience and it is structurally impossible to demo on a single-user account.

### What doesn't change

The entire accuracy story is portable. Byte-identical on both:

- the `.geniespace.json` authoring model and the `genie_spaces` DAB resource
- **all of G1** — `dim_facility`, column comments, the `emissions_tco2e` rename, the
  capacity-factor denominator decision
- **all of G3** — the single merged text instruction, example SQL, region synonyms
- the benchmark questions themselves

And data volume is not a factor: the largest gold mart is ~281k rows. A bigger warehouse returns
the same answer *faster*, not *more correctly*.

> **Enterprise buys velocity, multi-user governance, and observability — not accuracy.**

That matters for how this gets presented. The demo's claim is "curation improved answer accuracy
by X," and that claim is fully demonstrable on Free Edition — the number is real and it transfers
unchanged. What you'd caveat at work is throughput and the governance surface, not the result.

### If the goal is an Enterprise evaluation

Two additions sit cleanly on top of G0–G4 and are pointless to attempt here — worth noting as the
follow-on rather than building now:

1. **RLS-scoped Genie** — one space, two personas (say, a NSW-only analyst vs. a national one),
   same questions, correctly different answers. Small work: one row-filter UDF plus a group grant.
2. **CI-gated benchmarks** — the validator and benchmark runner in GitHub Actions under a service
   principal, failing the PR on accuracy regression. The tooling from G0/G4 already has the right
   shape for this; only the auth and the trigger change.

---

## Authoring model

Single source of truth, no compiler:

```
resources/
  genie.yml                    # resources.genie_spaces.openelec_genie -> file_path
  openelec.geniespace.json     # THE agent. Hand-authored, committed
tools/
  validate_geniespace.py       # enforces API rules locally, pre-deploy + CI
```

Loop: edit JSON → `python tools/validate_geniespace.py` → `dbx bundle deploy` → smoke-test via
`genie start-conversation`. The UI is optional; if you tune there, `dbx bundle generate
genie-space --resource openelec_genie --force` pulls it back before committing.

`validate_geniespace.py` checks what the API rejects at deploy time (each of these is a real
documented rejection, cheap to catch locally):
- `version == 2`
- every `id` in `config.sample_questions` + `instructions.example_question_sqls` +
  `instructions.text_instructions` + `benchmarks` is 32-char lowercase hex and **unique across
  all four lists combined**
- `question`/`sql`/`content` are arrays of strings, never bare strings
- `data_sources.tables` sorted by `identifier`; each table's `column_configs` sorted by
  `column_name`; `example_question_sqls` and `text_instructions` sorted by `id`
- `len(text_instructions) <= 1`
- `len(data_sources.tables) <= 30`

Use the skill's ID scheme — per-list prefix + counter (`1…0001` sample, `2…0001` example SQL,
`3…0001` text, `4…0001` benchmark). Authoring order = sort order, no collisions, and IDs are
stable across redeploys, which is what makes acceptance criterion 2 (second deploy is a no-op)
hold without md5 machinery.

**Catalog is hardcoded as `openelec`** in the JSON. Whether `${var.catalog}` interpolates inside
a `file_path`-referenced JSON is unverified, and `silver.py`/`gold.py`/`fetch_api.py` already
hardcode it. Free Edition is one workspace, one metastore. Consistency beats a portability
story that can't be tested here — note it as a known port-time edit.

---

## G0 — Baseline (do not skip)

The number that makes the whole demo falsifiable. Cheap: a table list and nothing else.

- [x] **Run the four Free Edition gates above first.** Genie + eval API confirmed available;
      metric views / agent mode deferred to G2/G4 (see gate results above).
- [x] `dbx warehouses list` → add `warehouse_id` to `databricks.yml` `variables:` block.
      `5e6a78f2a3683e91`.
- [x] `dbx workspace mkdirs /Workspace/Users/drewtechau@gmail.com/genie_spaces`
      (`parent_path` must pre-exist; it is immutable once set — changing it recreates the resource).
- [x] `benchmarks/questions.md` — **written before looking at any agent output.** 20 questions
      (2 with multiple phrasings sharing one gold answer — the `benchmarks.questions[].question`
      field takes an array, so this needed no extra machinery) against the 5 gold marts that
      existed pre-G1. Two deliberate traps: #4 region synonym (`SA1` vs "South Australia"),
      #16 coverage-window mismatch (facility marts are ~370-day, region marts are 1999-present).
      Gold SQL capped and stably ordered per the chat-mode scoring constraint.
- [x] `resources/openelec.geniespace.json` — the 5 existing gold marts as `data_sources.tables`,
      **no instructions, no example SQL**. This is the uncurated control. `benchmarks.questions`
      populated from `benchmarks/questions.md` (needed so the eval run has something to score —
      the doc originally implied this loads at G4, but the eval-API backend requires benchmarks
      to exist on the space to run at all, so it landed here instead. Same 20 stay unchanged
      through G4, per acceptance-criterion comparability).
- [x] `dbx bundle deploy`, then score via `tools/run_benchmark.py` (eval-API backend — the
      Conversation-API fallback wasn't needed). Recorded to `benchmarks/baseline.json`.

**G0 result (2026-08-30): 5/20 correct (25%), 2 NEEDS_REVIEW, 13 BAD.** Space:
`01f1a447d35d13368b23dcbce2f4ed0a` (deployed as `[dev drewtechau] OpenElectricity NEM` —
note `dbx genie list-spaces` doesn't surface bundle-deployed spaces for some reason; use
`dbx bundle summary` for the space ID instead). Eval run `01f1a4480eb318ca9f80b10682e444f3`.
Every question touching `facility_daily`/`facility_capacity_factor` (~370-day marts) failed
except one — consistent with the hypothesis that column comments and instructions (G1/G3) are
where the real accuracy gain lives, not table selection. This is the number G4 must beat.

**G0 + G3 are the critical path to something evaluable.** If time is short, a deployed agent
exists after those two; G1/G2 improve it and G4 measures the improvement. Don't reorder G0 after
G3 to save a deploy, though — the uncurated score is only meaningful if it's taken before the
curation exists.

> **Verify at this step:** the exact `benchmarks[]` item shape and the `genie-create-eval-run`
> `--json` request body — neither is documented in the skill. Create one benchmark in the UI,
> then `genie get-space <id> --include-serialized-space | jq '.serialized_space | fromjson'`
> to read the real shape back. Do this *first*; everything downstream depends on it.

---

## G1 — Gold-layer shape — ✅ done (2026-08-30)

All in `pipelines/transformations/gold.py`. Additive — bronze and silver untouched
(acceptance criterion 7). Improves the future dashboard too.

**Result:** all 6 items landed in two pipeline updates (main change, then a comment-only
correction — see finding below), both clean, 15/15 flows completed each run. Full detail
recorded in `SPEC.md`'s Phase 3 section rather than duplicated here.

- [x] **1. `dim_facility`.** 545 facilities, 917 units. `primary_fueltech_group` picked by
      largest registered capacity among *mapped* groups only (ties broken alphabetically);
      unmapped fueltechs (nuclear, imports, exports, interconnector, aggregator_vpp,
      aggregator_dr) never win. `is_renewable` follows the primary group, not "has any
      renewable unit" — `fueltech_groups` is there for the latter.
- [x] **2. Capacity-factor denominator — decided.** `status_id` distribution:
      operating 641 / committed 140 / retired 136 units. Exposed both:
      `capacity_factor` (operating-capacity denominator, new default) and
      `capacity_factor_all_units` (previous behavior, all statuses). Verified concretely:
      Liddell (fully retired) now shows NULL operating-capacity-factor instead of a
      diluted number against dead capacity.
- [x] **3. `emissions_tco2` → `emissions_tco2e`** in `facility_daily` (via the private
      `_facility_daily_wide` helper).
- [x] **4. Column comments** — explicit `schema=` on all 6 public marts, covering
      coverage window, `nem_date` derivation path, units, and NULL semantics per column.
- [x] **5. `renewable_share` NULL handling — decided as proposed.** `renewable_mwh`
      coalesces to 0 only when the region-day has other generation rows (so an all-fossil
      day reads as genuinely 0% renewable, not NULL); `renewable_share` stays NULL only
      when `total_mwh` is NULL or 0.
- [x] **6. PK/FK — verified supported, deliberately skipped.** `schema=` does accept PK/FK
      constraint clauses (confirmed via the Lakeflow Pipelines skill reference). Skipped
      anyway: untested constraint syntax risked a wasted pipeline run for a single-user,
      6-table Free Edition project. Documented decision not to govern, per the plan's own
      sanctioned fallback — joins go into G3's `example_question_sqls` instead.

**Unplanned finding — a skill reference doc claim didn't hold.** `materialized-view-sql.md`
states SUM over an all-NULL group returns 0, not NULL. Tested directly on this warehouse
(`SELECT SUM(CAST(NULL AS DOUBLE))`, and real `dim_facility`/`facility_capacity_factor` rows
for fully-retired facilities): both come back NULL, standard Spark semantics. The gold
column comments were drafted with a caution about this, then corrected once disproven —
worth remembering if it resurfaces elsewhere, but it does not apply on this workspace.

Below is the original planning text, left as-authored (superseded by the result above):

**1. New mart `openelec.gold.dim_facility`.** The biggest gap: `dim_unit` is silver-only and at
*unit* grain, so **no gold table lets you slice facilities by fueltech**. "Which wind farms in SA
had the highest capacity factor?" is currently unanswerable. Roll `dim_unit` up to facility grain:
`facility_code`, `facility_name`, `network_region`, `primary_fueltech_group` (group holding the
most registered capacity), `fueltech_groups` (sorted distinct — a facility can mix solar + BESS),
`is_renewable`, `unit_count`, `capacity_registered_mw`, `capacity_registered_mw_operating`,
`lat`, `lng`.

**2. Capacity-factor denominator — author decision, do not let it default silently.**
`_facility_daily_wide` joins `dim_unit` with **no `status_id` filter**, so
`facility_capacity_factor` divides by capacity including decommissioned/retired units,
understating historical capacity factors. Brief §8 names exactly this class of thing as
author-reviewed. First: `SELECT status_id, count(*) FROM openelec.silver.dim_unit GROUP BY 1`
to see the real values. Proposed: expose **both** denominators and make operating-only the
default `capacity_factor`. Whatever you pick, it must match what G2's semantic layer says.

**3. `emissions_tco2` → `emissions_tco2e`** in `facility_daily` and `_facility_daily_wide`.
Same quantity, two spellings across mart families — a guaranteed Genie confusion.

**4. Column comments on all six gold marts.** SPEC.md Phase 3 deferred these ("naming + table
comments already carry most of the Genie-readability value") — that trade no longer holds now
that a Genie agent is the consumer. Requires an explicit `schema="col TYPE COMMENT '...', ..."`
string on each `@dp.materialized_view`. Do **not** use post-hoc `ALTER TABLE ... ALTER COLUMN`:
an MV full refresh clobbers it. Highest value/lowest risk item in G1 — prioritise it.

Comments must carry the traps: coverage window per table, `nem_date` derivation (bucket path is
`date_add(history_start, pos)`; API path is `from_utc_timestamp(..., 'Etc/GMT-10')` — two
derivations, one column name), units, and that `NULL` means no-data, never zero.

**5. `renewable_share` NULL handling — author decision.** `F.sum(F.when(is_renewable, ...))`
returns NULL when a region-day has zero renewable rows. Since `generation_mix_daily` *has* rows
for that region-day, absence of renewable rows means genuinely zero, not unknown. Proposed:
coalesce `renewable_mwh` to 0, keep `renewable_share` NULL when `total_mwh` is NULL or 0.

**6. PK/FK — verify, then decide.** Genie imports UC constraints as join hints; none are declared
anywhere. Check whether Lakeflow SDP materialized views accept constraints via the same `schema=`
string. If yes: PK on `dim_facility.facility_code` and the mart grains, FK from the facility marts.
If not: **skip and document it** (satisfying acceptance criterion 4's "documented decision not to
govern"), and carry the joins in `example_question_sqls` instead. Do not use `ALTER TABLE` —
same full-refresh clobber problem as #4.

> **Deploy note:** all six gold marts are **materialized views**, which recompute in full when
> their definition changes — so `dim_facility`, the column-comment `schema=` strings, and the
> `emissions_tco2e` rename all land on a plain `bundle deploy` + pipeline update. No
> `--full-refresh` needed. SPEC.md Phase 3's painful selective-full-refresh was a *streaming
> table* (`silver.facility_generation`, 5.6M rows, schema-evolved a new column in as blank), and
> G1 doesn't touch silver at all. Recompute cost here is seconds of real work against ≤281k-row
> marts; the wall-clock is serverless cold start, not the query. Land all of G1's `gold.py` edits
> in **one** pipeline update rather than iterating — that's the Free Edition quota play.

---

## G2 — Semantic layer

Rule (brief §5, applied consistently): **metric views own anything a dashboard will also consume;
the agent's own snippets own only conversation-specific phrasing and synonyms.** Defining a
measure in both is how drift starts.

Because there is no dashboard yet, Genie is the *first* consumer, not a follower — so these
definitions become the contract the future SPEC.md Phase 5 dashboard must inherit.

- [ ] `sql/metric_views.sql` — one metric view over `generation_mix_daily` + `dim_facility`
      exposing the three genuinely contested measures: `renewable_share`, `total_generated_mwh`,
      `emissions_intensity_tco2e_per_mwh`, dimensioned by `nem_date` / `network_region` /
      `fueltech_group`. Aggregate-then-divide for both ratios, matching `gold.py` exactly.
- [ ] `sql/genie_functions.sql` — 2 trusted-asset UC functions for the parameterised questions:
      `gold.f_facility_capacity_factor(facility_code, start_date, end_date)` and
      `gold.f_region_mix(region, start_date, end_date)`.

Both run once against the warehouse, **deliberately not bundle-managed** — same precedent and
rationale as `setup.sql` (SPEC.md Phase 0: one-time DDL under `mode: development` name-prefixing
is pure friction on a single-workspace account).

The **de-facto semantic layer that already exists** and must not be contradicted:
`pipelines/utils/fueltech.py`'s `RENEWABLE_GROUPS = {solar, wind, hydro, bioenergy}` — renewable
share therefore **excludes pumps and battery entirely, and nulls out interconnector/import/export
flows** (unmapped fueltechs → NULL group, NULL `is_renewable`). Plus the GWh→MWh ×1000 conversion
in `_generation_daily_wide`. State both explicitly in the metric view and the text instruction.

> **Verify:** that Genie accepts a metric view as a `data_sources.tables` entry on this
> warehouse, and the metric-view DBR minimum. If it doesn't, fall back to plain views in
> `sql/metric_views.sql` — the definitions still centralise, only the governance surface is lost.

**G2 is the phase to cut if quota or time gets tight.** It's the weakest link on Free Edition
(metric views are the most likely gate failure) and the least load-bearing for the before/after
demo — G1's column comments and G3's instructions carry most of the measurable accuracy gain.
Cutting it costs the governance story, not the result. Cutting G1 or G4 costs the demo itself.

---

## G3 — Curated agent as code — ✅ done (2026-08-30)

**Result:** `resources/openelec.geniespace.json` rewritten in place (G0's stub is
superseded, not kept as a separate file — same reasoning as the original authoring model:
no compiler, one hand-authored file). 6 tables (adds `dim_facility`), 6 sample questions,
10 example SQLs (weighted at facility×fueltech joins, region synonyms, the coverage-window
trap, and the negative-value/revenue-not-price traps), 1 merged text instruction, same 20
benchmarks carried over unchanged from G0. Deployed via `bundle deploy` — cheap, this is a
Genie-space PATCH, not a pipeline update, so no warehouse/pipeline quota cost to iterate on.
Region-code value synonyms landed on `network_region` on all 6 tables; see the API-shape
finding under G4 below (found by cheap trial-and-error deploy, not documented anywhere).
Live smoke test and the G4 re-score both confirm it works — see G4.

Below is the original planning text, left as-authored:

Rewrite `resources/openelec.geniespace.json` from the G0 stub.

`resources/genie.yml`, matching the repo's one-file-per-resource-type convention
(`pipeline.yml`, `job.yml`) and the globally-unique-key rule SPEC.md Phase 4 hit the hard way:

```yaml
resources:
  genie_spaces:
    openelec_genie:
      title: OpenElectricity NEM
      description: Natural-language Q&A over NEM generation, emissions and capacity marts.
      warehouse_id: ${var.warehouse_id}
      parent_path: /Workspace/Users/${workspace.current_user.userName}/genie_spaces
      file_path: ./openelec.geniespace.json
```

`data_sources.tables` — sorted by identifier, as the API requires:
`dim_facility`, `emissions_intensity_daily`, `facility_capacity_factor`, `facility_daily`,
`generation_mix_daily`, `renewable_share_daily` (+ the metric view). Six of thirty — the table
cap is not binding.

**`text_instructions` accepts at most one item.** Merge everything into that single entry:
- Coverage asymmetry — facility marts are trailing ~370 days (API window); region marts run
  1999→present. "Renewable share vs capacity factor over time" silently spans different windows
  unless the agent says so. This is the trap most likely to produce a confidently wrong answer.
- Region codes are `NSW1 QLD1 VIC1 SA1 TAS1`; there is no ACT (folded into NSW1) and no WA
  (`dim_unit` is filtered to `network_id = 'NEM'`).
- Renewable = solar/wind/hydro/bioenergy only. Pumps and battery excluded. Interconnector flows
  are unclassified.
- Energy is MWh throughout; capacity is MW. `emissions_tco2e`. `market_value_aud` is revenue,
  **not price** — there is no price or demand data in this project.
- `nem_date` is NEM local time (fixed UTC+10, no DST).
- The `interval='1d'` filter is already applied inside gold; never re-apply or mention it.
- NULL ≠ 0. Never coalesce a generation value.
- Negative values are legitimate (load and battery charging).

`example_question_sqls` — ~8–12, weighted at the joins and the traps: facility×fueltech via
`dim_facility`, long-run mix shifts, region comparison, capacity-factor ranking within a fueltech,
and at least one that demonstrates the correct handling of the coverage-window mismatch.

**Synonyms / prompt matching for region codes.** Users say "New South Wales" and "South
Australia"; the data says `NSW1`/`SA1`. Per the skill this is exactly the wrong-filter-value case
that must be fixed with value synonyms, **not** a hardcoded text instruction. Entity matching is
string columns only, ≤120 columns, ≤1,024 distinct values each — `network_region` (5 values) and
`facility_name` (306) both fit comfortably.

`config.sample_questions` — ~6 for the UI landing page.

---

## G4 — Benchmarks — ✅ done (2026-08-30)

**Result: 10/20 correct (50%), up from G0's 5/20 (25%) — exactly double.** Curated space:
`01f1a447d35d13368b23dcbce2f4ed0a`, eval run `01f1a45ee8d311dc83ced7011cde45ee`. Committed
to `benchmarks/curated.json`.

Per-question: 6 flipped BAD → GOOD, 1 flipped GOOD → BAD, 13 unchanged. The 6 fixes are
almost all facility-grain questions (market value, capacity-factor ranking, emissions
intensity, renewable-share trend) — consistent with the plan's bet that column comments
(coverage window, join hints, NULL semantics) carry the accuracy gain, not table selection.

**The 1 regression is a benchmark-authoring artifact, not a real curation regression.**
"How many distinct NEM regions are in the generation data, and what are they?" — gold SQL
returns 5 rows (`SELECT DISTINCT network_region ... ORDER BY`); the curated agent answered
with `COUNT(DISTINCT ...) + COLLECT_SET(...)`, a single row with a count and an array.
Same information, different shape, so chat-mode's exact result-set compare marks it Bad.
A second landmine alongside the row-cap/ordering one the plan already flagged for chat
mode: a "how many X and what are they" phrasing invites an aggregate-shaped answer:
author gold questions and gold SQL to match the shape a natural phrasing would produce, or
avoid dual-shape phrasings entirely.

Smoke test (verification step 5) confirmed live before the eval run: "Which wind farms in
South Australia had the highest capacity factor last month?" — impossible before G1's
`dim_facility` — correctly resolved "South Australia" → `SA1` via the column synonym, joined
`dim_facility` on `primary_fueltech_group = 'wind'`, and returned a sensible ranked answer
(Cathedral Rocks, Snowtown South, Mt Millar, capacity factors 0.16–0.32).

**Undocumented API shape found by trial-and-error deploy (cheap — genie space PATCH, no
warehouse/pipeline cost):** value synonyms are `column_configs[].synonyms`, a **flat array of
alternate terms** ("New South Wales", "NSW", …), not a value-keyed map
(`{"value": "NSW1", "synonyms": [...]}` is rejected — "Expected Scalar value for String
field 'synonyms'"). `tools/validate_geniespace.py` now checks this shape.

Below is the original G4 planning text, left as-authored:

- [ ] Load `benchmarks/questions.md` into `serialized_space.benchmarks[]` (top-level key —
      *not* nested under `instructions`), one SQL-format answer per benchmark.
- [ ] `tools/run_benchmark.py` — wraps `genie-create-eval-run` → poll `genie-get-eval-run` →
      `genie-list-eval-results` → write JSON.
- [ ] Re-run against the curated agent → `benchmarks/curated.json`.
- [ ] Record the before/after delta in `SPEC.md`'s Phase 6 section. **This is the demo.**

Per the Free Edition section: keep the set at ~20, run evals deliberately rather than on every
edit, and never concurrently with a pipeline update. If scores look inexplicable, check which
mode actually ran before debugging the agent.

---

## Deferred

**Observability (brief Phase 5)** — conversation-API export to Delta, a dashboard over it, and a
second agent querying it. Deferred alongside SPEC.md Phase 5. **Re-scope before building** — the
design in the brief is now doubly outdated:

- The eval-run API yields structured results directly, which is cheaper than scraping the
  Conversation API for the same signal.
- On Enterprise this phase largely dissolves: `system.access.audit`, `system.query` and
  `system.billing.usage` already carry usage, latency and cost attribution, so the bespoke
  export exists only to work around Free Edition's missing system tables. Build the
  Free-Edition version only if the *scraping* is itself the thing you want to learn.

---

## Verification

1. `python tools/validate_geniespace.py resources/openelec.geniespace.json` — clean.
2. `dbx bundle validate --strict` — clean on a fresh checkout.
3. `dbx bundle deploy` creates the space; **run it a second time and confirm a no-op** — this is
   what proves ID determinism (acceptance criterion 2).
4. Pipeline update after G1 succeeds; `DESCRIBE TABLE EXTENDED openelec.gold.dim_facility` shows
   column comments; `SELECT count(*), min(nem_date), max(nem_date)` on each mart is sane.
5. Smoke-test live: `dbx genie start-conversation <space_id> "Which wind farms in South Australia
   had the highest capacity factor last month?"` — a question that was **impossible** before G1's
   `dim_facility`. Then `genie get-message` and read the generated SQL, not just the prose answer.
6. `benchmarks/baseline.json` and `benchmarks/curated.json` both committed, with the delta written
   into `SPEC.md`.
7. `git diff` confirms nothing outside `gold.py`, `databricks.yml`, and the new files changed —
   bronze and silver untouched.

## Files

**New:** `resources/genie.yml`, `resources/openelec.geniespace.json`, `sql/metric_views.sql`,
`sql/genie_functions.sql`, `tools/validate_geniespace.py`, `tools/run_benchmark.py`,
`benchmarks/questions.md`, `benchmarks/baseline.json`, `benchmarks/curated.json`

**Modified:** `pipelines/transformations/gold.py` (dim_facility, column comments, capacity-factor
denominator, `emissions_tco2e` rename, renewable-share NULL handling), `databricks.yml`
(`warehouse_id` variable), `SPEC.md` (Phase 6 status + recorded scores)

**Untouched:** everything in `pipelines/transformations/bronze.py`, `silver.py`, `ingestion/`,
`resources/pipeline.yml`, `resources/job.yml`
