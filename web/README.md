# Four ways to put Genie in front of a user

A demo React site — plus a Databricks App and a live iframe embed — that answers questions
against the Phase 6 Genie space (`resources/openelec.geniespace.json`), showing all four ways to
expose it: two hand-rolled ("outside Databricks") and two native ("inside Databricks"). Phase 7
in [SPEC.md](../SPEC.md).

Demoing this? Follow [DEMO.md](../DEMO.md) — this file is the reference behind it.

Open the site and start on the **Compare** tab — it's the table below, made interactive: pick a
row's **Try it** to jump straight to that mode.

> `dbx <cmd>` below is shorthand for "however you invoke the Databricks CLI with credentials" —
> a CLI profile (`databricks auth login` / `databricks configure`), a PAT via
> `DATABRICKS_HOST`/`DATABRICKS_TOKEN` env vars, or a secrets-manager wrapper. Substitute
> `databricks` plus your own auth method throughout. This project has no dependency on any one
> of those; see "Run it" for the app-level equivalent (a `.env` file, no CLI needed at all).

## The four options

| Option | Where it runs | Anonymous OK? | Identity | Free Edition gotchas |
|---|---|---|---|---|
| **Chat mode** (Conversation API) — this folder | This site + a Node proxy you own | **Yes** | one shared token | 5 q/min, one 2X-Small warehouse, fair-use shutdown |
| **Agent mode** (Preview Agent API) — this folder | Same site + proxy | **Yes** | shared token | Preview, shares the same 5 q/min budget |
| **Databricks App** (AppKit `genie()` + `<GenieChat/>`) — [`../app/`](../app/) | `*.databricksapps.com` | No — Databricks login | the app's own service principal | 3 apps max, 24 h auto-stop, 120 s proxy timeout, no `apps logs` on PAT auth |
| **Official iframe embed** (Share → Embed space) | Databricks' own UI, framed | No — Databricks login | the signed-in visitor | needs an admin domain allow-list; Free Edition's single user makes this a demo of the login gate |

Chat and agent mode are a backend you own authenticating once; visitors never touch Databricks,
but everyone shares that one identity. Databricks' own docs point external-user scenarios here.
The App and the embed both require a real Databricks login — on Free Edition that means exactly
one person can use either at a time. Full pros/cons for each are in the Compare tab; this table
is the short version.

## How it works

```
Browser (Vite + React, :5173)  ──SSE──▶  server/ (Express, :3000, holds the token)
                                               │  fetch + Bearer
                                               ▼
                /api/2.0/genie/spaces/{space}/start-conversation
                .../conversations/{c}/messages           follow-ups
                .../messages/{m}                         poll every 2 s
                .../messages/{m}/attachments/{a}/query-result
                                               ▼
                             Genie space → 2X-Small warehouse → openelec.gold.*
```

The server polls Genie and re-emits progress to the browser as Server-Sent Events using the
same event names as AppKit's `genie()` plugin (`message_start`, `status`, `query_result`,
`message_result`, `error`) — [`../app/`](../app/)'s custom tab proves that contract actually
matches, by driving this project's own `SqlPanel`/`ResultTable`/`StatusStepper` off AppKit's
`useGenieChat` hook instead of this SSE parser.

## Run it

```bash
cd web && npm install
cp server/.env.example server/.env   # fill in DATABRICKS_HOST, DATABRICKS_TOKEN, GENIE_SPACE_ID
npm run dev
# open http://localhost:5173 (Vite falls back to 5174 etc. if 5173 is taken —
# see "Embed" below for why that matters)
```

`server/.env` is gitignored and picked up automatically (Node's `--env-file-if-exists`, wired
into the `dev`/`start` scripts) — no secrets manager required. The token stays in the Node
process and never reaches the browser bundle. `GENIE_SPACE_ID` has no default — every workspace
has a different space id — find it via `databricks bundle summary` if this space was deployed
by this project's bundle (`genie list-spaces` doesn't show bundle-deployed spaces), or the
space's "About" tab in the UI. `APP_URL` and `DATABRICKS_WORKSPACE_ID` are optional, for the
Compare/Embed tabs. Full var list and comments in `server/.env.example`.

If your environment already injects these as real env vars some other way (a secrets manager, a
CLI wrapper, CI) that works too — a plain `.env` file is just the zero-dependency default; the
`.env` file and any such wrapper are interchangeable, so use whichever fits your setup.

Housekeeping for the 10,000-conversation cap per space:

