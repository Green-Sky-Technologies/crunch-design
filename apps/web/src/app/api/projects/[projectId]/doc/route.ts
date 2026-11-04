/**
 * GET  /api/projects/:id/doc            -> { version, doc }
 * GET  /api/projects/:id/doc?since=N    -> { version, txns, reset }   (catch-up)
 * POST /api/projects/:id/doc            <- { baseVersion, txn }  -> { version, txnId, duplicate }
 *   409 conflict { version } | 423 locked | 400 invalid | 403 forbidden
 */
import { getDb } from '@crunch/db';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { apiActor, apiError, jsonBody } from '@/server/api';
import { commitTransaction, getDoc, getOpsSince } from '@/server/services/design-docs';
import { ValidationError } from '@/server/services/types';

const commitBody = z.object({ baseVersion: z.number().int().min(0), txn: z.unknown() }).strict();

export async function GET(req: NextRequest, ctx: RouteContext<'/api/projects/[projectId]/doc'>) {
  try {
    const actor = await apiActor();
    const { projectId } = await ctx.params;
    const since = req.nextUrl.searchParams.get('since');
    if (since !== null) {
      const n = Number(since);
      if (!Number.isInteger(n) || n < 0) throw new ValidationError('Invalid since');
      return NextResponse.json(await getOpsSince(getDb(), actor, projectId, n));
    }
    const { version, doc } = await getDoc(getDb(), actor, projectId);
    return NextResponse.json({ version, doc });
  } catch (e) {
    return apiError(e);
  }
}

export async function POST(req: NextRequest, ctx: RouteContext<'/api/projects/[projectId]/doc'>) {
  try {
    const actor = await apiActor();
    const { projectId } = await ctx.params;
    const body = commitBody.safeParse(await jsonBody(req));
    if (!body.success) throw new ValidationError('Expected { baseVersion, txn }');
    // Agent transactions are committed server-side by the agent service, never from the browser.
    const source = (body.data.txn as { source?: unknown } | null)?.source;
    if (source === 'agent')
      throw new ValidationError('Agent transactions cannot be submitted by clients');
    return NextResponse.json(await commitTransaction(getDb(), actor, projectId, body.data));
  } catch (e) {
    return apiError(e);
  }
}
