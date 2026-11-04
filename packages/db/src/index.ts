import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema/index';

export * from './schema/index';
export { schema };
export {
  and,
  eq,
  ne,
  gt,
  gte,
  lt,
  lte,
  desc,
  asc,
  isNull,
  isNotNull,
  sql,
  inArray,
} from 'drizzle-orm';

export type Db = NodePgDatabase<typeof schema>;

const globalForDb = globalThis as unknown as { __crunchPool?: Pool; __crunchDb?: Db };

/**
 * Fail fast on dead connections instead of hanging. A silently dropped TCP connection (NAT or
 * proxy idle drops, Docker port forwarding, serverless freezes) otherwise blocks a query until the
 * OS TCP retransmission timeout, about 16 minutes on macOS.
 */
const resilience = {
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
  connectionTimeoutMillis: 10_000,
  /** Client-side per-query timeout. Every app query is short; long work runs in jobs. */
  query_timeout: 30_000,
} as const;

/**
 * Shared pool (reused across hot reloads and warm Fluid-compute invocations).
 * Works with Neon's pooled connection string and local Postgres.
 */
/**
 * pg treats sslmode=prefer/require/verify-ca as verify-full today and warns that this will
 * weaken to libpq semantics in its next major. Pin the current (strict) behavior explicitly, so
 * it doesn't silently weaken on upgrade and the warning doesn't flood error logs.
 */
export function normalizeSslMode(url: string): string {
  return url.replace(/([?&]sslmode=)(prefer|require|verify-ca)\b/, '$1verify-full');
}

export function getDb(rawUrl = process.env.DATABASE_URL): Db {
  if (globalForDb.__crunchDb) return globalForDb.__crunchDb;
  if (!rawUrl) throw new Error('DATABASE_URL is not set');
  const url = normalizeSslMode(rawUrl);
  const pool = new Pool({
    connectionString: url,
    max: 5,
    idleTimeoutMillis: 10_000,
    ...resilience,
  });
  const db = drizzle(pool, { schema });
  globalForDb.__crunchPool = pool;
  globalForDb.__crunchDb = db;
  return db;
}

export function createDb(url: string): { db: Db; close: () => Promise<void> } {
  const pool = new Pool({ connectionString: url, max: 4, ...resilience });
  return { db: drizzle(pool, { schema }), close: () => pool.end() };
}
