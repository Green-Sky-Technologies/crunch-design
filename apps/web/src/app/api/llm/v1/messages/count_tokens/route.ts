/** POST /api/llm/v1/messages/count_tokens: token counting for sandboxes (job-token auth). */
import { getDb } from '@crunch/db';
import { handleCountTokensProxy } from '@/server/services/llm-proxy';

export async function POST(req: Request) {
  return handleCountTokensProxy(getDb(), req);
}
