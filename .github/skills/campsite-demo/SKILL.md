---
name: campsite-demo
description: 'Run or explain this repository''s specific campsite PostgreSQL portability demo. Use when asked to run the campsite demo, run the local campsite or campsites demo, explain the local demo, find your next escape, run campsite preflight or pre-flight, refresh the campsite demo client IP, prepare the campsite migration demo, or demonstrate local PostgreSQL to Azure Flexible Server. Local mode demonstrates PostGIS, full-text search, JSONB, typo tolerance, and availability without Azure access. Cloud mode checks exact versions, uses Entra and verified TLS, and gates firewall changes and migrations separately.'
argument-hint: 'preflight | local | migrate | verify'
---

# Campsite demo

Run this specific database-only demo, rather than asking the user to repeat its
configuration. Do not delegate routine execution. Work in PowerShell from the
repository root. Read the [runbook](../../../campsites/README.md) before executing.

## Known configuration

| Setting | Value |
|---|---|
| Subscription | AzureSQL_bobward / `0efc44aa-c965-420f-aac4-fff305dbcc97` |
| Resource group / region | `campsites-demo-rg` / `centralus` |
| Flexible Server | `bobward-campsites-pg18` |
| Database / Entra user | `campsites` / `bobward@microsoft.com` |
| Local endpoint | `localhost:55432`, user `campsite_admin` |
| Managed client firewall rule | `campsites-demo-client` |
| Local engine pin | PostgreSQL 18.6 (`180006`); verify against actual Azure SQL |

These are defaults, not permission to access a different target if they fail.
Do not deploy an app, provision resources, start/restart Docker Desktop, reset
data, or change authentication/allowlists without explicit approval. A plain
"run the demo" means preflight, local search demonstration, and a migration
approval gate, not permission to overwrite cloud data.

## Prompt examples and mode selection

- "Run the local campsite demo" or `/campsite-demo local`: go directly to
  section 2. Do not run Azure preflight, access Azure, or migrate data.
- "What is the local campsite demo?": explain the section 2 walkthrough
  without executing commands.
- "Run the campsite demo preflight" or `/campsite-demo preflight`: run
  section 1 only.
- "Run the campsite migration demo" or `/campsite-demo migrate`: run
  preflight, then follow section 3 with separate migration approval.

## 1. Preflight (also called pre-flight)

Run:

```powershell
.\campsites\scripts\00-preflight.ps1
```

This is read-only by default and uses PostgreSQL clients inside the existing
container. It checks Azure login/server state, local seeded data, current public
IPv4, one named firewall rule, an Entra SQL login with certificate-verified TLS,
exact major/minor engine equality, and availability/allowlisting of the local
extension versions. Inventory every installed non-core extension included by
`pg_dump`, not only the three used by the search demo. The local image also
installs `fuzzystrmatch`, `postgis_tiger_geocoder`, and `postgis_topology`; these
require matching Azure versions and allowlisting for a full database restore.
Ask explicit approval before adding any missing allowlist entries, preserving
all existing entries. It returns `Ready` only when these checks pass.

If the local container is stopped or not initialized, ask approval to run:

```powershell
.\campsites\scripts\local.ps1 -Action Start
```

If the IP rule needs refresh, show the subscription, server, old IP/rule, and
new public IP, then ask approval to replace the managed rule with that ONE IP:

```powershell
.\campsites\scripts\00-preflight.ps1 -RefreshFirewall
```

To preview without writes, append `-WhatIf`. The script never creates a broad
range or AllowAzureServices rule. Reuse the same name on every refresh; do not
accumulate IP rules.

One-time transition: provisioning originally created
`FirewallIPAddress_2026-10-18_9-53-50`. Inspect current rules first. If it still
exists, ask separate explicit approval to retire that named single-IP rule as
part of the refresh, then add:

```powershell
-RetireFirewallRuleName 'FirewallIPAddress_2026-10-18_9-53-50'
```

The replacement is verified before the old rule is deleted. Never delete other
users' rules. Other rules are reported and preserved. If rule propagation delays
SQL access, wait briefly and rerun read-only preflight; do not broaden access.

