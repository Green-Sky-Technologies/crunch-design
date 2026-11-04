/** GET /api/agent/chat?projectId=… -> { conversationId, messages } for the project's main chat. */
import { getDb } from '@crunch/db';
import { NextResponse, type NextRequest } from 'next/server';
import { apiActor, apiError } from '@/server/api';
import { getProjectChat } from '@/server/services/agent';
import { NotFoundError } from '@/server/services/types';

export async function GET(req: NextRequest) {
  try {
    const actor = await apiActor();
    const projectId = req.nextUrl.searchParams.get('projectId');
    if (!projectId) throw new NotFoundError('Project not found');
    return NextResponse.json(await getProjectChat(getDb(), actor, projectId));
  } catch (e) {
    return apiError(e);
  }
}
