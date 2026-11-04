/**
 * POST /api/jobs <- { kind, input, projectId?, conversationId?, messageId?, timeoutSeconds? }
 *                -> JobView (queued). The sandbox is provisioned after the response.
 * Follow progress at /api/jobs/:id/events (SSE, resume with Last-Event-ID).
 */
import { getDb } from '@crunch/db';
import { jobEventsUrl } from '@crunch/contracts';
import { after, NextResponse } from 'next/server';
import { apiActor, apiError, jsonBody } from '@/server/api';
import { jobRunner } from '@/server/services/agent/runner';
import { createJob, startJob, toJobView } from '@/server/services/jobs';

export const maxDuration = 120;

export async function POST(req: Request) {
  try {
    const actor = await apiActor();
    const job = await createJob(getDb(), actor, await jsonBody(req, 256 * 1024));
    after(() => startJob(getDb(), job.id, { runner: jobRunner(getDb()) }).then(() => undefined));
    return NextResponse.json({ ...toJobView(job), eventsUrl: jobEventsUrl(job.id) });
  } catch (e) {
    return apiError(e);
  }
}