```bash
npm run prune            # dry run, >24 h old
npm run prune -- --yes   # delete
```

## Guardrails built in

- Global token bucket at 4 questions/min (Databricks caps the API at 5/min per workspace; the
  UI gets 20). One extra request waits for a slot with a visible "Waiting" step; beyond that
  the proxy answers 429. The Embed tab bypasses this entirely — it talks straight to Databricks.
- One in-flight question per browser session, 500-character questions, no automatic retries.
  Every question is a warehouse query against a Free Edition fair-use quota.
- Generated SQL is always shown, with a **Curated answer** badge when Genie answered from a
  trusted asset (`instruction_id` on the query attachment), and an AI-generated disclaimer on
  every answer.
- Expired query results are re-executed once via `execute-query`.

## Limitations of this approach

1. **One shared identity.** Every visitor runs SQL as the token's owner: no row-level
   security, no per-user audit trail, and a leaked PAT is full workspace access. In a real
   deployment use a service principal holding only `CAN RUN` on the space and `SELECT` on gold,
   authenticated with OAuth M2M, and put a login or passcode in front of the site.
2. **Throughput.** 5 questions/min through the API, one 2X-Small warehouse shared with the
   pipeline, and Free Edition's fair-use shutdown. A public URL without rate limiting can take
   the workspace down for the rest of the day.
3. **Latency.** Answers take seconds by design; a cold warehouse adds more. Not a search box.
4. **Feature gap vs the Databricks UI.** Chat mode returns text, SQL and a result set. No
   built-in charts (the visualization download endpoint returns an image), no thumbs up/down
   unless `send-message-feedback` is wired, no agent-mode research reports unless that preview
   is enabled (it is also capped at 5 requests/min with a 30-minute server timeout).
5. **No official React component outside Databricks Apps.** AppKit's `GenieChat` is built for
   Apps; a standalone site owns its own UI and SSE plumbing (this folder) — now demoed
   side-by-side in [`../app/`](../app/), including what breaks when you port it.
6. **Embedding is not a shortcut.** iframe embed needs a Databricks login plus an admin domain
   allow-list; external-user embedding covers dashboards only. Demoed live in the Embed tab.
7. **Conversation housekeeping.** 10,000-conversation cap per space and query results expire,
   so the backend prunes and re-executes.

## Agent mode (Preview)

A second tab, **Agent mode**, calls Genie's Preview Agent mode API instead of the Conversation
API. Where chat mode returns text + one SQL query + a result set, agent mode narrates its own
reasoning, can run more than one query, and returns a written answer with an inline results
table and citation — closer to a research assistant than a Q&A box.

Gate-checked live against this workspace on 2026-09-02: **not admin-gated here.** The request
shape was originally found by trial (no CLI subcommand ships for it) and has since been
confirmed documented: https://docs.databricks.com/aws/en/genie-agents/api.

```json
POST /api/2.0/genie/agents/{space_id}/responses
{
  "input": [{
    "type": "message", "role": "user",
    "content": [{"type": "input_text", "text": "your question"}]
  }],
  "conversation_id": "optional — omit to start a new conversation"
}
```

The docs also confirm conversation continuation: the response's top-level `conversation_id` is
sent back on the next call's request body to continue that conversation, mirroring chat mode's
follow-ups. The server (`genie.ts`'s `streamAgentResponse`) and client (`api.ts`'s
`streamAgentResponse`) both take an optional `conversationId` now; the client stores the id from
`agent_start` and sends it on the next question in the same tab, clearing it on "Clear
transcript".

The response streams Server-Sent Events (`response.created`, `response.output_item.added` /
`.done`, `response.completed`, `response.failed`, and a documented `.updated` event this build
ignores — harmless, since only `.done` items carry complete content) with item types
`reasoning`, `function_call` (the SQL it decides to run), `function_call_output`, and a final
`message`. The server (`server/src/index.ts`) only forwards `.done` items and re-emits them as
`agent_start` / `agent_item` / `agent_done` for the client.

Known gaps in this build:
- **No `type_name` on table columns.** Chat mode's statement API always includes it; agent
  mode's message metadata doesn't, so the server infers numeric vs string from the first row's
  value rather than trusting a declared type.
- **Preview, not GA.** The request/response shape above is documented but still Preview — it
  can change without notice. Documented limits: 5 requests/min per workspace, 30-minute server
  timeout — this build shares the same proxy rate limiter as chat mode, which already matches.
- **AppKit's `genie()` plugin has no agent-mode route at all** — the App in `../app/` only
  ports chat mode.

