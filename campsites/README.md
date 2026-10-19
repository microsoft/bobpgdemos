# Find your next escape: PostgreSQL portability

A PostgreSQL portability demo: 30 **fictional** campsites near real Washington
locations, three seeded reservations, and standard open-source PostgreSQL features.
The core local database walkthrough requires no app, AI model, large dataset,
or Azure resource. An optional [web app](./app/README.md) adds browser search,
availability, interactive PostGIS maps, and fictional booking creation against
the migrated Azure database. Its **Debug** button opens a live SQL sidebar,
hidden by default, showing the queries and bound parameters behind each action.

**Live app:** [Find your next escape](https://app-campsites-dev-a59e.azurewebsites.net).
It runs on Azure App Service Premium P1v3 with always-on, health checks, and a
[staging slot](https://app-campsites-dev-a59e-staging.azurewebsites.net). Both use
managed identity to access the migrated database. Bookings are fictional but
persist in the shared demo database; use aliases, not personal information.

## Prerequisites

- Docker Desktop with the Linux engine running, Docker Compose, and PowerShell.
- Port **55432** available. The demo leaves native PostgreSQL on 5432 alone.
- The first start downloads a digest-pinned `postgis/postgis:18-3.6` image
  containing **PostgreSQL 18.6**; do this before presenting.
- For cloud migration: Azure CLI, an approved Azure subscription/target, and
  compatible PostgreSQL client tools. Provision Azure separately before the demo.

## Start and verify

From the repository root:

```powershell
.\campsites\scripts\local.ps1 -Action Start
.\campsites\scripts\local.ps1 -Action Demo
.\campsites\scripts\local.ps1 -Action Verify
.\campsites\scripts\local.ps1 -Action RoundTrip
```

`Start` generates a random local password in ignored `.local\.env`, starts the
container, waits for readiness, and runs behavior checks. The password file is
plaintext local development material: protect it with your user account, do not
share it, and never commit it. The listener binds to loopback only.

Connect from the VS Code PostgreSQL extension:

| Setting | Value |
|---|---|
| Host | `localhost` |
| Port | `55432` |
| Database | `campsites` |
| User | `campsite_admin` |
| Password | Value in `.local\.env` |
| SSL | Disabled for this loopback-only development container; required for Azure |

Data persists in the project's Docker volume. Initialization runs **only on a
new volume**; restart is not a reseed. A failed initialization must be diagnosed,
not silently ignored. Stop without removing data:

```powershell
.\campsites\scripts\local.ps1 -Action Stop
```

No script drops the source database or deletes the volume. `RoundTrip` makes a
custom-format dump, restores into a uniquely named temporary database, verifies
it, and cleans up only that temporary database and archive.

The PostgreSQL 18 project is `bobpg-campsites-pg18`. The previous PostgreSQL 17
container is stopped and its `bobpg-campsites_data` volume is retained unchanged.
The new database is separately seeded, not an in-place upgrade of the old volume.
PostgreSQL 18 uses the image's `/var/lib/postgresql` volume layout.

## Exact version requirement

The local scripts require `server_version_num = 180006` (PostgreSQL **18.6**).
The image digest prevents a floating tag from silently changing that version.
The Azure control plane reports **18.6** for `bobward-campsites-pg18` in
`centralus`. Before migration, query `SHOW server_version_num` over a verified
TLS connection on Azure and compare it with the local value. Do not migrate
until both are verified equal. Azure minor updates are managed, so recheck
before every demonstration and intentionally repin/retest locally if needed.

## Demo preflight and changing client IPs

Run this at the start of each demo session, on this laptop or a Dev Box:

```powershell
.\campsites\scripts\00-preflight.ps1
```

Preflight is **read-only by default**. It checks the running local database,
Azure server and Entra authentication configuration, current outbound IPv4,
firewall rule, verified-TLS SQL access, exact engine version, and version
availability/allowlisting for every installed non-core source extension, not
just the three used by the search demo. It uses the existing container's PostgreSQL
clients, so no separate host client installation is required. Tokens stay in
process memory and the previous `PGPASSWORD` is restored on success or error.

After approving the displayed target and new IP, refresh one managed rule:

```powershell
.\campsites\scripts\00-preflight.ps1 -RefreshFirewall
```

The stable name `campsites-demo-client` is reused on every run: a new IP replaces
the previous IP instead of accumulating rules. It never allows all IPs or all
Azure services. Use `-RefreshFirewall -WhatIf` to preview without changing Azure;
a preview does not test cloud SQL or report readiness. Azure firewall rule
write permission is required, separately from the Entra database role.

For the one-time transition from the original provisioning rule, inspect current
rules and explicitly approve its removal, then run:

```powershell
.\campsites\scripts\00-preflight.ps1 -RefreshFirewall `
    -RetireFirewallRuleName 'FirewallIPAddress_2026-10-18_9-53-50'
```

Only that named single-IP legacy rule is removed, after the managed replacement
is verified. Other rules are preserved and reported. Allow several minutes for
firewall propagation if necessary, then rerun read-only preflight.

A preflight failure is a blocker, not a reason to weaken TLS or ignore a version
difference. No preflight command provisions a server, migrates data, resets a
database, installs extensions, or deploys an app. A nonempty target is reported:
it must not be overwritten during the migration demo.

### Preflight regression tests

With the existing Windows PowerShell Pester installation:

```powershell
powershell.exe -NoProfile -Command '& {
    Import-Module Pester
    $result = Invoke-Pester .\campsites\tests\preflight.Tests.ps1 -PassThru
    if ($result.FailedCount -gt 0) { exit 1 }
}'
```

Tests mock Azure CLI, Docker, and IP detection: they do not modify Azure or
require an active database connection. They cover read-only and refresh paths,
same-IP no-ops, `-WhatIf`, legacy-rule retirement, invalid IPs, engine/extension
differences (including additional extensions included in a full dump), TLS
enforcement, and credential restoration on errors.

Target: `bobward-campsites-pg18.postgres.database.azure.com`, database
`campsites`, Entra administrator `bobward@microsoft.com`, resource group
`campsites-demo-rg`, subscription `0efc44aa-c965-420f-aac4-fff305dbcc97`.
No application or cloud data migration is included in target provisioning.

Migration checkpoint (2026-10-18): the approved `pg_dump`/`pg_restore` migration
completed over certificate-verified TLS with Entra authentication. Local and
Azure engines both reported PostgreSQL **18.6**. Azure now contains the migrated
database; it is **not empty** and must not be overwritten for a repeat demo.
The local source remains available and unchanged by dump/restore.

The first restore failed because the local PostGIS image includes additional
extensions beyond those used in the search demo. Its single transaction rolled
back completely, and the target was verified empty before retrying. With explicit
approval, the existing allowlist was extended to include `fuzzystrmatch`,
`postgis_tiger_geocoder`, and `postgis_topology`. Preflight now checks all
installed non-core extensions so this condition blocks migration earlier.

All six source/target extension versions matched: PostGIS, PostGIS topology,
and PostGIS TIGER geocoder **3.6.4**; fuzzystrmatch **1.2**; pg_trgm **1.6**;
and btree_gist **1.8**. Actual Azure SQL results, not documented defaults, were
used to verify compatibility.

Successful run timings: dump/archive copy **3.286 seconds**, restore **9.824
seconds**, and dump through restore including intervening checks **20.416
seconds**. These are measured rehearsal results, not a guaranteed duration.
The ignored `.local\` folder retains the archives and timestamped migration
records.

Verification passed for 30 campsites, three reservations, deterministic data
fingerprints, extension versions, indexes, constraints, generated/identity
columns, and sequence definitions/state immediately after restore. The same
Azure queries returned six combined-search matches and the expected typo match.
Rolled-back booking checks passed; they advance the reservation identity
sequence even though row changes roll back. Final data fingerprints still
matched, and sequences remained safe for future inserts. The two-session
booking race was not run. No application was deployed, and no VPN was configured.

The managed single-client-IP rule is current. The separately configured Dev Box
and user-intended Allow Azure services rules were preserved.

## What PostgreSQL demonstrates

- **PostGIS:** geography distances and a spatial GiST index.
- **Full-text search:** weighted generated `tsvector` and a GIN index.
- **JSONB:** flexible amenities and indexed containment.
- **pg_trgm:** name search that tolerates `Lake Samamish Heron`.
- **Transactions and btree_gist:** an exclusion constraint prevents overlapping
  date ranges for a campsite, even across competing sessions.

With only 30 rows the planner may prefer sequential scans. This is a
functionality/portability demo, **not** a performance benchmark.

Dates in the seed and examples are fixed in July/August 2030 for repeatability.
Reservations use `[arrival, departure)` so checkout-day arrivals are valid.
`04-verify.sql` rolls back its test row changes, including temporary deletes.
PostgreSQL identity sequences are not transactional: test inserts can advance
the reservation sequence despite rollback.

## Two-session booking demonstration

Use two query sessions connected to the same database.
First ensure neither example booking already exists; if it does, choose different
dates or remove only your known demo bookings with explicit approval.

Session A:

```sql
BEGIN;
INSERT INTO escape.reservation (campsite_id, guest_name, stay)
SELECT campsite_id, 'Demo session A', daterange('2030-08-10', '2030-08-12', '[)')
FROM escape.campsite WHERE name = 'Lake Sammamish Heron';
-- Leave this transaction open while session B runs.
```

Session B:

```sql
INSERT INTO escape.reservation (campsite_id, guest_name, stay)
SELECT campsite_id, 'Demo session B', daterange('2030-08-11', '2030-08-13', '[)')
FROM escape.campsite WHERE name = 'Lake Sammamish Heron';
```

B waits. Execute `COMMIT;` in A: B must fail with exclusion violation
(`23P01`). If A rolls back instead, B can succeed. Reset only these known demo
bookings after the demonstration; do not truncate the reservations table.

## Migrate with a VS Code skill

For this specific demo, use
[campsite-demo](../.github/skills/campsite-demo/SKILL.md). Example prompts:

> Run the campsite demo preflight.

> Run the campsite migration demo.

Or invoke `/campsite-demo preflight` in a skill-enabled VS Code chat. The skill
knows this demo's target, runs the checks, requests approval for an IP refresh
when necessary, and separately gates migration and cloud test writes.

For just the local walkthrough, prompt:

> Run the local campsite demo.

Or invoke `/campsite-demo local`. This verifies the local database, then runs
and explains the six-match campsite search, typo-tolerant name search, and
availability query. It does not access Azure, change firewall rules, or migrate
data. If the container needs starting, the skill asks approval first.

To hear the walkthrough without running commands, prompt:

> What is the local campsite demo?

The reusable migration skill is
[local-postgres-to-azure](../.github/skills/local-postgres-to-azure/SKILL.md).
In a skill-enabled VS Code chat, use `/local-postgres-to-azure` or:

> Migrate my local campsite PostgreSQL database to Azure Flexible Server.
> Verify the data and queries. Do not deploy an application.

The skill confirms subscription, region, cost, authentication, and networking,
and asks for explicit approval before Azure changes. It uses **Azure CLI** to
prepare the target and **pg_dump/pg_restore** to transfer the database outward
from the laptop. It does not expose the laptop to incoming cloud connections.
This is an agent workflow, not an unattended provisioning script.

Use exactly matching PostgreSQL major/minor releases and compatible extension versions.
Allowlist `postgis`, `pg_trgm`, and `btree_gist` on Flexible Server. Cloud roles
and ownership are configured separately rather than copied from the local
superuser. Azure connections must verify TLS certificates.

## Five-minute presentation

1. **Local (1 minute):** show the 30 rows and execute `03-demo.sql`.
2. **Move (1 minute target, measure first):** dump/restore into an already
   provisioned empty Flexible Server database using the skill.
3. **Verify (1 minute):** compare data and execute the same verification/search
   SQL on Azure.
4. **Correctness (1 minute):** race the two SQL sessions.
5. **Close:** same open-source PostgreSQL objects, now on a managed Azure service.

Pre-provision Azure, download the image, establish authentication, and time the
actual migration before presenting. This setup does not yet include an App
Service application.
