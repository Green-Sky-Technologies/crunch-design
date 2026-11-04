/**
 * GET /api/jobs/reap: cron entry point (Authorization: Bearer $CRON_SECRET). Fails timed-out
 * jobs, reaps orphaned sandboxes, retries lost ones and starts stuck queued jobs.
 * Schedule it every minute (vercel.json crons; see the stream-agent report).
 */
import { getDb } from '@crunch/db';
import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { jobRunner } from '@/server/services/agent/runner';
import { reapJobs } from '@/server/services/jobs';

export const maxDuration = 300;

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  const got = req.headers.get('authorization') ?? '';
  if (!secret) return false;
  const want = Buffer.from(`Bearer ${secret}`);
  const have = Buffer.from(got);
  return want.length === have.length && timingSafeEqual(want, have);
}

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  return NextResponse.json(await reapJobs(getDb(), { runner: jobRunner(getDb()) }));
}
