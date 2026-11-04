import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

export * from './schema';
export { schema };
export { and, eq, desc, asc, isNull, isNotNull, sql, inArray } from 'drizzle-orm';

export type Db = NodePgDatabase<typeof schema>;

const globalForDb = globalThis as unknown as { __crunchPool?: Pool; __crunchDb?: Db };

/**
 * Shared pool (reused across hot reloads and warm Fluid-compute invocations).
 * Works with Neon's pooled connection string and local Postgres.
 */
export function getDb(url = process.env.DATABASE_URL): Db {
  if (globalForDb.__crunchDb) return globalForDb.__crunchDb;
  if (!url) throw new Error('DATABASE_URL is not set');
  const pool = new Pool({ connectionString: url, max: 5, idleTimeoutMillis: 10_000 });
  const db = drizzle(pool, { schema });
  globalForDb.__crunchPool = pool;
  globalForDb.__crunchDb = db;
  return db;
}

export function createDb(url: string): { db: Db; close: () => Promise<void> } {
  const pool = new Pool({ connectionString: url, max: 2 });
  return { db: drizzle(pool, { schema }), close: () => pool.end() };
}
