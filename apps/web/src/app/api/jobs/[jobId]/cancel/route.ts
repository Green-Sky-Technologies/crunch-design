/** POST /api/jobs/:id/cancel: cancel the job and stop its sandbox. */
import { getDb } from '@crunch/db';
import { NextResponse } from 'next/server';
import { apiActor, apiError } from '@/server/api';
import { jobRunner } from '@/server/services/agent/runner';
import { cancelJob } from '@/server/services/jobs';

export async function POST(_req: Request, ctx: RouteContext<'/api/jobs/[jobId]/cancel'>) {
  try {
    const actor = await apiActor();
    const { jobId } = await ctx.params;
    return NextResponse.json(
      await cancelJob(getDb(), actor, jobId, { runner: jobRunner(getDb()) }),
    );
  } catch (e) {
    return apiError(e);
  }
}