For a different signed-in administrator use the explicit `-EntraUser` override
only after confirming the role exists on the target. Never print a token or
password, use credential-bearing command arguments, or weaken TLS to connect.

If engine/extension versions differ, stop before migration. Inspect actual
Azure `pg_available_extension_versions`, not just documentation. In particular,
the initial local PostGIS was 3.6.4 and the documented Azure default was 3.6.1.
Preserve old volumes when building a matching local environment. Do not claim
preflight passed when only connectivity or control-plane checks succeeded.

## 2. Demonstrate locally

The local demo is PostgreSQL in Docker at `localhost:55432`, not a website or
application. It uses 30 fictional campsites near real Washington locations and
three seeded reservations.

For "local" mode, run only these commands in order, without Azure access or
firewall changes. Stop and report the error if verification fails; do not
continue to the search demo or silently reseed data. If the database is not
configured or the container is stopped, ask approval to run `-Action Start`
as described in section 1, then retry.

```powershell
.\campsites\scripts\local.ps1 -Action Verify
.\campsites\scripts\local.ps1 -Action Demo
```

`Verify` runs local behavior checks with rolled-back row changes; identity
sequences can still advance because PostgreSQL sequences are not transactional.
`Demo` runs the three read-only queries in
[03-demo.sql](../../../campsites/sql/03-demo.sql). For the full demo, execute
these commands after preflight.

Narrate the query results briefly:

1. **Find your next escape:** "Find a pet-friendly lakeside campsite for four,
   with kayaking, within 45 km of Seattle." PostGIS filters geographic distance,
   full-text search matches `lake kayaking`, JSONB filters pet-friendly and
   kayak-rental amenities, and capacity must be at least four. Expect exactly
   six matches ordered by distance, then name.
2. **Handle a typo:** search for `Lake Samamish Heron`. The `pg_trgm` similarity
   search finds the intended `Lake Sammamish Heron` despite the misspelling,
   returning up to three candidates with similarity scores.
3. **Check availability:** show up to five campsites without overlapping
   reservations for July 11-13, 2030. Explain that `[arrival, departure)` ranges
   permit checkout-day arrivals.

Report actual results and verification pass/fail; if the first query does not
return six matches, report the discrepancy instead of claiming success.
Distinguish the availability query from booking protection: verification checks
the exclusion constraint, but `Demo` does not run the two-session booking race.
Use the runbook's separate two-session procedure only when requested, with
explicit permission for the bookings and cleanup.

Close with the portability story: these same PostgreSQL features and queries
can move to Azure Database for PostgreSQL without rewriting them. Local mode
does not prove a migration occurred; report Azure checks and migration as
not run. Do not claim performance gains from this tiny dataset.

## 3. Migrate only after approval

Load the [migration workflow](../local-postgres-to-azure/SKILL.md) and follow its
dump/restore, source snapshot, TLS, fingerprint, sequence, and verification steps.
The Azure target is already provisioned: do not create another one.

Before any restore or target verification with test writes, present the exact
source/target, maintenance window, expected test writes, and whether the target
is empty. Obtain explicit migration approval. Preflight/firewall approval is
NOT migration approval. If the target has application tables, stop and ask
whether to verify the existing demo instead; never drop, clean, or overwrite it.

Rerun preflight immediately before migrating. Use the source container's PG18
clients (not older host pg_restore) and a custom-format archive stored in ignored
`campsites\.local\`. Do not pipe binary archives through PowerShell. If a migration
stage fails, stop and report it; leave the source intact.

## 4. Verify and present

For "verify" mode, run read-only preflight first. Ask permission before executing
the rolled-back cloud checks in `04-verify.sql`; they perform temporary row writes
and can advance identity sequences despite rollback. Compare sequence state
immediately after restore, then confirm that verification leaves row
fingerprints unchanged and sequences safe for future inserts. Do not reset
sequences merely to hide expected verification advances.
Compare source/target fingerprints, counts, identities, engine and extension
versions, and run the same search SQL on Azure. Use the runbook's two-session
booking procedure with explicit permission for those bookings and cleanup.

Finish with measured migration duration and explicit pass/fail/not-run statuses.
Keep the narrative to 4-5 minutes after setup. Never claim the app is deployed:
this skill currently demonstrates the database only.
