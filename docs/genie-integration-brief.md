# Genie Agent integration — planning brief

Input for a Claude Code spec. This is deliberately **not** a spec: it states the
target, the constraints, and the decisions that must be made, and it names the
things Claude Code has to discover in the actual repo before it can write one.

---

## 1. Objective

Add a version-controlled, benchmarked Genie Agent over the existing
OpenElectricity gold layer to the current Databricks Asset Bundle project,
deployed by `databricks bundle deploy` alongside the pipeline that already ships
there. Success is a demo that shows measurable accuracy improvement from
curation — not a tour of settings.

Non-goals: rewriting the existing pipeline; changing bronze or silver; anything
requiring account-level admin.

---

## 2. Discovery — do this before writing the spec

Claude Code must read the repo and answer these before proposing anything. Every
later decision depends on the answers.

**Bundle**
- `databricks.yml`: bundle name, targets, `engine:` setting, variables, existing
  `include:` globs and `resources/` conventions.
- `databricks --version`. Genie resources need **CLI 1.3.0+**. If older, the
  first task is the upgrade, not the agent.
- Is the bundle on the **direct** deployment engine? `genie_spaces` will not
  deploy under Terraform mode. If it's a pre-1.3.0 bundle still on Terraform,
  flipping `engine: direct` is a real change with its own blast radius — assess
  it explicitly rather than flipping it in passing.
- Naming and file conventions already in use: `resources/*.yml` per resource, or
  one file? Match what's there.

**Data**
- The actual gold tables: names, columns, types, grain, partitioning, and
  whether `COMMENT` metadata already exists.
- Specifically: is generation stored as MW, MWh, or both? Is the interval column
  `TIMESTAMP` or `TIMESTAMP_NTZ`, and what timezone convention does the pipeline
  assume? Is facility/DUID metadata separate, or flattened into the fact table?
- Row counts and date range per table.
- Whether PK/FK constraints are declared (Genie imports them as join hints).

**Environment**
- Catalog and schema names, and how they're parameterised across targets.
- Warehouse ID, and whether it's already a bundle variable.
- Existing dashboards: which tables and which metric definitions do they encode?
  Those definitions are the de facto semantic layer today and the Genie agent
  must agree with them or the demo contradicts itself.

Output of this phase: a short written inventory. If any of the above is
unknown, the spec says "unknown" rather than assuming.

---

## 3. Target shape

```
<repo>/
  databricks.yml                        # + genie var block, engine: direct
  resources/
    <existing pipeline>.yml
    nem_genie.genie_space.yml           # DAB resource, points at the JSON
  src/
    genie/
      agent_spec.json                   # human-authored source of truth
      compile_agent.py                  # spec -> serialized_space JSON
      generated/
        nem_genie.geniespace.json       # build output, committed
      tests/
        test_compile.py                 # golden-file + validation tests
      questions/
        demo.txt                        # question set for the API driver
      ask_and_observe.py                # conversation API driver + usage export
  sql/gold/
    <existing gold DDL>
    metric_views.sql                    # governed metric definitions
    genie_functions.sql                 # trusted-asset UC functions
```

Two-file split for the agent is the important bit. `agent_spec.json` is what a
human edits and reviews. `generated/*.geniespace.json` is what DABs deploys.
Committing both means the PR diff shows intent, and CI can prove the generated
file matches its source.

---

## 4. Phases

Each phase ends in something demonstrable. Don't collapse them.

**Phase 0 — baseline.** Before any curation, stand up a minimal agent over the
existing gold tables with no instructions, run the benchmark set, record the
score. Without this number the whole demo is unfalsifiable. It is also the
phase most likely to get skipped under time pressure; treat it as a deliverable.

**Phase 1 — data shape.** Whatever reshaping the discovery phase says is needed:
splitting facility metadata out of a flattened fact, adding an energy column
alongside MW, adding `COMMENT` metadata, declaring PK/FK. Ships independently of
Genie and improves the existing dashboards too.

**Phase 2 — semantic layer.** Metric views for the metrics that are genuinely
contested (see §5). Trusted-asset UC functions for parameterised questions.

**Phase 3 — agent as code.** `agent_spec.json`, the compiler, the DAB resource,
`bundle validate` green, `bundle deploy` green.

**Phase 4 — benchmarks.** 15–25 questions, 2–4 phrasings each for the important
ones, gold SQL for every question that can have one. Re-run. Compare to Phase 0.

**Phase 5 — observability.** Conversation API export to a Delta table, dashboard
over it, and that table added to a second Genie agent so the agent can be
queried about itself.

---

## 5. Decisions the spec must make explicitly

