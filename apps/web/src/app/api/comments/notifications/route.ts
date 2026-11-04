/**
 * GET  /api/comments/notifications[?unread=1]  -> { notifications }
 * POST /api/comments/notifications  <- { ids: uuid[] } | { all: true }  -> { updated }
 */
import { getDb } from '@crunch/db';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { apiActor, apiError, jsonBody } from '@/server/api';
import { listNotifications, markNotificationsRead } from '@/server/services/comments';
import { ValidationError } from '@/server/services/types';

const readBody = z.union([
  z.object({ ids: z.array(z.string()).max(200) }).strict(),
  z.object({ all: z.literal(true) }).strict(),
]);

export async function GET(req: NextRequest) {
  try {
    const actor = await apiActor();
    const unreadOnly = req.nextUrl.searchParams.get('unread') === '1';
    return NextResponse.json({
      notifications: await listNotifications(getDb(), actor, { unreadOnly }),
    });
  } catch (e) {
    return apiError(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const actor = await apiActor();
    const parsed = readBody.safeParse(await jsonBody(req, 16 * 1024));
    if (!parsed.success) throw new ValidationError('Expected { ids } or { all: true }');
    const target = 'all' in parsed.data ? 'all' : parsed.data.ids;
    return NextResponse.json(await markNotificationsRead(getDb(), actor, target));
  } catch (e) {
    return apiError(e);
  }
}
