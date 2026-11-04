/**
 * Vercel Cron auth. Vercel sends `Authorization: Bearer $CRON_SECRET` on scheduled invocations
 * when the project has a CRON_SECRET env var. Without the secret configured, the cron endpoint
 * stays closed.
 */
import { timingSafeEqual } from 'node:crypto';

export function cronAuthorized(
  authorization: string | null,
  secret: string | undefined = process.env.CRON_SECRET,
): boolean {
  if (!secret) return false;
  const want = Buffer.from(`Bearer ${secret}`);
  const have = Buffer.from(authorization ?? '');
  return want.length === have.length && timingSafeEqual(want, have);
}
