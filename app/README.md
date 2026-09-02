# openelec-genie

The native path in the Phase 7 four-way Genie UI comparison — see
[`../web/README.md`](../web/README.md) for the full picture (chat mode, agent mode, this App,
and the official iframe embed, side by side). Scaffolded with `databricks apps init --features
genie` per the [databricks-apps skill](https://developers.databricks.com/docs/appkit/v0/); auth,
grants, and deploy history live in that README's "Databricks App" section, not here.

Two tabs on the Genie page (`client/src/pages/genie/`):

1. **AppKit GenieChat** — the stock `<GenieChat alias="default" />`.
2. **Custom UI (useGenieChat)** — `web/`'s SQL panel / result table / status stepper logic
   ported onto AppKit's `useGenieChat` hook instead of a hand-rolled SSE parser, to prove the two
   SSE contracts line up. Two real gaps found doing that are documented inline in
   `client/src/pages/genie/CustomGenieChat.tsx`.

## Auth

Any Databricks CLI auth works — a profile (`databricks auth login` for OAuth, or `databricks
configure` for a PAT), or plain `DATABRICKS_HOST`/`DATABRICKS_TOKEN` env vars. Free Edition
(the workspace this was built against) only supports PAT; a standard workspace can use either.
The commands below are plain `databricks ...` — add `--profile <name>` if you're not using the
env-var or default-profile path. `databricks apps logs` requires OAuth specifically and won't
work over a bare PAT — use `apps get` plus the Databricks Apps UI for troubleshooting instead.

For local dev, `npm run dev` auto-loads `server/.env` if present (`cp .env.example .env` and
fill in `DATABRICKS_HOST`/`DATABRICKS_GENIE_SPACE_ID`) — no CLI or secrets manager required for
that part; the CLI is only needed for `apps validate`/`bundle deploy`/`apps get` etc.

**Before deploying to a different workspace:** `databricks.yml`'s `targets.default.variables`
has this workspace's Genie space id and name hardcoded as defaults — replace them (or override
per-deploy with `BUNDLE_VAR_genie_space_id=<id> BUNDLE_VAR_genie_space_name=<name> databricks
bundle deploy`). There's no `workspace.host` in the bundle — it's derived from whatever profile
or env vars you deploy with.

## Run it locally

```bash
npm install
databricks apps init  # already done — this scaffold exists; nothing to re-run
npm run dev
```

## Validate, deploy, manage

```bash
databricks apps validate                 # typecheck, ast-grep lint, build, tests
databricks bundle deploy                 # this app's databricks.yml sets lifecycle.started: true,
                                          # so a plain bundle deploy also starts it — no separate
                                          # `apps deploy` needed
databricks apps get openelec-genie -o json   # confirm app_status.state == RUNNING, grab .url
databricks apps start openelec-genie     # Free Edition apps auto-stop 24h after start/deploy
databricks apps stop openelec-genie      # quota hygiene when done demoing
```

## Project structure

```
client/src/pages/genie/   # GeniePage (tabs) + CustomGenieChat + StatusStepper
server/server.ts          # createApp({ plugins: [genie(), server()] })
databricks.yml            # bundle: app resource + genie_space resource (grants CAN_RUN)
app.yaml                  # DATABRICKS_GENIE_SPACE_ID injection
```
