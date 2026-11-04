/**
 * POST /api/agent/jobs <- { projectId, conversationId?, kind, prompt, frameIds?, count?, frameCount?, model? }
 *                      -> { job, message, eventsUrl }
 * Starts a generation job (generate / redesign / alternatives) from the chat.
 */
import { jobEventsUrl } from '@crunch/contracts';
import { getDb } from '@crunch/db';
import { after, NextResponse } from 'next/server';
import { apiActor, apiError, jsonBody } from '@/server/api';
import { startGenerationJob } from '@/server/services/agent/generation';
import { jobRunner } from '@/server/services/agent/runner';
import { startJob, toJobView } from '@/server/services/jobs';

export const maxDuration = 120;

export async function POST(req: Request) {
  try {
    const actor = await apiActor();
    const { job, message } = await startGenerationJob(
      getDb(),
      actor,
      await jsonBody(req, 64 * 1024),
    );
    after(() => startJob(getDb(), job.id, { runner: jobRunner(getDb()) }).then(() => undefined));
    return NextResponse.json({ job: toJobView(job), message, eventsUrl: jobEventsUrl(job.id) });
  } catch (e) {
    return apiError(e);
  }
}
