# Demo runbook

Three parts, ~15 minutes. Run them in order and one at a time: every Genie question below
shares one 5-requests/minute cap and one 2X-Small warehouse.

**Before you start**

- Databricks CLI authenticated (any method — profile, PAT env vars).
- `web/server/.env` filled in (`cp web/server/.env.example web/server/.env`), then `cd web && npm run dev`.
- Signed in to Databricks in the browser, for part 2's native chat/agent toggle.
- Warm the warehouse: ask the Genie space one question ~5 minutes before you begin.

---

## 1. Pipeline (5 min)

```bash
databricks bundle summary               # one bundle: pipeline + job + Genie space
databricks bundle run openelec_refresh  # fetch_api_incremental → refresh_pipeline
```

While it runs (cold start 25 s–7 min; the very first run took 7 min), open the pipeline in
the Lakeflow UI and walk the graph left to right:

| Layer | What to show | Point |
|---|---|---|
| Bronze | `openelec.bronze.raw`, `facilities_raw`; files in `/Volumes/openelec/bronze/raw` | Raw API JSON, append-only, cached so we never re-poll the API |
| Silver | `openelec.silver.dim_unit`, `facility_generation`, `generation_daily_by_fueltech`, `demand_daily` | Typed, deduped, CDC-merged |
| Gold | `openelec.gold.generation_mix_daily`, `renewable_share_daily`, `emissions_intensity_daily`, `facility_capacity_factor`, `facility_daily` + `dim_facility` | The marts Genie answers from |

Say out loud: serverless-only, one pipeline, one warehouse, fair-use quota — every design
choice below follows from that. The AI/BI dashboard (Phase 5) is not built; Genie is the payoff.

---

## 2. Genie inside Databricks: chat vs agent (5 min)

Open the space: `<workspace-host>/genie/rooms/<space-id>` (id from `bundle summary`).

**Chat mode** — ask: *What was the renewable share by region last year?*
Show: one SQL query, one table, the trusted-asset badge if it matched a curated query, the
suggested follow-ups. Then ask *and just for South Australia?* to show conversation memory.

**Agent mode** — flip the **Agent** toggle in the chat input (Beta; a workspace admin turns
it on under Previews — already on here). Ask something exploratory:
*Which wind farms in South Australia had the highest capacity factor last month, and how do
they compare to the rest of the NEM?*
Show: the research plan, several queries running, a written report with tables and citations.

| | Chat mode | Agent mode |
|---|---|---|
| Suits | One question, one answer | Open-ended "explore and explain" questions |
| Returns | Text + one SQL + one table | Reasoning steps, multiple queries, narrative report |
| Follow-ups | Yes, remembers the conversation | Yes, remembers the conversation |
| Cost / latency | Seconds, one warehouse query | Longer, several queries — burns quota faster |

---

## 3. Two ways to put Genie in front of a user (5 min)

Open the site (`http://localhost:5173`) on the **Compare** tab and click **Try it** row by row.

**1. Chat mode — Conversation API, our own site**
Ask a sample question. Show the SQL panel, the result table, the "Runs as shared demo
identity" badge, the questions/min counter.
- Pro: works for anonymous visitors — no Databricks login. Full control of UI and rate limits.
- Con: everyone is one shared identity (no row security, no per-user audit). 5 q/min. You own the SSE plumbing and the token.

**2. Agent mode — Preview API, same site**
Ask the same wind-farm question. Show reasoning lines, multiple SQL panels, the narrative.
- Pro: research-assistant answers, still anonymous-friendly, same proxy.
- Con: Preview API — documented now, but can still change without notice.

**Close:** both routes here trade a shared identity for anonymous public access — the choice
that suits this demo. The Databricks App and the official iframe embed are the other two rows
on the Compare tab, for when the audience is Databricks users rather than the public; see
`web/README.md` for those.

---

## Afterwards

Stop `npm run dev`. The refresh job stays paused (`resources/job.yml`); nothing else keeps
running.
