/**
 * Short-lived, job-scoped bearer tokens (Story 5.2). A sandbox gets one of these instead of a
 * provider credential. Only the SHA-256 hash is stored; the plaintext is returned once.
 * Revocation is immediate: every request re-checks the row and the job's status.
 */
import { TERMINAL_STATUSES, type JobStatus } from '@crunch/contracts';
import { and, eq, isNull, jobs, jobTokens, type Db, type JobRow } from '@crunch/db';
import { createHash, randomBytes } from 'node:crypto';

export const JOB_TOKEN_PREFIX = 'cjt_';

export class JobTokenError extends Error {
  override name = 'JobTokenError';
}

export const hashJobToken = (token: string) => createHash('sha256').update(token).digest('hex');

export async function issueJobToken(
  db: Db,
  jobId: string,
  ttlSeconds: number,
  now = new Date(),
): Promise<{ token: string; expiresAt: Date }> {
  const token = JOB_TOKEN_PREFIX + randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
  await db.insert(jobTokens).values({ jobId, tokenHash: hashJobToken(token), expiresAt });
  return { token, expiresAt };
}

/** Resolve a presented token to its (non-terminal) job, or throw JobTokenError. */
export async function verifyJobToken(
  db: Db,
  token: string | null | undefined,
  now = new Date(),
): Promise<JobRow> {
  if (!token || !token.startsWith(JOB_TOKEN_PREFIX) || token.length > 200)
    throw new JobTokenError('Missing or malformed job token');
  const [row] = await db
    .select({ token: jobTokens, job: jobs })
    .from(jobTokens)
    .innerJoin(jobs, eq(jobs.id, jobTokens.jobId))
    .where(eq(jobTokens.tokenHash, hashJobToken(token)))
    .limit(1);
  if (!row) throw new JobTokenError('Unknown job token');
  if (row.token.revokedAt) throw new JobTokenError('Job token revoked');
  if (row.token.expiresAt.getTime() <= now.getTime()) throw new JobTokenError('Job token expired');
  if (TERMINAL_STATUSES.has(row.job.status as JobStatus))
    throw new JobTokenError('Job is no longer running');
  return row.job;
}

export async function revokeJobTokens(db: Db, jobId: string, now = new Date()): Promise<void> {
  await db
    .update(jobTokens)
    .set({ revokedAt: now })
    .where(and(eq(jobTokens.jobId, jobId), isNull(jobTokens.revokedAt)));
}

/** Read the bearer token from `Authorization: Bearer` or `x-api-key` (both are what SDKs send). */
export function tokenFromHeaders(headers: Headers): string | null {
  const auth = headers.get('authorization');
  if (auth?.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return headers.get('x-api-key')?.trim() || null;
}
