# Campsite demo session handoff

Saved 2026-10-18 for moving this repository to another development machine.
This is a continuation summary, not a complete chat transcript.

## Goal and agreed scope

Build a 4-5 minute demo of open-source PostgreSQL portability:

1. Build a small campsite database locally using free PostgreSQL.
2. Migrate it to Azure Database for PostgreSQL Flexible Server using standard
   `pg_dump` / `pg_restore`, orchestrated by a VS Code skill.
3. Eventually deploy a React/Node.js campsite app to Azure App Service.

Only the database is needed locally, not a local app. Use 30 curated fictional
campsites; do not build a large dataset or make performance claims.
Require **exact PostgreSQL major/minor equality** locally and on Azure, verified
through SQL before migration. Preserve source data and old Docker volumes.

## Repository deliverables

- [Demo README](./README.md): setup and presenter instructions.
- [Compose configuration](./compose.yaml): digest-pinned PostgreSQL 18.6 image.
- [Local operations](./scripts/local.ps1): Start, Stop, Verify, Demo, RoundTrip.
- [Preflight](./scripts/00-preflight.ps1): read-only readiness checks by default;
  approved refresh of one stable single-IP firewall rule.
- [Schema](./sql/01-schema.sql), [seed](./sql/02-seed.sql),
  [search demo](./sql/03-demo.sql), [verification](./sql/04-verify.sql).
- [Preflight tests](./tests/preflight.Tests.ps1): 14 mocked regression tests,
  passing in Windows PowerShell 5.1 and PowerShell 7 with existing Pester 3.4.
- [Specific demo skill](../.github/skills/campsite-demo/SKILL.md).
- [Reusable migration skill](../.github/skills/local-postgres-to-azure/SKILL.md).

Prompt to resume:

> Read campsites/SESSION-HANDOFF.md, then run the campsite demo preflight.
> Do not migrate or overwrite data until I approve.

## Local state on the original laptop

- Running Compose project: `bobpg-campsites-pg18`.
- Endpoint: `localhost:55432`, database `campsites`, user `campsite_admin`.
- Actual engine: PostgreSQL **18.6**, `server_version_num=180006`.
- Actual extensions: PostGIS **3.6.4**, pg_trgm **1.6**, btree_gist **1.8**.
- 30 campsites and three seeded reservations.
- Verified six combined spatial/full-text/JSONB search results, typo-tolerant
  name search, overlapping/empty booking rejection, adjacent stay acceptance,
  and custom-format dump/restore into a temporary database.
- A live two-session booking race has not been verified.
- Previous PostgreSQL 17.5 container is stopped; its
  `bobpg-campsites_data` volume was preserved.
- Native PostgreSQL 17 on port 5432 was not modified.
- Docker Desktop initially hung; recovery stopped only Docker processes,
  terminated only its `docker-desktop` WSL distribution, and relaunched Docker.

Local credentials are generated into ignored `.local/.env`. Do not commit,
paste, or transfer credentials as part of this handoff. A new machine can
regenerate the tiny seeded database with `local.ps1 -Action Start`.
Docker volumes do not move with a Git clone.

## Azure target

| Setting | Value |
|---|---|
| Subscription | AzureSQL_bobward |
| Subscription ID | `0efc44aa-c965-420f-aac4-fff305dbcc97` |
| Resource group | `campsites-demo-rg` |
| Region | `centralus` |
| Server | `bobward-campsites-pg18` |
| Hostname | `bobward-campsites-pg18.postgres.database.azure.com` |
| Database | `campsites` |
| Port | `5432` |
| Entra administrator | `bobward@microsoft.com` |
| Authentication | Entra enabled; password authentication disabled |
| Control-plane engine version | PostgreSQL **18.6** |
| Initial storage / backups | 32 GiB Premium SSD, seven days, no HA |

East US and East US 2 were restricted for this subscription. Central US had
PostgreSQL 18 capability and was approved.

