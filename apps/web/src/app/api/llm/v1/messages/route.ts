/**
 * POST /api/llm/v1/messages: the LLM proxy for sandboxes (Story 5.2).
 * The sandbox's ANTHROPIC_BASE_URL is /api/llm and its auth token is a job token, so the Agent
 * SDK calls this exactly like the Anthropic API. Auth is the job token, not a Clerk session.
 */
import { getDb } from '@crunch/db';
import { handleMessagesProxy } from '@/server/services/llm-proxy';

export const maxDuration = 800;

export async function POST(req: Request) {
  return handleMessagesProxy(getDb(), req);
}
