# Find your next escape

A responsive, fictional Washington campsite demo showcasing PostgreSQL geography, full-text search, JSONB, typo tolerance and date-range availability.

## Live demo

- [Open the campsite app](https://app-campsites-dev-a59e.azurewebsites.net)
- [Open staging](https://app-campsites-dev-a59e-staging.azurewebsites.net)

Both deployments connect to the migrated Azure PostgreSQL database using managed
identity and verified TLS, without a stored database password. Search, typo lookup,
availability, and fictional bookings are enabled. Use demo aliases only, never
personal information. Bookings persist and affect availability in both deployments.

Final deployment checks passed: all 12 tests, including real Azure database
integration; live overlapping-booking rejection and checkout-day arrival; browser
search, typo lookup, booking dialog, and narrow-screen layout. The live booking
smoke test removed only its own uniquely identified test bookings.

## Local development

Requires Node.js 24+, npm, and Azure CLI signed in as an authorized database user:

```powershell
npm install
npm run build
Copy-Item .env.sample .env
az login
node --env-file=.env dist/server.js
```

Open `http://localhost:3000`. Optional development command: `npm run dev`.
Production runs compiled Express, not a development server, binding `0.0.0.0` on `PORT` (default 3000).
Node 24 can load a local environment file with `node --env-file=.env dist/server.js`.
Copy `.env.sample` to `.env` if needed; never commit secrets.

The app uses the existing migrated Azure PostgreSQL database, not fabricated results.
The sample configuration uses your Azure CLI identity locally; that identity must
already have database permissions. App Service uses its managed identity instead.
Non-loopback database connections always verify the TLS certificate. Password
authentication without TLS is supported only for a loopback development database.
The app never creates, migrates, resets, or seeds schema.

## API and validation contracts

| Endpoint | Contract |
|---|---|
| `GET /healthz` | Anonymous liveness: `200 {"status":"ok"}`; no dependency check |
| `GET /readyz` | Dependency readiness: `200 {"status":"ready"}` or `503 {"status":"not_ready"}` |
| `GET /api/campsites` | `{campsites:[...]}`; allowlisted public campsite fields only, capped at 100 |
| `GET /api/name-search?name=Lake%20Samamish%20Heron` | `{matches:[{campsite_id,name,similarity}]}`; capped at 3; independent of search filters |
| `POST /api/bookings` | JSON `{campsite_id,guest_alias,check_in,check_out}`; 201 receipt containing only reservation ID, campsite ID and dates |

Search query parameters: `text` (up to 200 characters), `pet_friendly`, `kayak_rental`, `available_only` (literal `true`/`false`), `capacity` (integer 1–20), `radius_km` (1–200), `longitude` (−180–180), `latitude` (−90–90), `check_in`, `check_out`. Unknown/repeated parameters are rejected. False amenity flags mean “do not require this amenity,” not “exclude it.”

Defaults mirror `../sql/03-demo.sql`: `lake kayaking`, pet-friendly and kayak rental required, capacity ≥4, radius 45 km, Seattle (−122.335, 47.608), July 11–13, 2030, available only. Name lookup defaults to intentionally misspelled `Lake Samamish Heron`; the canonical seeded name is `Lake Sammamish Heron`.

Dates must be actual calendar dates in `YYYY-MM-DD`, years 0001–9999. Checkout must follow check-in, at most 30 nights. Stays are **[check-in, checkout)**, permitting checkout-day arrivals. Historical demo dates are intentionally not forbidden.
Booking IDs must be positive PostgreSQL integer campsite IDs. Aliases are trimmed, 1–60 characters, letters/numbers/spaces/underscores/hyphens only. The UI explicitly requests an alias, not a personal name; software cannot prove an alias is not a real name.

Invalid input returns 400; origin failure 403; missing campsite 404; overlapping booking 409; oversized JSON 413; non-JSON 415; rate limiting 429; repository unavailable 503; unexpected errors 500. Public 500/503 messages and event-only logs omit exception details and credentials.

## PostgreSQL implementation

`src/postgres.ts` implements the `CampsiteRepository` contract in
`src/repository.ts`. `src/server.ts` constructs the connection pool and adapter.
Queries are parameterized; date ranges and the database exclusion constraint
arbitrate booking conflicts atomically. Reservation IDs remain strings to
preserve PostgreSQL bigint precision.

Required environment variables are `PGHOST`, `PGUSER`, and `PGDATABASE`.
`PGPORT` defaults to 5432, `DB_AUTH` to `entra`, and `AZURE_AUTH_MODE` to
`managed-identity`. Local Azure development explicitly uses `AZURE_AUTH_MODE=cli`.
Entra tokens are acquired for new connections rather than stored as a fixed
password; pooled connections recycle after ten minutes. The pool is capped at
eight connections, with connection, statement and lock timeouts.

- `ready()` checks both existing tables.
- `search()` combines full-text search, JSONB, geography, capacity, and reservation availability.
- `searchNames()` uses `%` and `similarity()` from `pg_trgm`.
- `book()` inserts the selected date range; SQLSTATE `23P01` becomes HTTP 409.
- The web app's database role can read campsite details and reservation IDs/site IDs/dates,
  insert bookings, and use the reservation sequence. It cannot select guest names,
  delete/update bookings, administer roles, or reset schema.

## Security and operational boundaries

Helmet CSP permits only local scripts/styles/connects, with no inline scripts or external UI assets. Dynamic strings use `textContent`; no HTML interpolation is used. CORS deliberately grants no cross-origin access. POST requires an exact `Origin` match and rejects cross-site Fetch Metadata; non-browser clients must explicitly send the configured origin too.

Set `PUBLIC_ORIGIN` to the canonical browser origin for reverse-proxy/HTTPS deployments.
The Azure configuration derives it from each slot's actual hostname and pins it
to that slot. App Service trusts its immediate ingress proxy; local development
does not trust forwarded headers. Do not expose a proxy-configured server directly.

API reads share a 120/minute per-IP limit; writes have a separate 10/minute per-IP limit, before JSON parsing (8 KiB cap). Limits are process-local and bounded to 10,000 active clients; restart resets them. Multiple replicas require a shared limiter or gateway, and proxy-aware client IP handling needs explicit configuration. Health endpoints are excluded. Public writes are fictional-demo-only, not authenticated production reservations.

## Validation gate

```powershell
npm run typecheck
npm run build
npm test
```

Tests use `node:test`, `tsx` and `supertest`; fixtures are test-only and never used at runtime. They cover calendar validity, filter bounds, invalid requests, repository forwarding, privacy allowlists, successful booking, conflict/error translation, readiness, origin/JSON guards, body size and read/write limits.

The real database integration test is opt-in:

```powershell
$env:PGHOST = 'bobward-campsites-pg18.postgres.database.azure.com'
$env:PGUSER = 'bobward@microsoft.com'
$env:PGDATABASE = 'campsites'
$env:DB_AUTH = 'entra'
$env:AZURE_AUTH_MODE = 'cli'
$env:INTEGRATION_POSTGRES = '1'
npm test
```

It checks six combined search matches, typo matching, booking conflicts,
adjacent stays, availability, and privacy. Test bookings are rolled back;
PostgreSQL identity sequences can advance despite rollback.

## Azure deployment

Infrastructure is in `infra/main.bicep`: a Premium P1v3 Linux plan, Node.js 24
web app, and staging slot in the existing `campsites-demo-rg` in Central US.
Both use HTTPS, always-on, health checks, disabled FTP/basic publishing
credentials, and independent system-assigned identities. The slot shares the
same compute plan and the same demo database; it is not a data-isolated test
environment. One compute instance is not a highly available production design.

After deployment authorization, build the app and execute:

```powershell
npm run build
.\scripts\deploy.ps1 -Provision
```

Requires PowerShell 7, Azure CLI/Bicep, Node.js, permission to provision App Service,
and an Entra database administrator identity. The script creates the approved app
resources, grants scoped database access, packages source without secrets, deploys
through Entra-authenticated Kudu zipdeploy, and verifies staging before production.
Without `-Provision`, it reuses the recorded ARM deployment and redeploys code.
No database password, schema reset, seed operation, or firewall update is performed.

`scripts/grant-database-access.mjs` binds role names to the exact managed identity
object IDs and refuses to replace conflicting existing mappings. `PGUSER` and
`PUBLIC_ORIGIN` are slot-sticky, so a future code swap does not swap identities.

`scripts/smoke-bookings.mjs <https-app-origin>` exercises simultaneous public
bookings, expects one success and one conflict, checks an adjacent stay and
availability, and removes only its own uniquely identified test bookings using
an authorized administrator connection. Obtain permission for these writes
before running it. Never expose administrative cleanup as a public endpoint.

Deleting the shared resource group would also delete the migrated database.
For app-only cleanup, delete the named web app and its plan explicitly instead.
