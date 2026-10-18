# Session history: Caldova Knowledge Hub (AI pipeline + pg_durable demo)

Handoff from the Copilot chat session in the old repo `C:\bobpgsqldemos`
(GitHub `microsoft/bobpgsqldemos`, branch `bw`) on 2026-10-16 to 2026-10-18.
The repo is being moved to `C:\bobpgdemos` (GitHub `microsoft/bobpgdemos`) as a
fresh commit, and the old repo will be deleted. No passwords are in this file;
they are in the git-ignored `caldovalogistics/pwd.env`.

## What was built

**Demo 6: Caldova Knowledge Hub** (`caldovalogistics/demo6-vector-app`). It's a
FastAPI app on Azure App Service that shows vector search kept fresh by an Azure
HorizonDB AI pipeline (`ai.create_pipeline`, `trigger => 'on_change'`), with each
pipeline run executed by **pg_durable**.

- **Live app:** https://caldova-knowledge-hub-d1229495.azurewebsites.net/
  - `/` is the **step-by-step walkthrough** (home page; `/walkthrough` redirects
    to it).
  - `/app` is the full app (Vector, Keyword and Hybrid search; add, edit and
    delete articles).
- **Layout:** the app is on the left, and the live AI pipeline panel on the right
  (the pipeline SQL read from `ai.pipelines` and a run animation driven by
  pg_durable step times). On the walkthrough the panel is compact: the code gets
  about 16 lines, the stages and one row of facts are kept, and the extra tiles,
  note and history are hidden.

### The walkthrough (final design, one step on screen at a time)

1. **Search**: "frozen CO2 on passenger flights", showing the current results.
2. **Add an article**: "Dry ice in air shipments". The app only saves a row, and
   the `on_change` trigger starts the pipeline. Step 2 first waits for any
   running pipeline run to finish (see the preview limitations below).
3. **Auto-search**: automatic, with no click. It runs the same search the moment
   the article is saved, while the pipeline is still running, and shows that the
   search is **not blocked** (about 100–400 ms). The new article isn't there yet.
4. **Search again**: the new article is at #1, marked **NEW**, followed by a
   "What happened, in order" timeline.
5. **Survive a failover mid-run**: the **⚡ Update the handbook and fail over**
   button does the following:
   - Revises all 16 parts of the *Dock audit handbook* in one statement
     (`knowledge_hub.revise_handbook()`, about 320 chunks), which is one pipeline
     run of about 30–60 s.
   - Waits until the run is in **Embed**.
   - Forces a **real** HorizonDB failover. The app uses its managed identity and
     ARM to set the primary replica's role to `Read`.
   - Shows three live rows:
     - **AI pipeline run**: "paused at Embed", then "same run picked back up on
       the new primary", then finished;
     - **Primary server**: an opaque id that changes when a new primary takes
       over;
     - **Searches**: still answering.
   - Then searches "forklift speed limit in Dock 4" and finds the new rule,
     marked **UPDATED**.
   - At most one failover every 5 minutes.

**Start over** deletes the demo article. Requests have timeouts, and searches are
hedged (re-sent after 0.8 s), so a request lost by the corporate proxy can't
freeze the page. Static files are served with `Cache-Control: no-cache`.

## Azure resources and state (as of 2026-10-18 ~16:20 CT)

