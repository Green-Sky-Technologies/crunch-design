/**
 * GET /api/agent/settings -> AgentSettingsView (model catalog with relative cost, defaults, allowed list)
 * PUT /api/agent/settings <- { modelDefaults, allowedModels } (admins only)
 */
import { getDb } from '@crunch/db';
import { NextResponse } from 'next/server';
import { apiActor, apiError, jsonBody } from '@/server/api';
import { getAgentSettings, updateModelSettings } from '@/server/services/agent/model-settings';

export async function GET() {
  try {
    return NextResponse.json(await getAgentSettings(getDb(), await apiActor()));
  } catch (e) {
    return apiError(e);
  }
}

export async function PUT(req: Request) {
  try {
    const actor = await apiActor();
    return NextResponse.json(
      await updateModelSettings(getDb(), actor, await jsonBody(req, 16 * 1024)),
    );
  } catch (e) {
    return apiError(e);
  }
}
