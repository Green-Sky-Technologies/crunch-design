/**
 * GET /api/versions/activity?projectId=…[&before=ISO][&who=all|human|agent][&limit=N]
 *   -> { entries, nextBefore }
 * Project history feed (Story 6.4): design edits from doc_ops (grouped) merged with activity rows.
 * Lives under /api/versions because it's the project's history alongside named versions.
 */
import { getDb } from '@crunch/db';
import { NextResponse, type NextRequest } from 'next/server';
import { apiActor, apiError } from '@/server/api';
import { listActivity } from '@/server/services/activity';
import { NotFoundError, ValidationError } from '@/server/services/types';

export async function GET(req: NextRequest) {
  try {
    const actor = await apiActor();
    const sp = req.nextUrl.searchParams;
    const projectId = sp.get('projectId');
    if (!projectId) throw new NotFoundError('Project not found');
    const beforeRaw = sp.get('before');
    const before = beforeRaw ? new Date(beforeRaw) : undefined;
    if (before && Number.isNaN(before.getTime())) throw new ValidationError('Invalid before');
    const who = sp.get('who');
    const limit = Number(sp.get('limit') ?? 50);
    return NextResponse.json(
      await listActivity(getDb(), actor, projectId, {
        before,
        who: who === 'human' || who === 'agent' ? who : 'all',
        limit: Number.isFinite(limit) ? limit : 50,
      }),
    );
  } catch (e) {
    return apiError(e);
  }
}
