/**
 * GET /api/jobs/reap: Vercel Cron entry point (apps/web/vercel.json, every minute).
 * Vercel sends `Authorization: Bearer $CRON_SECRET`; set CRON_SECRET in the project env.
 * Fails timed-out jobs, reaps orphaned sandboxes, retries lost ones that made no changes, and
 * starts queued jobs whose start was lost.
 */
import { getDb } from '@crunch/db';
import { NextResponse } from 'next/server';
import { cronAuthorized } from '@/server/services/agent/cron';
import { jobRunner } from '@/server/services/agent/runner';
import { reapJobs } from '@/server/services/jobs';

export const maxDuration = 300;

export async function GET(req: Request) {
  if (!cronAuthorized(req.headers.get('authorization')))
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  return NextResponse.json(await reapJobs(getDb(), { runner: jobRunner(getDb()) }));
}
