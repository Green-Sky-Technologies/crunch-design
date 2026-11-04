/**
 * POST /api/figma/projects/:projectId/import            (Clerk session, design:edit)
 * POST /api/figma/projects/:projectId/import?dryRun=1   (project:read; converts without saving,
 *                                                         e.g. a Figma frame as prompt reference)
 *   <- { url }   a figma.com file or frame link; uses the caller's stored Figma token
 *   -> { version, frames, report, stats, preview? }
 */
import { getDb } from '@crunch/db';
import { NextResponse, type NextRequest } from 'next/server';
import { apiActor, apiError, jsonBody } from '@/server/api';
import { importFigmaUrl } from '@/server/services/figma';
import { importUrlRequest } from '@/server/services/figma/schemas';
import { ValidationError } from '@/server/services/types';

export async function POST(
  req: NextRequest,
  ctx: RouteContext<'/api/figma/projects/[projectId]/import'>,
) {
  try {
    const actor = await apiActor();
    const { projectId } = await ctx.params;
    const body = importUrlRequest.safeParse(await jsonBody(req, 16 * 1024));
    if (!body.success) throw new ValidationError('Expected { url }');
    const dryRun = req.nextUrl.searchParams.get('dryRun') === '1';
    return NextResponse.json(
      await importFigmaUrl(getDb(), actor, projectId, body.data.url, { dryRun }),
    );
  } catch (e) {
    return apiError(e);
  }
}
