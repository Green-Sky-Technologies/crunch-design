'use server';

import { revalidatePath } from 'next/cache';
import { db, requireActor } from '../context';
import {
  createPluginToken,
  revokePluginToken,
  type PublicPluginToken,
} from '../services/plugin-tokens';
import { run, type ActionResult } from './result';

const settingsPath = (slug: string) => `/w/${slug}/settings/figma`;

/** Create a plugin token. The plaintext token is in the result exactly once. */
export async function createPluginTokenAction(
  name: unknown,
): Promise<ActionResult<{ token: string; record: PublicPluginToken }>> {
  const actor = await requireActor();
  const res = await run(() => createPluginToken(db(), actor, { name }));
  revalidatePath(settingsPath(actor.workspace.slug));
  return res;
}

export async function revokePluginTokenAction(tokenId: unknown): Promise<ActionResult> {
  const actor = await requireActor();
  const res = await run(async () => {
    await revokePluginToken(db(), actor, String(tokenId));
    return undefined;
  });
  revalidatePath(settingsPath(actor.workspace.slug));
  return res;
}
