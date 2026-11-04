/**
 * GET  /api/comments?projectId=…[&status=open|resolved]  -> { threads }
 * POST /api/comments  <- { projectId, anchor, body, mentions?, kind?, fallback? }  -> { thread }
 */
import { getDb } from '@crunch/db';
import { NextResponse, type NextRequest } from 'next/server';
import { apiActor, apiError, jsonBody } from '@/server/api';
import { createThread, listThreads } from '@/server/services/comments';
import { NotFoundError } from '@/server/services/types';

export async function GET(req: NextRequest) {
  try {
    const actor = await apiActor();
    const projectId = req.nextUrl.searchParams.get('projectId');
    if (!projectId) throw new NotFoundError('Project not found');
    const status = req.nextUrl.searchParams.get('status');
    const threads = await listThreads(getDb(), actor, projectId, {
      status: status === 'open' || status === 'resolved' ? status : undefined,
    });
    return NextResponse.json({ threads });
  } catch (e) {
    return apiError(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const actor = await apiActor();
    const thread = await createThread(getDb(), actor, await jsonBody(req, 64 * 1024));
    return NextResponse.json({ thread }, { status: 201 });
  } catch (e) {
    return apiError(e);
  }
}