| Resource | Details |
|---|---|
| Subscription | `AzureSQL_bobward` |
| Resource group | `caldova-logistics-rg` (westus3) |
| HorizonDB cluster | `caldova-logistics`, PostgreSQL 17, 2 vCores. Read-write endpoint `caldova-logistics.fdabeb1879b5.westus3.horizondb.azure.com`; read-only endpoint `caldova-logistics.fdabeb1879b5.ro.westus3.horizondb.azure.com`; database `postgres`; admin `caldovaadmin` (**password authentication only**; see below). |
| Replicas | `caldova-logistics-replica-1` and **`caldova-logistics-replica-ha`** (added 2026-10-18 for failover; roughly **doubles compute cost**). Which one is primary changes with each failover. |
| Extensions | `azure_ai` **2.3.2** (upgraded from 2.2.2 with approval), `pg_durable` 0.2.5, `pg_diskann`, `pg_textsearch`, `vector`, `pgaadauth`. |
| Firewall | Rules for several client IPs (including `66.169.187.67` and `12.149.60.54`) plus `allow-azure-services`. |
| Foundry | `caldova-logistics-ai` (AIServices S0). Deployment **`caldova-embedding`** (text-embedding-3-small) raised to **capacity 350** (it was 10; then 150; 350 avoids rate limits when a failover re-runs Embed). `caldova-agent-chat` (gpt-5-mini) is unchanged. |
| App Service | Web app **`caldova-knowledge-hub-d1229495`**, plan `caldova-knowledge-hub-d1229495-plan` (P0v3 Linux, Python 3.14), **public with no sign-in** (Entra sign-in and IP restrictions were rejected or impractical). |
| App identity | System-assigned managed identity (principal `5a9a6cc5-4fff-49e8-a8e1-c58918f37ab7`) with **Contributor on the `caldova-logistics` cluster only**. A narrower custom role failed (tenant custom-role limit reached), and there's no built-in HorizonDB role. App setting `KNOWLEDGE_HUB_CLUSTER_ID` enables the failover button. |

### Clean up after the event

- Remove the replica `caldova-logistics-replica-ha` (portal → High availability →
  Disabled).
- Remove the web app's Contributor role assignment on the cluster.
- Optionally set `caldova-embedding` back to a lower capacity.
- Delete the App Service app and plan:
  `demo6-vector-app/scripts/99-teardown.ps1 -AppName caldova-knowledge-hub-d1229495`.
  This also drops the `knowledge_hub` schema, the pipeline and the app role.

## How to run and deploy

```powershell
cd caldovalogistics
./demo6-vector-app/scripts/00-preflight.ps1        # schema, pipeline, seed, handbook, app role
./demo6-vector-app/scripts/01-run-local.ps1 -Port 8020
./demo6-vector-app/scripts/02-deploy-appservice.ps1 -AppName caldova-knowledge-hub-d1229495 -EnableFailover
./demo6-vector-app/scripts/03-force-failover.ps1   # same forced failover from a terminal
```

- **Tests:** from `demo6-vector-app`, run
  `..\.venv\Scripts\python.exe -m pytest tests -q -p no:cacheprovider` (49 pass).
- **Python environments to rebuild after the move** (they hold absolute paths):
  - `caldovalogistics/.venv`: Python 3.13; used by the scripts and tests.
  - `demo4-foundry-agent/caldova-logistics-agent/src/agent-framework-agent-basic-responses/.venv`.
- **Git-ignored files to carry over:**
  - `caldovalogistics/pwd.env`: `CALDOVA_DATABASE_PASSWORD`,
    `CALDOVA_AGENT_PASSWORD`, `KNOWLEDGE_HUB_APP_PASSWORD`;
  - `caldovalogistics/.caldova-connection.json`;
  - `caldovalogistics/demo4-agent-mcp/.azure/` and
    `demo4-foundry-agent/caldova-logistics-agent/.azure/` (azd environments);
  - `campsites/.local/.env`.

## Key code (demo6-vector-app)

