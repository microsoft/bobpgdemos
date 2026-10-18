# Demo 6: Caldova Knowledge Hub — Vector Search Kept Fresh by an AI Pipeline

A FastAPI app on Azure App Service. Operators search logistics procedures,
carrier notes, and facility runbooks **by meaning**. When they add, edit, or
delete an article, HorizonDB keeps the vectors current without any app code:

```text
article INSERT/UPDATE ──► on_change trigger ──► ai pipeline (pg_durable graph)
   changed rows ─► ai.chunk ─► ai.embed (Microsoft Foundry) ─► upsert chunk_embedding ─► DiskANN
```

Only built-in features: the pipeline, its generated `on_change` trigger, and
pg_durable running each pipeline run. There is no custom background job.

The screen is split in two:

- **Left: the app.** Search with **Vector** (DiskANN cosine), **Keyword** (BM25 via
  `pg_textsearch`), or **Hybrid** (reciprocal rank fusion). Every article shows a
  live freshness badge: `Embedding 0/1` → `Searchable · 1 chunk`.
- **Right: the AI pipeline, live.** Top: the pipeline SQL, **rendered from the
  `ai.pipelines` catalog** (plus the DiskANN index from `pg_indexes`). Bottom:
  the run animation, driven by
  `ai.pipeline_runs` and the run's **pg_durable** steps (`df.nodes`). Runs take
  about 2 seconds, so a completed run is replayed using the step completion
  times pg_durable recorded; the matching SQL lines highlight as each step plays.
  **Hide pipeline** collapses the pane.

Nothing on the right is simulated: run numbers, rows, durations, step timings,
durable instance IDs, and chunk counts come from HorizonDB.

## Prerequisites

1. Parent Caldova preflight (`../scripts/00-preflight.ps1`): cluster, firewall,
   `.venv`, `.caldova-connection.json`, `pwd.env`.
2. Demo 3 preflight (`../demo3-ai-pipeline/scripts/00-preflight.ps1`): the
   `caldova-embedding` Foundry model alias and the `vector`, `pg_diskann`,
   `pg_textsearch`, `azure_ai`, and `pg_durable` extensions.
3. **`azure_ai` 2.3.2 or later.** With 2.2.2 SQL objects on a 2.3 library,
   every run fails in `ai._update_checkpoint` and stays `running`, which stops
   `on_change` triggers. Preflight checks this. Fix with
   `ALTER EXTENSION azure_ai UPDATE TO '2.3.2';` (no downgrade path).

## Build and run

```powershell
./demo6-vector-app/scripts/00-preflight.ps1            # schema, pipeline, seed, handbook, app role
./demo6-vector-app/scripts/01-run-local.ps1 -Port 8020 # local run as knowledge_hub_app
./demo6-vector-app/scripts/02-deploy-appservice.ps1 -AppName <name>  # Azure App Service
```

Preflight is idempotent. When `pwd.env` exists, it adds a generated
`KNOWLEDGE_HUB_APP_PASSWORD` row if missing; without `pwd.env`, it prompts for
the admin and app passwords. It waits until every article is searchable.
Use `-ResetArticles` to restore the 12 seed articles.

The deployment script creates (when missing) a Linux **P0v3** plan and a
**Python 3.14** web app in `caldova-logistics-rg` / `westus3`, sets
`SCM_DO_BUILD_DURING_DEPLOYMENT=true`, the startup command
`python -m uvicorn main:app --host 0.0.0.0`, Always On, and the HorizonDB
settings, then zip-deploys `src/`. The plan is billable. App Service reaches
HorizonDB through the existing `0.0.0.0` Azure-services firewall rule; the
script stops if that rule is missing. The first request after a deploy can
take 2–3 minutes while the container warms up.

The app has no sign-in, so anyone with the URL can edit articles and cause
billed embedding calls. By default it is public. `-AllowedIpAddress` limits it
to one IPv4 address, but some networks (including this presenter network)
reach Azure from a different, changing address pool than their general public
IP, so confirm you can still open the site after restricting it. Tear the app
down after the event.

