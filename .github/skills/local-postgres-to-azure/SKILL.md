---
name: local-postgres-to-azure
description: 'Provision Azure Database for PostgreSQL Flexible Server and migrate a local PostgreSQL database using Azure CLI, pg_dump, and pg_restore. Use when asked to migrate the local campsite database to Azure, move local PostgreSQL to the cloud, or verify a PostgreSQL migration. Requires explicit approval before Azure changes; does not deploy an application.'
---

# Local PostgreSQL to Azure

## Scope

For this repository's specific campsite demo, use
[campsite-demo](../campsite-demo/SKILL.md) for known target defaults, preflight,
and approval-gated client-IP refresh before following this migration procedure.

Move the database, not an application. This repository's database-only demo is
in `campsites/`. Use the steps below for provisioning and standard PostgreSQL
dump/restore. Do not substitute the managed migration service without approval:
that service requires network access from Azure to the source, whereas this
workflow connects outward from the laptop. Never expose local PostgreSQL publicly.

Use PowerShell on Windows. Consult current Microsoft Learn documentation and
`az ... --help` before executing Azure commands; CLI flags and regional support
can change. Do not install or upgrade tooling without checking what exists.

## 1. Inspect and verify the source

- Confirm the source host, port, database, and user. For this demo they are
  `localhost`, `55432`, `campsites`, and `campsite_admin`.
- Run `campsites\scripts\local.ps1 -Action Verify`, then `-Action Demo`.
  If the database is not running, ask before starting Docker or using another
  PostgreSQL instance. Do not change the user's existing databases.
- Query `server_version` and `pg_extension` for actual versions. Record database
  size, campsite and reservation counts, and a deterministic data fingerprint.
- Inventory extensions, roles, ownership, privileges, collations, and tablespaces.
  Never assume local superuser access is available in Flexible Server.
- Check `az account show`, `psql --version`, `pg_dump --version`, and
  `pg_restore --version`. Use compatible clients, at least the target major
  version. This demo REQUIRES exact source/target PostgreSQL major and minor
  equality: compare `SHOW server_version_num` from both running servers before
  dumping, and again before restoring. Stop on a mismatch. Azure manages minor
  updates, so a previous check or the documentation is not sufficient.
  Pin the local image by digest and assert its expected version at startup.
  Preserve old volumes when preparing a new major version; never attach an
  older PostgreSQL data directory to a newer major-version image.
- Do not print credentials, access tokens, local password files, or connection
  strings containing secrets. No secrets in source control, chat, or CLI arguments.

## 2. Plan and get approval

Ask for missing subscription, resource group, region, globally unique server
name, database name, administrative identity, budget/SKU, and network policy.
Offer reusing an existing Flexible Server rather than assuming a new one.

Show subscription name AND ID, region, resource group, PostgreSQL version,
compute/storage SKU, estimated recurring cost with assumptions, authentication,
network exposure, and resources to create or change. Confirm compatible PostGIS,
pg_trgm, and btree_gist versions using Microsoft's extension matrix. If local
extensions are newer than the target supports, stop and resolve compatibility.

Ask explicit approval before provisioning, altering firewall/allowlist/auth
settings, granting privileges, or writing into a cloud database. Approval to
create files is NOT approval to spend money or migrate data.

For public access, scope the migration firewall rule to the approved client IP.
Do not enable `0.0.0.0`/AllowAzureServices or a broad IP range. Private access
requires a working local route and DNS. Require TLS certificate verification.
Do not change any existing rule or Entra administrator without approval.

## 3. Provision or prepare the approved target

Use Azure CLI (`az postgres flexible-server create`, `db create`, `parameter
set`, and the relevant Entra/network commands) or approved Bicep. Specify the
subscription explicitly. Do not rely on the current default subscription.
Validate the chosen CLI syntax and configuration before execution.

Use Entra authentication where possible. For an Entra database connection, obtain
a token with `az account get-access-token --resource-type oss-rdbms`, keep it only
in process memory, and set `PGPASSWORD` for the client process. The connecting
Entra role must already be configured on PostgreSQL. Refresh expired tokens.
If another credential is required, use an approved secret store or interactive
secure input; do not request a plaintext password in chat.

Allowlist `postgis`, `pg_trgm`, and `btree_gist` through `azure.extensions`.
Preserve existing allowlist entries. Verify `pg_available_extensions` and
permission to create extensions before restoring.

Restore only into an approved EMPTY database. Check for application tables and
stop if present. Do not use `--clean`, drop a database, or overwrite data.
Do not blindly copy local roles, passwords, superuser attributes, or ownership.

## 4. Migrate from the laptop

Agree on a maintenance window; stop source writers for the final copy. A
`pg_dump` snapshot is consistent, but later source writes are NOT replicated.
For this tiny demo, an offline move is sufficient. Record dump/restore duration.

Use a custom-format database dump (`pg_dump --format=custom`) and restore it
with `pg_restore --no-owner --no-acl --exit-on-error --single-transaction`.
Use the actual source and target database names. Include the complete database
objects needed by the application, including extensions, indexes, constraints,
generated columns, and identity sequences. For the container source, execute
`pg_dump` inside its container and use `docker compose cp` to copy the archive
to the ignored `campsites\.local\` folder. Never pipe binary archives through
PowerShell text pipelines.

Run `pg_restore` locally against the Azure hostname. Use `PGSSLMODE=verify-full`
and a trusted root certificate store/bundle supported by the installed libpq.
Do not weaken TLS if verification fails; fix trust configuration.

Check every native command's exit code. Preserve and restore previous process
environment variables in `finally`. On errors stop, report the failed stage, and
keep the source intact. A failed restore is not success. Do not automatically
retry destructive steps or expose credential-bearing command output.

## 5. Verify and hand off

- Compare source and destination counts and deterministic data fingerprints.
  Serialize geography with `ST_AsEWKB`, JSONB as text, and order rows by primary
  key; compare reservation business data and identity sequence state as well.
- Execute `campsites\sql\04-verify.sql` on the target with
  `psql -X -v ON_ERROR_STOP=1`. This checks behavior inside a rolled-back
  transaction, so obtain permission for its temporary test writes first.
- Execute `campsites\sql\03-demo.sql` and confirm exactly six combined
  spatial/full-text/JSONB results and the typo-tolerant name match.
- Verify extension versions, indexes, the exclusion constraint, and identities.
  A restored row count alone is not sufficient.
- For a concurrency demonstration use two sessions with overlapping date ranges
  for the same campsite. The second must wait for the first transaction and fail
  with SQLSTATE `23P01` after the first commits. Adjacent stays must succeed.
  Use agreed test dates and remove only the specifically created test bookings.
- Report actual measured migration duration, checks passed/failed, target
  hostname/database (no credentials), and any remaining work.
- Keep the local source available. Ask before deleting archives, removing the
  temporary client firewall rule, or deleting Azure resources. Do not switch
  applications, grant a future App Service identity, or claim an application
  migration occurred; those are separate tasks requiring approval.

## References

- [Demo setup and presenter instructions](../../../campsites/README.md)
- [Azure CLI provisioning](https://learn.microsoft.com/cli/azure/postgres/flexible-server)
- [Dump and restore](https://learn.microsoft.com/azure/postgresql/migrate/how-to-migrate-using-dump-and-restore)
- [Supported extensions](https://learn.microsoft.com/azure/postgresql/extensions/concepts-extensions-by-engine)
- [Azure CLI managed migrations](https://learn.microsoft.com/cli/azure/postgres/flexible-server/migration)
