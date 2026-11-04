/**
 * GET /api/jobs/:id/events: the job's events as SSE (id = seq). Resume with the Last-Event-ID
 * header (EventSource sends it automatically) or ?after=N. Ends with a `done` event.
 */
import { getDb } from '@crunch/db';
import { sseStream, SSE_HEADERS } from '@crunch/agent';
import type { NextRequest } from 'next/server';
import { apiActor, apiError } from '@/server/api';
import { getJob, jobEventFrames, parseLastEventId } from '@/server/services/jobs';

export const maxDuration = 300;

export async function GET(req: NextRequest, ctx: RouteContext<'/api/jobs/[jobId]/events'>) {
  try {
    const actor = await apiActor();
    const { jobId } = await ctx.params;
    await getJob(getDb(), actor, jobId);
    const after = parseLastEventId(
      req.headers.get('last-event-id'),
      req.nextUrl.searchParams.get('after'),
    );
    const frames = jobEventFrames(getDb(), actor, jobId, after, { signal: req.signal });
    return new Response(sseStream(frames, req.signal), { headers: SSE_HEADERS });
  } catch (e) {
    return apiError(e);
  }
}