| Path | Contents |
|---|---|
| `sql/01-knowledge-hub-schema.sql` | Tables `article`, `chunk_embedding` (pipeline sink, keyed on `chunk_hash`), `article_chunk_map`, `article_chunk_previous`; views `article_freshness` and `searchable_chunk` (serve the previous version while re-embedding). `refresh_chunk_map()` also deletes superseded vectors at save time. Plus `save_article`, `delete_article`, `embed_query`, `pipeline_status` and `reset_demo`. |
| `sql/02-create-pipeline.sql` | `ai.create_pipeline('knowledge-hub-pipeline', …, trigger => 'on_change')`: `ai.chunk` 256/32 → `ai.embed caldova-embedding` (1536). |
| `sql/04-seed-articles.sql` | 12 seed articles. |
| `sql/05-app-role-grants.sql` | Least-privilege `knowledge_hub_app`. |
| `sql/06-failover-handbook.sql` | 16 handbook parts (each under the 20,000-character limit) and `revise_handbook()`. |
| `src/knowledge_hub/app.py` | Routes: `/`, `/app`, `/api/search`, `/api/status`, `/api/cluster`, `POST /api/handbook`, `POST /api/failover`, `/health`. |
| `src/knowledge_hub/failover.py` | `ClusterFailover`: ARM `PATCH …/pools/DefaultPool/replicas/{primary}` with `role: Read`, api-version `2026-01-20-preview`; 5-minute cooldown. |
| `src/knowledge_hub/repository.py` | Search SQL. The query is embedded once on the **primary** (cached), and the search runs on the reader. Also `cluster_status`, `revise_handbook` and `pipeline_running`. |
| `src/knowledge_hub/static/walkthrough.js` and `templates/walkthrough.html` | The 5-step walkthrough. |

**Removed by decision:** the custom **pg_durable reconciler** (a `df.loop` every
10 s that re-queued skipped changes and cleaned vectors). It contradicted the
"built-in features only" concept, so the demo now uses only the pipeline, its
generated trigger, and pg_durable inside each run.

## Verified findings on this cluster (HorizonDB preview)

- **The pipeline runs on pg_durable.** Each run has a pg_durable `instance_id`,
  and each step is a checkpoint in `df.*` and `_duroxide.*`.
