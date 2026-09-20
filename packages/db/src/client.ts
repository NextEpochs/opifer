import postgres, { type Sql } from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "./schema.js";

export interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export type Database = PostgresJsDatabase<typeof schema>;

export interface DatabaseHandle {
  /** Raw driver (postgres.js): for migrations and hand-written SQL. */
  sql: Sql;
  /** Typed access (Drizzle). */
  db: Database;
  close(): Promise<void>;
}

export function connectionString(config: DatabaseConfig): string {
  const user = encodeURIComponent(config.user);
  const password = encodeURIComponent(config.password);
  return `postgres://${user}:${password}@${config.host}:${config.port}/${config.database}`;
}

export function connect(config: DatabaseConfig, options: { max?: number } = {}): DatabaseHandle {
  const clientOptions = {
    host: config.host,
    port: config.port,
    database: config.database,
    username: config.user,
    password: config.password,
    onnotice: () => {},
  };
  const sql = postgres({ ...clientOptions, max: options.max ?? 10 });
  // Drizzle reconfigures the date parsers of the client it receives: give it its own client,
  // so hand-written SQL queries keep returning Date.
  const drizzleClient = postgres({ ...clientOptions, max: Math.max(2, Math.ceil((options.max ?? 10) / 2)) });
  const db = drizzle(drizzleClient, { schema });
  return {
    sql,
    db,
    close: async () => {
      await Promise.all([sql.end({ timeout: 5 }), drizzleClient.end({ timeout: 5 })]);
    },
  };
}

/** Waits for the server to answer, retrying at increasing intervals. */
export async function waitForDatabase(config: DatabaseConfig, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let delay = 100;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const sql = postgres({
      host: config.host,
      port: config.port,
      database: config.database,
      username: config.user,
      password: config.password,
      max: 1,
      connect_timeout: 3,
      onnotice: () => {},
    });
    try {
      await sql`SELECT 1`;
      await sql.end({ timeout: 1 });
      return;
    } catch (error) {
      lastError = error;
      await sql.end({ timeout: 1 }).catch(() => {});
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 1000);
    }
  }
  throw new Error(`The database is not answering on ${config.host}:${config.port}: ${String(lastError)}`);
}
