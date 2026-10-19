---
name: caldova-demo6
description: 'Preflight, build/deploy, run, or reset this repository''s Caldova Logistics Demo 6 (Knowledge Hub vector search kept fresh by a HorizonDB AI pipeline, with a live failover step). Use when asked to run, preflight, pre-flight, deploy, build, open, reset, or check Caldova demo 6, the Knowledge Hub, the AI pipeline vector app, or the Caldova failover demo. Includes the Demo 3 preflight (Foundry embedding model and AI extensions) as a prerequisite, but does not run the Demo 3 demo itself.'
argument-hint: 'check | preflight | deploy | run | reset | local'
---

# Caldova Demo 6: Knowledge Hub

Run this specific demo rather than asking the user to repeat its configuration.
Do not delegate routine execution. Work in PowerShell from
`caldovalogistics\` unless noted. Read the
[Demo 6 runbook](../../../caldovalogistics/demo6-vector-app/README.md) before
executing anything beyond `check` or `run`.

## Known configuration

| Setting | Value |
|---|---|
| Subscription | `AzureSQL_bobward` |
| Resource group / region | `caldova-logistics-rg` / `westus3` |
| HorizonDB cluster | `caldova-logistics`, replicas `caldova-logistics-replica-1` and `caldova-logistics-replica-ha` (roles swap on each failover) |
| Foundry account / embedding alias | `caldova-logistics-ai` / `caldova-embedding` |
| App Service web app | `caldova-knowledge-hub-d1229495` (plan `caldova-knowledge-hub-d1229495-plan`, P0v3) |
| App URL | `https://caldova-knowledge-hub-d1229495.azurewebsites.net/` |
| Local files (ignored) | `.caldova-connection.json`, `pwd.env`, `.venv\` in `caldovalogistics\` |
| App database role | `knowledge_hub_app` (password `KNOWLEDGE_HUB_APP_PASSWORD` in `pwd.env`) |

These are defaults, not permission to target something else if they fail.

## Ground rules

- **Present from Azure App Service, not locally.** The App Service app is the
  demo; only it can run step 5 (failover). Do not start a local copy unless the
  user explicitly asks for `local`.
- **Open pages in the user's default browser** with `Start-Process <url>`.
  Never use the integrated/VS Code browser tools for this demo.
- Ask explicit approval before anything billable, public, or destructive:
  creating/redeploying the App Service app, `-EnableFailover`, firewall changes,
  `-ApproveProvisioning`, `-ApproveClusterRestart`, `-ApproveQueryStatsRestart`,
  `-ResetDatabase`, `-ResetArticles`, forcing a failover, or teardown.
- Never print passwords, keys, or `pwd.env` values. Scripts read them from
  `pwd.env` themselves.

## Mode selection

- "Is demo 6 ready?" / `check`: section 1 only (read-only).
- "Run the demo 6 preflight" / `preflight`: sections 1–2.
- "Deploy / build demo 6" / `deploy`: sections 1–3.
- "Run / open demo 6" / `run`: section 1, then section 4. Run preflight or
  deploy only if `check` finds a problem, and ask first.
- "Reset demo 6" / `reset`: section 5.
- "Run demo 6 locally" / `local`: section 6.

## 1. Check (read-only)

Run these and report pass/fail for each; change nothing.

```powershell
foreach ($p in '.caldova-connection.json', '.venv\Scripts\python.exe', 'pwd.env') { '{0}: {1}' -f $p, (Test-Path $p) }
Select-String -Path pwd.env -Pattern '^\s*KNOWLEDGE_HUB_APP_PASSWORD=' -Quiet
az account show --query "{name:name,user:user.name}" -o table
az horizondb firewall-rule list -g caldova-logistics-rg --cluster-name caldova-logistics --subscription AzureSQL_bobward `
  --query "[].{name:name,start:properties.startIpAddress}" -o table
(Invoke-RestMethod 'https://api.ipify.org?format=json').ip
$a = 'caldova-knowledge-hub-d1229495'; $g = 'caldova-logistics-rg'
az webapp show -n $a -g $g --query "{state:state,host:defaultHostName}" -o table
az webapp config appsettings list -n $a -g $g --query "[?name=='KNOWLEDGE_HUB_CLUSTER_ID'] | length(@)" -o tsv
$u = "https://$a.azurewebsites.net"
Invoke-RestMethod "$u/health" -TimeoutSec 180
Invoke-RestMethod "$u/api/cluster"
```

