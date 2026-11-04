/** POST /api/jobs/:id/mcp: MCP (streamable HTTP, JSON responses) tool server for the job sandbox. */
import { getDb } from '@crunch/db';
import { handleJobMcp } from '@/server/services/agent/job-mcp';

export const maxDuration = 120;

export async function POST(req: Request, ctx: RouteContext<'/api/jobs/[jobId]/mcp'>) {
  return handleJobMcp(getDb(), req, (await ctx.params).jobId);
}

/** No server-initiated stream: this server only answers requests. */
export function GET() {
  return new Response(null, { status: 405, headers: { allow: 'POST' } });
}