Initially provisioned as Burstable Standard_B1ms. **The user subsequently
changed compute from burstable to "standard" before moving the repository.**
Do not revert that change. Query the actual SKU/state and obtain current pricing;
the earlier approximately $18.20/month estimate applied ONLY to the old B1ms
configuration and is no longer a reliable current estimate.
At handoff, Azure reported `state=Updating` and still displayed the old
`Standard_B1ms` / `Burstable` SKU. The compute transition is not yet confirmed
complete; wait for Ready and inspect the final SKU before connection testing.

Extensions `postgis`, `pg_trgm`, and `btree_gist` were allowlisted. The Azure
database was created but **no source data has been migrated**.
Actual SQL-level Azure engine/extension versions have not been queried
successfully. Documentation listed PostGIS 3.6.1, versus local 3.6.4:
resolve actual version compatibility before restoring.

## Firewall and connection investigation

Last verified rules:

| Rule | Single public IPv4 |
|---|---|
| `campsites-demo-client` | `66.169.187.67` (laptop) |
| `campsites-demo-devbox` | `40.117.66.43` (Dev Box) |

The original provisioning rule for `75.104.94.152` was explicitly retired after
verifying its replacement. No broad ranges or AllowAzureServices rule were
created. Private Dev Box address `10.6.3.134` is NOT the public firewall address.
Detect current outbound public IP on the machine actually making the connection.

Preflight reuses `campsites-demo-client`; it preserves and reports other rules,
including the Dev Box rule. Refresh requires explicit approval. Do not delete
another machine's rule without approval.

Observed failure:

> server closed the connection unexpectedly

- Correct hostname resolves to `130.131.240.209` on the original laptop;
  always use the hostname, not a pinned IP.
- TCP 5432 opens, but a credential-free PostgreSQL SSLRequest was forcibly
  closed before TLS negotiation.
- Native Windows psql, container psql, and VS Code PostgreSQL extension all failed.
- Verified-TLS direct negotiation also failed.
- User reported the Dev Box also failed after its public IP was allowed.
- User can connect to another PostgreSQL server
  `bwpgsqlserver.postgres.database.azure.com` from the Dev Box, and to HorizonDB
  from the original client. The working PostgreSQL server was not found in the
  currently selected subscription.
- An initial extension DNS error was caused by entering `campsites-g18`
  instead of `campsites-pg18`; correcting that typo exposed the same disconnect.
- Resource Health reported Available and the server Ready.
- Entra enabled, password auth disabled, and the Entra administrator were
  confirmed live through Azure CLI.
- A user-approved targeted Flexible Server restart completed, returned Ready,
  and did NOT resolve the connection.
- The compute change has not yet been followed by a confirmed successful SQL
  test. It may or may not affect the failure; do not claim a root cause.

**Root cause is unconfirmed.** Do not attribute the generic client message to
a confirmed server crash, Entra failure, Docker problem, or local port block.
Never disable TLS verification or open broad firewall access to get past it.

## Next actions on the new machine

1. Confirm the repo includes the uncommitted campsite/skill files; cloning the
   remote alone does not include untracked work. Do not discard unrelated work.
2. Sign in to Azure, inspect current server state/SKU after the user's compute
   change, and detect the new machine's public outbound IPv4.
3. Approve any required exact-IP firewall update before execution. A direct
   extension connectivity test does NOT require local Docker.
4. Retry the extension using the exact hostname above, Entra user, database,
   and certificate-verified TLS. Capture exact error and UTC time.
5. If the failure persists across allowed independent client paths after the
   compute change, collect Azure-side evidence and escalate through Azure support.
   Do not repeat unchanged client tests indefinitely.
6. Once SQL connects, compare exact engine versions and actual available
   extension versions. Resolve PostGIS alignment without deleting source data.
7. Obtain separate migration/test-write approval, rehearse dump/restore into
   the empty approved target, compare data fingerprints/counts/identities,
   run queries and booking tests, and measure actual duration.
8. Only then build the App Service application as a separate task.

No App Service app, application managed identity, or cloud data migration has
been deployed. Approval to refresh a firewall is not migration approval.
Keep tokens in process memory, never in CLI arguments, logs, chat, or Git.
