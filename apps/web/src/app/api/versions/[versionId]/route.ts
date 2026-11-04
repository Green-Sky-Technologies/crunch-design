/** GET /api/versions/:versionId?projectId=…  -> { version, doc } */
import { getDb } from '@crunch/db';
import { NextResponse, type NextRequest } from 'next/server';
import { apiActor, apiError } from '@/server/api';
import { NotFoundError } from '@/server/services/types';
import { getVersion } from '@/server/services/versions';

export async function GET(req: NextRequest, ctx: RouteContext<'/api/versions/[versionId]'>) {
  try {
    const actor = await apiActor();
    const { versionId } = await ctx.params;
    const projectId = req.nextUrl.searchParams.get('projectId');
    if (!projectId) throw new NotFoundError('Version not found');
    return NextResponse.json(await getVersion(getDb(), actor, projectId, versionId));
  } catch (e) {
    return apiError(e);
  }
}
