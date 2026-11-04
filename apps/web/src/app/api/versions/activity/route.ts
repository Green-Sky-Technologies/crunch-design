/**
 * GET /api/versions/activity?projectId=…[&cursor=…][&who=all|human|agent][&limit=N]
 *   -> { entries, nextCursor }
 * Project history feed (Story 6.4): design edits from doc_ops (grouped) merged with activity rows.
 * Lives under /api/versions because it's the project's history alongside named versions.
 */
import { getDb } from '@crunch/db';
import { NextResponse, type NextRequest } from 'next/server';
import { apiActor, apiError } from '@/server/api';
import { listActivity } from '@/server/services/activity';
import { NotFoundError } from '@/server/services/types';

export async function GET(req: NextRequest) {
  try {
    const actor = await apiActor();
    const sp = req.nextUrl.searchParams;
    const projectId = sp.get('projectId');
    if (!projectId) throw new NotFoundError('Project not found');
    const who = sp.get('who');
    const limit = Number(sp.get('limit') ?? 50);
    return NextResponse.json(
      await listActivity(getDb(), actor, projectId, {
        cursor: sp.get('cursor') ?? undefined,
        who: who === 'human' || who === 'agent' ? who : 'all',
        limit: Number.isFinite(limit) ? limit : 50,
      }),
    );
  } catch (e) {
    return apiError(e);
  }
}
