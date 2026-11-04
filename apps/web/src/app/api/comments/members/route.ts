/** GET /api/comments/members -> { members } (mention autocomplete; caller's workspace only) */
import { getDb } from '@crunch/db';
import { NextResponse } from 'next/server';
import { apiActor, apiError } from '@/server/api';
import { listMentionableMembers } from '@/server/services/comments';

export async function GET() {
  try {
    const actor = await apiActor();
    return NextResponse.json({ members: await listMentionableMembers(getDb(), actor) });
  } catch (e) {
    return apiError(e);
  }
}
