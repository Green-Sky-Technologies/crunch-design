/**
 * GET  /api/versions?projectId=…[&includeAuto=1]  -> { versions }
 * POST /api/versions  <- { projectId, name, description? }  -> { version }
 */
import { getDb } from '@crunch/db';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { apiActor, apiError, jsonBody } from '@/server/api';
import { NotFoundError, ValidationError } from '@/server/services/types';
import { createNamedVersion, listVersions } from '@/server/services/versions';

const createBody = z
  .object({ projectId: z.string(), name: z.unknown(), description: z.unknown().optional() })
  .strict();

export async function GET(req: NextRequest) {
  try {
    const actor = await apiActor();
    const projectId = req.nextUrl.searchParams.get('projectId');
    if (!projectId) throw new NotFoundError('Project not found');
    const versions = await listVersions(getDb(), actor, projectId, {
      includeAuto: req.nextUrl.searchParams.get('includeAuto') === '1',
    });
    return NextResponse.json({ versions });
  } catch (e) {
    return apiError(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const actor = await apiActor();
    const parsed = createBody.safeParse(await jsonBody(req, 16 * 1024));
    if (!parsed.success) throw new ValidationError('Expected { projectId, name, description? }');
    const { projectId, ...input } = parsed.data;
    const version = await createNamedVersion(getDb(), actor, projectId, input);
    return NextResponse.json({ version }, { status: 201 });
  } catch (e) {
    return apiError(e);
  }
}
