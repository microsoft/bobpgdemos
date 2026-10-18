---
name: campsite-demo
description: 'Run this repository''s specific campsite PostgreSQL portability demo. Use when asked to run the campsite demo, campsite preflight, pre-flight, refresh the campsite demo client IP, prepare the campsite migration demo, or demonstrate local PostgreSQL to Azure Flexible Server. Checks exact engine and extension versions, uses Entra and verified TLS, and gates firewall changes and migrations separately.'
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

## 1. Preflight (also called pre-flight)

Run:

```powershell
.\campsites\scripts\00-preflight.ps1
```

This is read-only by default and uses PostgreSQL clients inside the existing
container. It checks Azure login/server state, local seeded data, current public
IPv4, one named firewall rule, an Entra SQL login with certificate-verified TLS,
exact major/minor engine equality, and availability/allowlisting of the local
extension versions. It returns `Ready` only when these checks pass.

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

For "local" mode, run only these commands, without Azure/firewall changes:

```powershell
.\campsites\scripts\local.ps1 -Action Verify
.\campsites\scripts\local.ps1 -Action Demo
```

For the full demo, execute them after preflight. Explain briefly: 30 fictional
campsites; PostGIS + full-text + JSONB yields exactly six results, pg_trgm handles
the misspelling, and an exclusion constraint protects bookings. Do not claim
performance gains from this tiny dataset.

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
the rolled-back cloud checks in `04-verify.sql`; they perform temporary writes.
Compare source/target fingerprints, counts, identities, engine and extension
versions, and run the same search SQL on Azure. Use the runbook's two-session
booking procedure with explicit permission for those bookings and cleanup.

Finish with measured migration duration and explicit pass/fail/not-run statuses.
Keep the narrative to 4-5 minutes after setup. Never claim the app is deployed:
this skill currently demonstrates the database only.