Ready means: local files exist; the `allow-azure-services` (`0.0.0.0`) rule
exists; the app is `Running`; `/health` is `ok`; `/api/cluster` reports
`failover_enabled: true`. The first request after a deploy or restart can take
2–3 minutes. A missing client-IP rule only matters for scripts run from this
machine (preflight, reset, local); the App Service app reaches HorizonDB
through the Azure-services rule.

Also confirm the walkthrough article is not left over from a rehearsal:

```powershell
$s = Invoke-RestMethod "$u/api/search?q=frozen%20CO2%20on%20passenger%20flights&mode=hybrid"
$s.results | Where-Object title -eq 'Dry ice in air shipments'
```

If it is present, offer `reset` (section 5) before the user presents, because
step 2 of the walkthrough adds that article as new.

## 2. Preflight

Run the prerequisites in order, stopping at the first failure. Each is
idempotent but **not** read-only.

1. **Parent Caldova preflight** — only when `.caldova-connection.json`,
   `.venv`, or `pwd.env` is missing, or the user asks. It always runs
   `02-add-firewall-rule.ps1` (adds a `client-<ip>` rule and ensures
   `allow-azure-services`), and also requires pgbench 17+ for Demo 5. Ask
   approval for the firewall change first:

   ```powershell
   .\scripts\00-preflight.ps1 -Subscription AzureSQL_bobward
   ```

   If the only problem is that this machine's IP is not allowed, prefer
   (with approval) `.\scripts\02-add-firewall-rule.ps1 -Subscription AzureSQL_bobward`.

2. **Demo 3 preflight (prerequisite only)** — ensures the Foundry
   `caldova-embedding` deployment, the `vector`, `pg_diskann`, `pg_textsearch`,
   `azure_ai`, and `pg_durable` extensions, and the AI pipeline parameter group.
   It (re)runs the Demo 3 sample pipeline, which makes billed embedding calls.

   ```powershell
   .\demo3-ai-pipeline\scripts\00-preflight.ps1 -Subscription AzureSQL_bobward
   ```

   If it asks for `-ApproveProvisioning` (missing Foundry resources) or
   `-ApproveClusterRestart` (parameter group not attached), stop and ask; the
   restart interrupts every Caldova demo. Do not run the Demo 3 walkthrough.

3. **Demo 6 preflight** — builds the `knowledge_hub` schema, the `on_change`
   pipeline, seed articles, the 16-part failover handbook, and the
   `knowledge_hub_app` role, checks `azure_ai` is 2.3.2+, and waits until every
   article is searchable:

   ```powershell
   .\demo6-vector-app\scripts\00-preflight.ps1
   ```

   Expect `Ready: True`, `Articles: 28/28 searchable` (12 seed + 16 handbook
   parts), and all chunks embedded. If `azure_ai` is older than 2.3.2, report
   it; the fix (`ALTER EXTENSION azure_ai UPDATE TO '2.3.2';`) has no downgrade
   path, so ask first.

## 3. Build / deploy to App Service

If section 1 shows the app exists, is running, and has failover enabled, do
**not** redeploy unless the user asks or `src/` changed since the last deploy.

