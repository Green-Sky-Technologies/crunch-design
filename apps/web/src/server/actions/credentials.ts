'use server';

import type { PublicCredential } from '@crunch/providers';
import { revalidatePath } from 'next/cache';
import { db, requireActor } from '../context';
import { deleteCredential, saveCredential, testCredential } from '../services/credentials';
import { run, type ActionResult } from './result';

/** Save, then test immediately so the Admin sees whether it works. */
export async function saveCredentialAction(
  input: unknown,
): Promise<ActionResult<PublicCredential>> {
  const actor = await requireActor();
  const res = await run(async () => {
    await saveCredential(db(), actor, input);
    return testCredential(db(), actor);
  });
  revalidatePath(`/w/${actor.workspace.slug}/settings/credentials`);
  return res;
}

export async function testCredentialAction(): Promise<ActionResult<PublicCredential>> {
  const actor = await requireActor();
  const res = await run(() => testCredential(db(), actor));
  revalidatePath(`/w/${actor.workspace.slug}/settings/credentials`);
  return res;
}

export async function deleteCredentialAction(): Promise<ActionResult> {
  const actor = await requireActor();
  const res = await run(async () => {
    await deleteCredential(db(), actor);
    return undefined;
  });
  revalidatePath(`/w/${actor.workspace.slug}/settings/credentials`);
  return res;
}
