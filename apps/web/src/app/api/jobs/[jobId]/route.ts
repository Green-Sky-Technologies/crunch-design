/** GET /api/jobs/:id -> JobView */
import { getDb } from '@crunch/db';
import { NextResponse } from 'next/server';
import { apiActor, apiError } from '@/server/api';
import { getJob } from '@/server/services/jobs';

export async function GET(_req: Request, ctx: RouteContext<'/api/jobs/[jobId]'>) {
  try {
    const actor = await apiActor();
    return NextResponse.json(await getJob(getDb(), actor, (await ctx.params).jobId));
  } catch (e) {
    return apiError(e);
  }
}
