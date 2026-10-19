# Bob Ward's Azure PostgreSQL & Azure HorizonDB Demos

**Real code. Hands-on demos. PostgreSQL possibilities.**

Welcome! This is Bob Ward's home for **demos and examples for Azure Database for
PostgreSQL and Azure HorizonDB**. Explore familiar PostgreSQL features, take a
local database to Azure, and see how search, AI pipelines, and governed agents
come together in working applications.

> From finding your next campsite to responding to a logistics incident:
> learn by running the code, exploring the data, and seeing the results.

## Pick Your Adventure

| Demo | The story | What you'll explore | Start here |
| --- | --- | --- | --- |
| **Find Your Next Escape** | Search fictional Washington campsites and take PostgreSQL from local development to Azure. | PostGIS, full-text search, JSONB, typo tolerance, booking protection, and database portability. | [Campsites guide](campsites/README.md) |
| **Caldova Logistics** | Investigate a delayed, temperature-sensitive shipment with a PostgreSQL-powered control tower. | Azure HorizonDB, read scaling, AI retrieval, governed agents, and observability. | [Caldova Logistics guide](caldovalogistics/README.md) |
| **Caldova Knowledge Hub** | Find handling guidance while watching the AI pipeline keep search results fresh. | Vector, keyword, and hybrid search, automatic embeddings, and durable workflows. | [Knowledge Hub guide](caldovalogistics/demo6-vector-app/README.md) |

## Find Your Next Escape

**Local PostgreSQL. Cloud possibilities. Same database skills.**

Start with 30 fictional campsites near real Washington locations. Search by
location, amenities, and text; explore JSONB; and see how PostgreSQL protects
bookings at the database layer.

- **Start locally:** An isolated PostGIS setup with verification and dump/restore
  checks. The core database walkthrough needs no Azure resources or AI model.
- **Take it to Azure:** Follow the approval-gated migration path to Azure Database
  for PostgreSQL Flexible Server.
- **See it in a browser:** The optional [web app](campsites/app/README.md) adds
  campsite search, availability, and fictional bookings.

**[Try the live campsite app](https://app-campsites-dev-a59e.azurewebsites.net)**
or **[run the demo yourself](campsites/README.md)**.
Bookings in the live app persist in a shared demo database; use aliases, not
personal information.

## Caldova Logistics

**The PostgreSQL you know, with Azure HorizonDB at the center of the action.**

A working Python, FastAPI, and PostgreSQL logistics control tower brings six
demonstrations to life:

| # | Demo | See it in action |
| --- | --- | --- |
| 1 | **This Is PostgreSQL** | Standard SQL, psycopg, JSONB, transactions, full-text search, and query plans. |
| 2 | **Scale Reads with Explicit Routing** | Application-level routing between primary and reader endpoints. |
| 3 | **Native AI Pipeline** | Chunking, Microsoft Foundry embeddings, pgvector, and DiskANN indexing managed with HorizonDB. |
| 4 | **Approval-Gated Operations Agent** | A Microsoft Foundry Hosted Agent, remote MCP server, least-privilege PostgreSQL tools, and human approval. |
| 5 | **Production Evidence and Observability** | A controlled four-lane workload inspected through the VS Code PostgreSQL dashboards. |
| 6 | **Knowledge Hub on App Service** | Vector, keyword, and hybrid search kept current by an `on_change` AI pipeline and a pg_durable workflow, with the live pipeline beside the app. |

The [Caldova Logistics guide](caldovalogistics/README.md) connects the application,
schema and seed data, deployment and preflight automation, AI pipeline assets,
MCP infrastructure, Foundry agent source, observability workload, architecture
diagrams, and presenter runbook.

## How to Learn More

Keep exploring with these [Azure PostgreSQL resources](assets/postgresql-resources.md):

| Resource | What you'll find |
| --- | --- |
| [Azure PostgreSQL Developer Hub](https://aka.ms/azure-dev-hub-postgres) | Your starting point for developer resources, tools, and learning. |
| [Azure Database for PostgreSQL documentation](https://learn.microsoft.com/azure/postgresql/) | Guides for building, managing, and optimizing PostgreSQL on Azure. |
| [Azure HorizonDB overview](https://learn.microsoft.com/azure/horizondb/overview) | An introduction to Azure's PostgreSQL-compatible cloud database. |
| [PostgreSQL extension for VS Code](https://learn.microsoft.com/azure/postgresql/development/vs-code-extension/postgresql-extension-overview) | Connect, write queries, and develop without leaving your editor. |
| [Connect to HorizonDB with VS Code](https://learn.microsoft.com/azure/horizondb/development/vs-code-extension/vs-code-connect) | A hands-on connection and query quickstart. |

## Ready to Explore?

1. **Choose a demo** from the guides above.
2. **Check its prerequisites** and run the documented setup or preflight.
3. **Follow the walkthrough**, experiment with the examples, and use the demo's
   teardown instructions when you're finished.

Using Copilot in VS Code? The repository includes a
[Campsites demo skill](.github/skills/campsite-demo/SKILL.md), a
[reusable PostgreSQL-to-Azure migration skill](.github/skills/local-postgres-to-azure/SKILL.md),
and a [Caldova Demo 6 skill](.github/skills/caldova-demo6/SKILL.md)
to guide supported demo workflows.

> **Demo responsibly:** These are learning and presentation examples, not
> production-ready templates. Review each guide before running scripts, approve
> cloud changes deliberately, keep credentials out of source control, and clean
> up Azure resources you no longer need to avoid ongoing charges.
