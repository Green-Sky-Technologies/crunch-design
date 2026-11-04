/** GET /api/jobs/:id -> JobView */
import { getDb } from '@crunch/db';
import { after, NextResponse } from 'next/server';
import { apiActor, apiError } from '@/server/api';
import { maybeReap } from '@/server/services/agent/opportunistic-reap';
import { jobRunner } from '@/server/services/agent/runner';
import { getJob, reapJobs } from '@/server/services/jobs';

export async function GET(_req: Request, ctx: RouteContext<'/api/jobs/[jobId]'>) {
  try {
    const actor = await apiActor();
    const job = await getJob(getDb(), actor, (await ctx.params).jobId);
    // Someone is watching a job: keep the reaper going even without a per-minute cron.
    if (job.status !== 'succeeded' && job.status !== 'failed' && job.status !== 'cancelled')
      after(() => maybeReap(() => reapJobs(getDb(), { runner: jobRunner(getDb()) })));
    return NextResponse.json(job);
  } catch (e) {
    return apiError(e);
  }
}
