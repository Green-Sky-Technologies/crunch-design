/**
 * The job tool API: a minimal, stateless MCP server over streamable HTTP (JSON responses) at
 * POST /api/jobs/:id/mcp. The Agent SDK in the sandbox connects to it with the job token, so
 * tool calls run here, against Postgres, with the job owner's permissions. The sandbox never
 * touches the database or any credential.
 */
import { contractToolDefs, executeTool, type ToolHost } from '@crunch/agent';
import { agentMessages, eq, type Db } from '@crunch/db';
import { appendJobEvent, jobActor } from '../jobs';
import { JobTokenError, tokenFromHeaders, verifyJobToken } from './job-tokens';
import { snapshotBeforeAgentEdit } from './snapshots';
import { createDbToolHost } from './tool-host';

const PROTOCOL_VERSION = '2025-06-18';

interface RpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

const rpcResult = (id: RpcRequest['id'], result: unknown) => ({
  jsonrpc: '2.0',
  id: id ?? null,
  result,
});
const rpcError = (id: RpcRequest['id'], code: number, message: string) => ({
  jsonrpc: '2.0',
  id: id ?? null,
  error: { code, message },
});

export function mcpToolList() {
  return contractToolDefs('job').map((d) => ({
    name: d.name,
    description: d.description,
    inputSchema: d.input_schema,
  }));
}

export async function handleJobMcp(db: Db, req: Request, jobId: string): Promise<Response> {
  let job;
  try {
    job = await verifyJobToken(db, tokenFromHeaders(req.headers));
    if (job.id !== jobId) throw new JobTokenError('Token is for a different job');
  } catch (e) {
    return Response.json(rpcError(null, -32001, (e as Error).message), { status: 401 });
  }
  let body: unknown;
  try {
    body = JSON.parse(await req.text());
  } catch {
    return Response.json(rpcError(null, -32700, 'Parse error'), { status: 400 });
  }
  const batch = Array.isArray(body);
  const requests = (batch ? body : [body]) as RpcRequest[];

  let host: ToolHost | null = null;
  const getHost = async () => {
    if (host) return host;
    if (!job.projectId) throw new Error('This job has no project');
    const [msg] = await db
      .select({ id: agentMessages.id })
      .from(agentMessages)
      .where(eq(agentMessages.jobId, job.id))
      .limit(1);
    if (!msg) throw new Error('This job has no agent message to attribute edits to');
    const actor = await jobActor(db, job);
    host = await createDbToolHost(db, actor, {
      projectId: job.projectId,
      agentMessageId: msg.id,
      runtime: 'job',
      beforeFirstCommit: () =>
        snapshotBeforeAgentEdit(db, actor, job.projectId!, msg.id).then(() => undefined),
      onFrameCreated: async (f) =>
        void (await appendJobEvent(db, job.id, 'frame', { frameId: f.id, name: f.name })),
    });
    return host;
  };

  const responses: unknown[] = [];
  for (const r of requests) {
    if (!r || r.jsonrpc !== '2.0' || typeof r.method !== 'string') {
      responses.push(rpcError(null, -32600, 'Invalid request'));
      continue;
    }
    const isNotification = r.id === undefined;
    try {
      let result: unknown;
      switch (r.method) {
        case 'initialize':
          result = {
            protocolVersion:
              typeof r.params?.protocolVersion === 'string'
                ? r.params.protocolVersion
                : PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'crunchdesign', version: '1.0.0' },
          };
          break;
        case 'ping':
          result = {};
          break;
        case 'tools/list':
          result = { tools: mcpToolList() };
          break;
        case 'tools/call': {
          const name = String(r.params?.name ?? '');
          await appendJobEvent(db, job.id, 'tool', { name, phase: 'call' });
          const res = await executeTool(await getHost(), name, r.params?.arguments ?? {});
          result = { content: [{ type: 'text', text: res.content }], isError: res.isError };
          break;
        }
        default:
          if (r.method.startsWith('notifications/')) continue;
          if (!isNotification)
            responses.push(rpcError(r.id, -32601, `Method not found: ${r.method}`));
          continue;
      }
      if (!isNotification) responses.push(rpcResult(r.id, result));
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Tool failed';
      if (!isNotification)
        responses.push(
          r.method === 'tools/call'
            ? rpcResult(r.id, {
                content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
                isError: true,
              })
            : rpcError(r.id, -32603, message),
        );
    }
  }
  if (!responses.length) return new Response(null, { status: 202 });
  return Response.json(batch ? responses : responses[0]);
}
