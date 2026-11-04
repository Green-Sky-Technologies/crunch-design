/**
 * GET /api/agent/messages/:id/snapshot -> { snapshotId, doc }: the auto snapshot taken before
 * this message's edits. The editor applies it as a 'restore' transaction (undoable). design:edit.
 */
import { getDb } from '@crunch/db';
import { NextResponse } from 'next/server';
import { apiActor, apiError } from '@/server/api';
import { getRevertTarget } from '@/server/services/agent/snapshots';

export async function GET(
  _req: Request,
  ctx: RouteContext<'/api/agent/messages/[messageId]/snapshot'>,
) {
  try {
    const actor = await apiActor();
    return NextResponse.json(await getRevertTarget(getDb(), actor, (await ctx.params).messageId));
  } catch (e) {
    return apiError(e);
  }
}
