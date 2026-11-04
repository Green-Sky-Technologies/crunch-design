'use server';

import { revalidatePath } from 'next/cache';
import { db, requireActor } from '../context';
import { importFigmaUrl, type ImportResult } from '../services/figma';
import {
  deleteFigmaToken,
  saveFigmaToken,
  type PublicFigmaCredential,
} from '../services/figma/credentials';
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

/** Save (after verifying with Figma) the caller's Figma personal access token. */
export async function saveFigmaTokenAction(
  token: unknown,
): Promise<ActionResult<PublicFigmaCredential>> {
  const actor = await requireActor();
  const res = await run(() => saveFigmaToken(db(), actor, token));
  revalidatePath(settingsPath(actor.workspace.slug));
  return res;
}

export async function deleteFigmaTokenAction(): Promise<ActionResult> {
  const actor = await requireActor();
  const res = await run(async () => {
    await deleteFigmaToken(db(), actor);
    return undefined;
  });
  revalidatePath(settingsPath(actor.workspace.slug));
  return res;
}

/** Import a Figma file/frame link into a project as new frames. */
export async function importFigmaUrlAction(
  projectId: unknown,
  url: unknown,
): Promise<ActionResult<Omit<ImportResult, 'preview'>>> {
  const actor = await requireActor();
  const res = await run(() => importFigmaUrl(db(), actor, String(projectId), String(url ?? '')));
  revalidatePath(`/w/${actor.workspace.slug}/p/${String(projectId)}`);
  return res;
}