Otherwise, with explicit approval (billable P0v3 plan; public app with no
sign-in; the app's identity gets Contributor on the cluster):

```powershell
.\demo6-vector-app\scripts\02-deploy-appservice.ps1 -AppName caldova-knowledge-hub-d1229495 -EnableFailover
```

Reuse this app name; do not create a second app. `-AllowedIpAddress` restricts
access but the presenter network may reach Azure from a different address, so
only add it if the user asks and then confirm they can still open the site.
After deploying, rerun the section 1 checks.

Failover needs the HA standby replica. Check it read-only before promising
step 5:

```powershell
$sub = az account show --subscription AzureSQL_bobward --query id -o tsv
az rest --method GET --uri "https://management.azure.com/subscriptions/$sub/resourceGroups/caldova-logistics-rg/providers/Microsoft.HorizonDB/clusters/caldova-logistics/pools/DefaultPool/replicas?api-version=2026-01-20-preview" `
  --query "value[].{name:name,role:properties.role,zone:properties.availabilityZone}" -o table
```

Expect one `ReadWrite` and at least one `Read` replica; which one is primary
changes after every failover. `/api/cluster` `failover_ready_in` is the number
of seconds until the next failover is allowed.

## 4. Run

Make sure section 1 passes, then open the app in the default browser:

```powershell
Start-Process 'https://caldova-knowledge-hub-d1229495.azurewebsites.net/'
```

`/` is the step-by-step walkthrough (search → add *Dry ice in air shipments* →
auto-search → search again → **⚡ Update the handbook and fail over**). `/app`
is the full app for the 5-minute demo script in the runbook. Remind the user:
one failover every 5 minutes, and the app is public with no sign-in.

To force a failover from a terminal instead of the button (asks to confirm):

```powershell
.\demo6-vector-app\scripts\03-force-failover.ps1
```

## 5. Reset articles

With approval (re-embeds changed rows; small billed embedding cost):

```powershell
.\demo6-vector-app\scripts\00-preflight.ps1 -ResetArticles
```

Then confirm `Dry ice in air shipments` no longer appears in search (section 1).
The in-app **Reset demo** button on `/app` does the same for articles.

If preflight fails with `extension "vector" is not allow-listed`, the primary
is `caldova-logistics-replica-ha`, which does not apply the cluster's parameter
group (empty `azure.extensions`, no `pgaadauth`; the parameter group itself is
correct, and a restart or re-applying it with `az horizondb update` does not
help). The extensions are already installed, so the app, pipeline, and
failover still work. Either fail back to `replica-1` with approval
(`03-force-failover.ps1`, about 15 s), or reset through the app instead, which
only calls `knowledge_hub.reset_demo()` (restores the 12 seed articles and the
16 handbook parts) and creates no extensions:

```powershell
$u = 'https://caldova-knowledge-hub-d1229495.azurewebsites.net'
Invoke-WebRequest "$u/reset" -Method Post -UseBasicParsing -MaximumRedirection 0 -SkipHttpErrorCheck
```

A `303` to `/app` means success; a redirect to `/?error=...` means it failed.
Report the allow-list mismatch to the user; do not restart the cluster, fail
over, or recreate the replica to fix it without approval.

## 6. Local (only when explicitly asked)

Local runs cannot fail over. Start it detached so an interrupted tool call does
not kill it, verify, then open it in the default browser:

```powershell
.\demo6-vector-app\scripts\01-run-local.ps1 -Port 8020   # run with detach
Invoke-RestMethod http://127.0.0.1:8020/health
Start-Process 'http://127.0.0.1:8020/'
```

Tell the user the process ID and stop it when they are done.

## After the event

Not part of the default modes; mention it and ask before running anything:
remove the web app's Contributor role assignment on the cluster, remove the
extra HA replica (doubles compute cost; Azure portal → High availability →
Disabled), and optionally run
`.\demo6-vector-app\scripts\99-teardown.ps1 -AppName caldova-knowledge-hub-d1229495`
(drops the Knowledge Hub schema, pipeline, and role, and deletes the app and plan).
