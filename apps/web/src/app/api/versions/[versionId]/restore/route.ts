/**
 * POST /api/versions/:versionId/restore  <- { projectId }  -> { version, txnId, backupId }
 *   423 locked (someone else holds the edit lock) | 403 forbidden | 404 not found
 */
import { getDb } from '@crunch/db';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { apiActor, apiError, jsonBody } from '@/server/api';
import { ValidationError } from '@/server/services/types';
import { restoreVersion } from '@/server/services/versions';

const body = z.object({ projectId: z.string() }).strict();

export async function POST(
  req: NextRequest,
  ctx: RouteContext<'/api/versions/[versionId]/restore'>,
) {
  try {
    const actor = await apiActor();
    const { versionId } = await ctx.params;
    const parsed = body.safeParse(await jsonBody(req, 4 * 1024));
    if (!parsed.success) throw new ValidationError('Expected { projectId }');
    return NextResponse.json(
      await restoreVersion(getDb(), actor, parsed.data.projectId, versionId),
    );
  } catch (e) {
    return apiError(e);
  }
}
