/**
 * GET /api/export/:projectId?format=html|zip[&frameIds=a,b][&versionId=…]
 *   -> file download (Content-Disposition: attachment)
 * Deterministic exports (Epic 7); allowed for every role with export:deterministic (incl. Viewers).
 */
import { getDb } from '@crunch/db';
import type { NextRequest } from 'next/server';
import { apiActor, apiError } from '@/server/api';
import { exportDesign } from '@/server/services/export';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: RouteContext<'/api/export/[projectId]'>) {
  try {
    const actor = await apiActor();
    const { projectId } = await ctx.params;
    const sp = req.nextUrl.searchParams;
    const frameIds = sp.get('frameIds');
    const file = await exportDesign(getDb(), actor, projectId, {
      format: sp.get('format') ?? 'html',
      frameIds: frameIds ? frameIds.split(',').filter(Boolean) : undefined,
      versionId: sp.get('versionId') ?? undefined,
    });
    const body =
      typeof file.body === 'string' ? file.body : new Blob([file.body as Uint8Array<ArrayBuffer>]);
    return new Response(body, {
      headers: {
        'content-type': file.contentType,
        'content-disposition': `attachment; filename="${file.filename}"`,
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
        ...(file.warnings.length ? { 'x-export-warnings': String(file.warnings.length) } : {}),
      },
    });
  } catch (e) {
    return apiError(e);
  }
}