## Databricks App

Built in [`../app/`](../app/): `databricks apps init --features genie --set
genie.genie-space.id=<space-id>` (resource key confirmed via `dbx apps manifest`, not guessed),
deployed with `dbx bundle deploy` (its `databricks.yml` sets `lifecycle.started: true`, so that
alone starts it — no separate `apps deploy` needed). Its Genie page has two tabs:

1. **AppKit GenieChat** — the stock `<GenieChat alias="default" />`. This is the entire
   integration; AppKit owns the SSE plumbing, conversation state, and result rendering.
2. **Custom UI (useGenieChat)** — this project's `SqlPanel`/`ResultTable`/`StatusStepper` logic
   ported onto AppKit's `useGenieChat` hook and its own component library (`Table`, `Collapsible`,
   `Badge`, `Tabs`) instead of a hand-rolled SSE parser, to prove the two SSE contracts actually
   line up.

Two real gaps turned up porting it (both called out inline in
`app/client/src/pages/genie/CustomGenieChat.tsx`):

- **No curated-answer signal.** This site's `SqlPanel` shows a "Curated answer" badge when the
  Conversation API attachment carries `instruction_id`. AppKit's cleaned
  `GenieAttachmentResponse.query` type has no such field — every query in the custom tab reads
  as plain "Generated", confirmed by reading the shipped `.d.ts`, not by trial and error.
- **No row count / truncation flag.** `GenieStatementResponse` is a trimmed type with no
  `total_row_count` or `truncated` — the custom tab's table can only say how many rows it's
  showing, not how many exist in total.

**Data access granted to the app's service principal** (Genie executes SQL as the caller, not
as the space owner):

```bash
dbx grants update CATALOG openelec --json '{"changes":[{"principal":"<sp-client-id>","add":["USE_CATALOG"]}]}'
dbx grants update SCHEMA openelec.gold --json '{"changes":[{"principal":"<sp-client-id>","add":["USE_SCHEMA","SELECT"]}]}'
dbx permissions update warehouses <warehouse-id> --json '{"access_control_list":[{"service_principal_name":"<sp-client-id>","permission_level":"CAN_USE"}]}'
```

`CAN_RUN` on the Genie space itself is granted automatically by the bundle's `genie_space`
resource (`app/databricks.yml`) on every deploy — confirmed via `dbx permissions get genie
<space-id>`.

**Free Edition means restart-before-demo.** Apps auto-stop 24 h after start/deploy:

```bash
dbx apps start openelec-genie   # if stopped
dbx apps get openelec-genie -o json   # confirm app_status.state == RUNNING, grab .url
dbx apps stop openelec-genie    # when done — quota hygiene
```

## Official iframe embed

Confirmed live: [Manage dashboard and Genie Space embedding](https://docs.databricks.com/aws/en/ai-bi/admin/embed)
states plainly that dashboard and Genie space embedding share **one** admin setting — the CLI
name for it (`aibi-dashboard-embedding-approved-domains`) is dashboard-flavored but it gates
Genie spaces too. Access policy on this workspace was already `ALLOW_APPROVED_DOMAINS`;
`localhost:5173` (and `5174`, since Vite falls back there when something else holds `5173`) were
added to the list:

```bash
dbx api patch /api/2.0/settings/types/aibi_dash_embed_ws_apprvd_domains/names/default --json '{
  "allow_missing": true,
  "field_mask": "aibi_dashboard_embedding_approved_domains.approved_domains",
  "setting": {"aibi_dashboard_embedding_approved_domains": {"approved_domains": ["localhost:5173", "localhost:5174"]}}
}'
```

The CLI's generated `databricks settings aibi-dashboard-embedding-approved-domains update`
command sends an **empty `field_mask`**, which the API silently treats as a no-op — this needed
the raw `api patch` call with the field mask spelled out by hand.

The Embed tab renders the space's own room URL
(`<host>/genie/rooms/<space-id>?w=<workspace-id>`) in an `<iframe allow="clipboard-write">` —
the same URL Share → Embed space would give you; that exact dialog click-through wasn't
captured here (no browser in this environment), so if Databricks' generated snippet ever adds
more than the bare URL, this tab is a close approximation, not a byte-for-byte copy. Signed in,
you get the full Genie UI including charts and feedback buttons the Conversation API doesn't
expose; signed out, you hit Databricks' own login prompt — that gate, live, is the actual point
of this tab. Free Edition's single user means it can only ever demo one identity: yours.