- **A mid-run failover is survived by the same run.**
  - Runs #354, #409, #414 and #422: the primary went down in the middle of Embed
    for about 4–9 s. On the new primary the same run and instance continued, with
    one execution and no new run, and completed all chunks.
  - The interrupted Embed step is **re-run as a whole**, which doubles embedding
    calls. At capacity 150 that once hit `RateLimitReached` (run #411 failed).
- **The `on_change` trigger is synchronous but light.**
  - It adds a median of **7.2 ms** (p95 37 ms, max 71 ms) to the statement that
    starts a run, and 0.07 ms while a run is already active. The run starts only
    after COMMIT, and a rollback means no run.
  - The generated trigger is `AFTER INSERT OR UPDATE … FOR EACH STATEMENT`, which
    does `IF NOT running THEN ai.run(...)`.
- **A change made while a run is active is NOT picked up** (preview gap). A
  verified probe saved during a 30-second run was not embedded when the run
  finished, and no new run started. It waits for the next write to the table.
- **Failed runs are not retried automatically** (preview gap).
- **`trigger` values** accepted by `ai.create_pipeline`: `manual`, `on_change`,
  `schedule`.
- **`azure_ai` calls fail on a standby replica** ("cannot assign TransactionIds
  during recovery"), so the query embedding must run on the primary.
- **A cancelled run (`df.cancel`) leaves `_ai_batch_*` staging tables behind.**
  Drop them when the pipeline is idle.
- **The sink's `doc_id` is a per-batch row number, not the source key**, so the
  sink upserts on `chunk_hash`. Even a zero-row UPDATE starts a run.
  `on_conflict_action` must be `DO NOTHING` or `DO UPDATE SET …`.
- **Failover:**
  - No `az horizondb` command yet; use the portal (High availability → Manage
    replicas and failover → Forced/Planned failover) or `az rest`.
  - It needs a second replica.
  - The primary goes down about 10–30 s after the request; the new primary is up
    in about 2–9 s.
  - Searches on the read endpoint kept answering throughout.
- **Microsoft Entra sign-in is NOT available** on this cluster: "Microsoft Entra
  ID authentication is not currently enabled for OrionDb in this region or
  subscription" (`clusters/administrators`, api-version `2026-05-01-preview`).
  Connect with a password.

**Feedback worth sending to the HorizonDB team:**
- queue changes made during a run;
- retry failed runs;
- resume Embed from the last batch rather than re-running the whole step;
- clean up staging tables after a cancel;
- a CLI command for failover;
- Entra sign-in in westus3.

## User preferences (Bob Ward)

- Keep demos dead simple, step by step, with one thing on screen at a time.
- Talk before building when asked; avoid complex forms and use plain language.
- Open results in a **new Edge window** (`msedge.exe --new-window <url>`).
- Use real behavior, not simulations. Label anything that is simulated (the
  failover simulation was rejected and replaced by a real failover).
- Use only built-in features in the demo (the reconciler was removed for this
  reason).
- Do not push unless asked. Commits use the `Co-authored-by: Copilot` trailer.

## Commit history from the old repo (not carried over by the fresh start)

Branch `bw` was 14 commits ahead of `origin/bw` (never pushed):

```text
f55ed5b Knowledge Hub: remove the pg_durable reconciler; built-in features only
cb2f48a Knowledge Hub: give the pipeline code more room on the step-by-step page
54a0c6e Knowledge Hub step 5: fail over in the middle of a pipeline run
bff1ecd Knowledge Hub walkthrough: force the failover from the app
bef6c44 Knowledge Hub walkthrough: step 5 watches a real HorizonDB failover
824ba2e Knowledge Hub walkthrough: step 5 shows durability across a failover
825028e Knowledge Hub walkthrough: app on the left, pipeline on the right
2432cd5 Knowledge Hub walkthrough: never hang on a lost request
c908cfe Knowledge Hub: step-by-step walkthrough is the home page
3f9d01c Knowledge Hub walkthrough: step 4 replays the pipeline run slowed down
64955d5 Knowledge Hub walkthrough: one step at a time with stepper and Next/Back
ffebd79 Knowledge Hub: make Step by step the single demo path
19a838d Knowledge Hub: step-by-step walkthrough page
a55963e Knowledge Hub: keep searching during AI pipeline refreshes
```

Earlier in the same session, on the older Control Tower app
(`caldovalogistics/app`), a Debug drawer was added that shows the pipeline SQL
plus an animation (commit `8f3cd20`, already on `origin/bw`).

## The move to `C:\bobpgdemos` (done 2026-10-18)

- **One fresh commit on `main`, not pushed.** It contains every file the old
  repo tracked plus its uncommitted work (a root `README.md` edit, `.github/`
  skills, `campsites/`), this history file, and Bob's `bobpgdemos.code-workspace`
  (which replaces `bobpgsqldemos.code-workspace`).
- **`.gitignore`:** the new repo's file was kept. It differs from the old one
  only in comment lines, so the ignore rules are the same.
- **Git-ignored files copied and verified ignored:**
  - `caldovalogistics/pwd.env` and `caldovalogistics/.caldova-connection.json`;
  - both `.azure/` azd environments;
  - `campsites/.local/.env`.
- **`caldovalogistics/.venv` rebuilt:** Python 3.13.15, the same 65 pinned
  package versions as before (plus pip). The Control Tower app is now installed in editable mode
  from `C:\bobpgdemos\caldovalogistics\app`; the old environment pointed at an
  even older `C:\bwsql\...` copy.
- **Not rebuilt:** `demo4-foundry-agent/.../agent-framework-agent-basic-responses/.venv`.
  It was already broken in the old repo (8 packages, no agent framework) and is
  unused. `Run-LocalDebug.ps1` expects `<repo>\.venv-caldova-hosted-agent`,
  which never existed; create it from that folder's `requirements.txt` if local
  agent debugging is needed. The agent itself runs in Foundry.
- **Verified from the new path:**
  - the Knowledge Hub tests (49) and the Control Tower app tests (26) pass;
  - the Knowledge Hub ran locally against the live HorizonDB (search, status
    and cluster APIs all worked).
- **Nothing to change in Azure for the move:** the deployed app and database
  don't depend on the local folder. Redeploy from the new path with
  `02-deploy-appservice.ps1 … -EnableFailover` whenever the code changes.