**Where the semantic layer lives.** Metric views and Genie SQL snippets can both
express "demand-weighted price". Defining it in both is how you get drift. Pick
one as source of truth. Recommendation: metric views for anything a dashboard
also consumes, Genie snippets only for phrasings and synonyms that are
conversation-specific. The spec must state the rule and apply it consistently.

**Which metrics are worth governing.** This is a domain judgement, not a coding
one, and Claude Code should not invent it. Candidates from the NEM data:
demand-weighted vs simple average price, capacity factor, renewable share,
negative-price hours, peak vs average demand, scheduled vs estimated generation.
Decide which of these your existing dashboards already assume, and make the
agent match.

**Compile vs hand-write.** The API is strict: `version: 2`, 32-char lowercase
hex IDs, most collections pre-sorted, `join_specs.sql` exactly two elements with
a `--rt=FROM_RELATIONSHIP_TYPE_*--` annotation, at most one text instruction per
agent, one SQL-format answer per benchmark. Hand-maintaining that JSON is a bad
time. Derive IDs deterministically from stable keys (md5 of the key works) so
redeploys don't churn the diff.

**Target strategy.** Structure targets as though promotion matters, but know you
can't prove it: Free Edition is one workspace and one metastore per account, so
dev→prod promotion is untestable there. Parameterise catalog and schema anyway
so the bundle ports to a real workspace unchanged.

---

## 6. Constraints

**Hard limits** — 30 tables/views per agent; 100 instructions (each example
query, each SQL function, and the text block each count as one); 200 knowledge
store snippets; 500 benchmark questions; entity matching is string columns only,
≤120 columns, ≤1,024 distinct values each.

**Benchmark scoring** — chat mode compares result sets against gold SQL and caps
at 5,000 rows; if a result exceeds that and row order differs, a correct answer
scores Bad. Keep gold SQL narrow or add a stable `ORDER BY`. Agent mode is
graded by an LLM judge against an optional evaluation note.

**Free Edition** — one 2X-Small warehouse shared by everything; one active
pipeline per type (don't let the Genie work contend with the existing pipeline);
daily quota exhaustion kills compute for the rest of the day; agent mode has
been restricted at times and can silently fall back to chat mode. A full
benchmark run is dozens of warehouse queries — budget for it.

**No eval API.** Benchmark *questions* are declarative in the agent spec, but
triggering a run and reading scores appears to be UI-only. Verify against the
current API reference; if that's still true, the spec must not promise automated
accuracy gating in CI. Design the CI check around `bundle validate` and the
compiler's own validation instead.

---

## 7. Acceptance criteria

1. `databricks bundle validate` passes on a clean checkout.
2. `databricks bundle deploy` creates the agent; a second deploy is a no-op
   (proves ID determinism).
3. `python -m pytest src/genie/tests` passes: generated JSON matches the golden
   file, and every API validation rule is checked locally.
4. Every metric in the agent traces to a metric view or a documented decision
   not to govern it.
5. Phase 0 and Phase 4 benchmark scores are both recorded in the repo.
6. `ask_and_observe.py observe` produces a Delta table with at least: question,
   generated SQL, trusted-asset flag, latency, status.
7. Nothing in the existing pipeline changed except additive gold-layer work.

---

## 8. Risks worth naming up front

- **Bolting the agent onto whatever gold tables exist.** If the current gold
  layer is one wide table, most of Genie's differentiating features have nothing
  to bite on and the demo will be thin. Phase 1 is not optional dressing.
- **Letting Claude Code write the measures.** It will produce plausible SQL for
  "average price" that is wrong in the same way an uncurated Genie agent is
  wrong. The measures are the one part you should author or review line by line.
- **Benchmark set written after curation.** Questions written with the finished
  agent in view will flatter it. Write them from what a real user would ask,
  during Phase 0, before you know what the agent handles well.
- **Engine flip.** If the bundle is on Terraform mode, moving to `direct` to get
  `genie_spaces` touches every resource in the bundle, not just the new one.
  Scope and test that separately.
- **Contradicting the dashboards.** If the agent's "renewable share" differs
  from the dashboard's, the demo undermines itself. Reconcile in Phase 2.

---

## 9. Verify before building

These were true when this brief was written and move fast. Have Claude Code
confirm each against current docs as its first spec task:

- `genie_spaces` DAB resource fields and the direct-engine requirement.
- The `serialized_space` schema version and validation rules.
- Whether a benchmark-run API exists yet.
- Agent-mode API status (Beta, admin-enabled preview) and MCP server status.
- Metric view DBR minimum for your warehouse.
