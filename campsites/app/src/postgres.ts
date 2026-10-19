import { AzureCliCredential, ManagedIdentityCredential } from "@azure/identity";
import { Pool, type PoolConfig, type QueryResultRow } from "pg";
import {
  BookingConflictError, CampsiteNotFoundError, RepositoryUnavailableError,
  type BookingInput, type BookingReceipt, type Campsite, type NameMatch, type SearchInput,
} from "./domain.js";
import type { CampsiteRepository } from "./repository.js";
import { bookingQuery, nameQuery, searchQuery } from "./queries.js";

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return "unknown";
}

export function createPool(env: NodeJS.ProcessEnv = process.env): Pool {
  const host = env.PGHOST;
  const user = env.PGUSER;
  const database = env.PGDATABASE;
  if (!host || !user || !database) throw new Error("PGHOST, PGUSER and PGDATABASE are required.");
  const port = Number(env.PGPORT ?? 5432);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PGPORT must be a valid port.");
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(host);
  const config: PoolConfig = {
    host, user, database, port, max: 8, connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000, maxLifetimeSeconds: 600,
    statement_timeout: 8_000, lock_timeout: 5_000,
    application_name: "campsites-web",
    ssl: loopback ? false : { rejectUnauthorized: true, minVersion: "TLSv1.2" },
  };
  if (env.DB_AUTH === "password") {
    if (!loopback) throw new Error("Password mode is supported only for loopback development.");
    if (!env.PGPASSWORD) throw new Error("PGPASSWORD is required for local password mode.");
    config.password = env.PGPASSWORD;
  } else {
    if (env.DB_AUTH && env.DB_AUTH !== "entra") throw new Error("DB_AUTH must be entra or password.");
    const mode = env.AZURE_AUTH_MODE ?? "managed-identity";
    if (!["cli", "managed-identity"].includes(mode)) throw new Error("Invalid AZURE_AUTH_MODE.");
    const credential = mode === "cli" ? new AzureCliCredential() : new ManagedIdentityCredential();
    config.password = async () => {
      const token = await credential.getToken("https://ossrdbms-aad.database.windows.net/.default");
      if (!token) throw new Error("No PostgreSQL access token was returned.");
      return token.token;
    };
  }
  const pool = new Pool(config);
  pool.on("error", (error: Error) => console.error("postgres_pool_error", errorCode(error)));
  return pool;
}

export class PostgresRepository implements CampsiteRepository {
  constructor(private readonly pool: Pick<Pool, "query">) {}

  private async query<Row extends QueryResultRow>(sql: string, values: unknown[] = []): Promise<Row[]> {
    try {
      return (await this.pool.query<Row>(sql, values)).rows;
    } catch (error) {
      const code = errorCode(error);
      if (code === "23P01") throw new BookingConflictError();
      if (code === "23503") throw new CampsiteNotFoundError();
      console.error("postgres_query_failed", code);
      if (/^(08|53|57|58)/.test(code) || ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND"].includes(code)) {
        throw new RepositoryUnavailableError();
      }
      throw error;
    }
  }

  async ready(): Promise<boolean> {
    await this.query("SELECT campsite_id FROM escape.campsite LIMIT 1");
    await this.query("SELECT reservation_id FROM escape.reservation LIMIT 1");
    return true;
  }

  async search(input: SearchInput): Promise<readonly Campsite[]> {
    const query = searchQuery(input);
    return this.query<Campsite & QueryResultRow>(query.text, query.values);
  }

  async searchNames(name: string): Promise<readonly NameMatch[]> {
    const query = nameQuery(name);
    return this.query<NameMatch & QueryResultRow>(query.text, query.values);
  }

  async book(input: BookingInput): Promise<BookingReceipt> {
    const query = bookingQuery(input);
    const rows = await this.query<BookingReceipt & QueryResultRow>(query.text, query.values);
    const receipt = rows[0];
    if (!receipt) throw new CampsiteNotFoundError();
    return receipt;
  }
}