## Step by step (start here)

The step-by-step walkthrough is the **home page** (`/`) and stands on its own,
with no link to the full app. (`/walkthrough` redirects to it.) It is the simplest way
to show that searches are never blocked by the AI pipeline. **The app is on the
left; the AI pipeline is on the right**: the pipeline panel is open from the
start, shows the live `ai.create_pipeline` definition, and replays each run
slowly (stage by stage, with the times pg_durable recorded) so an audience can
follow it. One step of the app is on screen at a time; **Next →** / **← Back**
move between steps. The example adds *Dry ice in air shipments* and searches
for *frozen CO2 on passenger flights*.

1. **Search**: select *Search*. You see the current results.
2. **Add an article**: select *Add the article*. The app only saves a row; the
   `on_change` trigger starts the AI pipeline (watch it on the right).
3. **Auto-search** (automatic, no click needed): the pipeline takes about two
   seconds, faster than anyone can click, so the page runs the same search the
   moment you save and jumps to this step. It answers immediately (about 100 ms
   on App Service) without the new article, because it is not embedded yet.
   Next unlocks when the pipeline has finished.
4. **Search again**: select *Search again*. The new article is in your
   results, marked **NEW**, followed by **What happened, in order**, for example
   `+0.00 s` article saved → `+0.49 s` automatic search answered, pipeline still
   running → `+1.69 s` pipeline finished → `+10.39 s` search again: new article at #1.

