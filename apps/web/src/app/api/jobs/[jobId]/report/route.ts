/**
 * POST /api/jobs/:id/report <- { type, data }: progress from the sandbox (job-token auth).
 * 401 for a bad/revoked token, 409 when the job already ended (the sandbox should stop).
 */
import { getDb } from '@crunch/db';
import { NextResponse } from 'next/server';
import { jsonBody } from '@/server/api';
import { JobTokenError, tokenFromHeaders } from '@/server/services/agent/job-tokens';
import { JobGoneError, reportJobEvent } from '@/server/services/jobs';
import { ValidationError } from '@/server/services/types';

export async function POST(req: Request, ctx: RouteContext<'/api/jobs/[jobId]/report'>) {
  try {
    const { jobId } = await ctx.params;
    const res = await reportJobEvent(
      getDb(),
      tokenFromHeaders(req.headers),
      jobId,
      await jsonBody(req, 256 * 1024),
    );
    return NextResponse.json(res);
  } catch (e) {
    if (e instanceof JobTokenError)
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    if (e instanceof JobGoneError) return NextResponse.json({ error: 'gone' }, { status: 409 });
    if (e instanceof ValidationError)
      return NextResponse.json({ error: 'invalid', message: e.message }, { status: 400 });
    console.error('[jobs] report failed', e instanceof Error ? e.name : typeof e);
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}