5. **Survive a failover mid-run** (real, not simulated): select **⚡ Update the
   handbook and fail over**. The app revises all 16 parts of the *Dock audit
   handbook* in one statement (`knowledge_hub.revise_handbook()`, about 320
   chunks), so the `on_change` trigger starts **one** pipeline run of about
   30 seconds. As soon as that run is in **Embed**, the app forces a real
   HorizonDB failover (managed identity → Azure Resource Manager → the primary
   replica's role is set to *Read*). Three rows update once a second:
   **AI pipeline run** (its steps, then *paused at Embed* while the primary is
   down, then *same run picked back up on the new primary*), **Primary server**
   (an opaque id that changes when a new primary takes over) and **Searches**
   (still answering). When the run finishes, the step searches *forklift speed
   limit in Dock 4* and finds the new rule, marked **UPDATED**.

   Why it works: the AI pipeline runs on pg_durable. Every finished step is
   recorded in HorizonDB, so after the failover pg_durable continues the same
   run from the step that was interrupted; finished steps are not redone.
   Verified on this cluster: run #354 was in Embed when the primary went down
   for about 8 seconds; on the new primary the same run carried on and
   completed with all 300 chunks, with no failure and no new run.

   The handbook is created by `sql/06-failover-handbook.sql` (16 parts, each
   under the 20,000-character article limit). The button appears only when the
   app was deployed with `-EnableFailover`; `scripts/03-force-failover.ps1`
   forces a failover from a terminal. One failover every 5 minutes.

   **Security:** the app has no sign-in, so anyone who can reach it can press
   the button. The web app's identity has **Contributor on the HorizonDB
   cluster only** (the tenant's custom-role limit is reached, and no built-in
   role is narrower); the app's code only ever changes a replica's role.
   Remove the role assignment after the event.

   Needs high availability (a second replica). The cluster has
   `caldova-logistics-replica-ha` for this; it roughly doubles the compute cost,
   so remove it after the event (Azure portal → High availability → Disabled).
   The embedding deployment (`caldova-embedding`) runs at capacity 350 (350K
   tokens and 350 requests per minute). A handbook run uses about 75K tokens,
   and when the failover lands late in Embed, pg_durable re-runs Embed on the
   new primary, so about 150K tokens can arrive within one minute. At 150K that
   once failed with `RateLimitReached`. This preview does not retry a failed run
   on its own; step 5 then says so, and **Start over** runs it again.

**Start over** deletes the demo article so you can run it again. Every request
has a timeout, and a search that does not answer within 0.8 s is sent again
(shown as *after a network retry*), so a request lost by a proxy cannot freeze
the walkthrough. Static files are served with `Cache-Control: no-cache`, so a
redeploy is picked up without a hard refresh.

## Demo script (about 5 minutes)

This uses the full app at **`/app`** (type it in the address bar; its
**1 · 2 · 3 Step by step** button goes back to the walkthrough).

1. Search **"our truck fridge died on the highway"** with **Keyword**: no results,
   because no article uses those words. Switch to **Vector**: *Reefer unit failure
   response* is first. Show **Hybrid** for RRF ranks.
2. Point at the right pane: this is the pipeline definition read live from
   `ai.pipelines`. `trigger => 'on_change'` and `incremental_column => 'updated_at'`
   are why edits are picked up automatically.
3. Search **"frozen CO2 on passenger flights"**: no good answer yet.
4. **New article** → *Dry ice in air shipments*, category *Handling procedure*:

   > Carbon dioxide solid (dry ice, UN1845) used to chill perishables or pharma is
   > limited to 200 kg per package on passenger aircraft. Mark the net weight on
   > each box, use packaging that vents gas, and declare it on the air waybill.

   **Save & embed.** On the right, the run plays: trigger → changed rows →
   chunk → embed → upsert → checkpoint → DiskANN, each with its recorded
   pg_durable time. The badge flips to *Searchable*; select **Run the search
   again**: the new article is first. Switch to **Keyword**: it still ranks
   *Northwind Air cargo cutoffs* first.
5. **Edit** the article and search right away: it is still found, labeled
   *Previous version · refreshing*, then the new text. Only that row is
   re-embedded (`Rows 1`). **Delete** it: it disappears from search immediately.
   For the "searches are not blocked" story, use **Step by step** instead.
6. Optional: edit an article from SQL in VS Code; the app picks it up the same way.

**Reset demo** restores the seed articles; only changed rows are re-embedded.

## How it works

| Object | Purpose |
| --- | --- |
| `knowledge_hub.article` | Source of truth. `embedding_text = title + content` is what gets embedded. A trigger bumps `updated_at` when text changes. |
| `knowledge-hub-pipeline` | `ai.table_source(incremental_column => 'updated_at')` → `ai.chunk(256/32)` → `ai.embed(caldova-embedding, 1536)` → `ai.table_sink`, `trigger => 'on_change'`. |
| `knowledge_hub.chunk_embedding` | Pipeline sink with a DiskANN index. Upserts on `chunk_hash = md5(chunk_text)`. |
| `knowledge_hub.article_chunk_map` | Each article's expected chunk hashes, computed synchronously with the same `azure_ai.chunk` call and the live pipeline's chunk settings. |
| `knowledge_hub.article_chunk_previous` | An edited article's last fully embedded chunk list, kept until the new version is embedded. |
| `knowledge_hub.searchable_chunk` | What search joins to: each article's current chunks once all are embedded, otherwise its previous version. |
| `knowledge_hub.article_freshness` | Expected vs embedded chunks per article and whether it is refreshing; drives the badges. |
| `knowledge_hub.refresh_chunk_map()` | Runs on every article save (row trigger): recomputes the expected chunks, keeps the last complete version as *previous*, and deletes vectors that no version of any article uses any more. |
| `knowledge_hub.pipeline_status()` | One JSON snapshot for the right pane: definition, runs, latest run's `df.nodes`, freshness. |

### Searches never wait for the pipeline

- Saving only commits the row; the `on_change` trigger submits a pg_durable
  job and returns (an insert took 0.18 s), and embedding runs in the background.
- Vector search latency on the reader endpoint was unchanged during a refresh
  (median 96 ms vs 100 ms idle in testing).
- The query is embedded once per search (one Foundry call), outside the
  search SQL, and repeated query text reuses a cached embedding. Calling
  `embed_query` inside the search SQL made PostgreSQL evaluate it once per
  stored chunk (about 3 s per search).
- While an edited article is re-embedded, search serves its **previous** complete
  version; it switches to the new version only when every new chunk has a
  vector (about 1.5–2 s). New articles appear once embedded; deleted articles
  disappear immediately, and their vectors are deleted with them, so re-adding
  the same text is embedded again by the pipeline.
- Re-saving text that another current article already uses is searchable at
  once, because the sink is keyed by chunk content.
- pg_durable stores every step of a run as a checkpoint in HorizonDB tables
  (`df.*`), which are backed up and replicated with your data. After a restart
  or failover the worker on the new primary resumes the run from its last
  completed step, so refreshes finish without lost or duplicated embeddings;
  searches keep serving the previous version meanwhile. Step 5 shows this
  with a real failover.

### Why the sink is content-addressed (preview behavior verified on this cluster)

- The sink's `doc_id` is `row_number() OVER ()` within each run's batch, **not**
  the source key, so upserting on `doc_id` overwrote other articles' chunks.
  Upserting on `chunk_hash` and mapping hashes back to articles is exact.
- Old chunks of an edited or deleted article are never returned once the new
  version is embedded, because search joins vectors to `searchable_chunk`.
  Vectors no version uses any more are deleted on the next save of that
  article, so stale near-duplicates do not crowd the DiskANN candidates.
- `on_change` fires on `INSERT` and `UPDATE` only, at statement level. Its
  generated trigger (`IF NOT running THEN ai.run(...)`) does not start a run
  while one is running, and nothing re-queues the change: verified, an article
  saved during a 30-second run was not embedded when that run finished. It
  waits for the next write to the table. A failed run is not retried either.
  The walkthrough therefore waits for an idle pipeline before step 2 saves, and
  setup waits for each run before the next step writes. Reported as preview
  feedback; `trigger => 'schedule'` would avoid it at the cost of latency.
- The trigger adds about 7 ms (median; 95th percentile 37 ms) to the statement
  that starts a run, measured on this cluster; statements while a run is active
  add 0.07 ms. The pipeline work itself runs after commit.
- A zero-row `UPDATE` still starts a run.
- `on_conflict_action` must be `DO NOTHING` or `DO UPDATE SET ...`.

### Security

The app connects as `knowledge_hub_app`: `SELECT` on the Knowledge Hub tables
and views, and `EXECUTE` on `save_article`, `delete_article`, `embed_query`,
`pipeline_status`, and `reset_demo`. These `SECURITY DEFINER` functions pin
`search_path`, so the app never writes tables, starts pipelines, or reads `df.*`
directly, and has no access to other Caldova tables. The Foundry key stays in the
HorizonDB model registry. Note that `azure_ai` grants `PUBLIC` read access to
`ai.pipelines` and `EXECUTE` on `azure_openai.create_embeddings` by default. The
database password is an App Service setting; for production, use a Key Vault
reference. The deployed app is public by default; for shared use, add App
Service authentication (Microsoft Entra ID), which needs an app registration.

## Tests

```powershell
cd demo6-vector-app
../.venv/Scripts/python.exe -m pytest tests -q
```

The tests cover routes, all three search modes, the `/api/search` JSON API
(including `embedding_pending`), saving with a JSON response for scripts, the
step-by-step walkthrough page and article API,
graceful database outages, one embedding call per query (cached), the
failover and handbook endpoints, SQL rendering from the catalog, classification
of real pg_durable step SQL, stage timing, and that the demo uses no custom
pg_durable job.

## Teardown

```powershell
./demo6-vector-app/scripts/99-teardown.ps1 -AppName <name>
```

Drops the pipeline, the `knowledge_hub` schema, and the
`knowledge_hub_app` role, then deletes the web app and plan. Other demos are not
affected.
