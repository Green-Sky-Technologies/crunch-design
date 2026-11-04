'use server';

/**
 * Design-system server actions (Epic 4). Thin wrappers: authorization and validation live in the
 * services, `run()` maps domain errors to an ActionResult.
 */
import type { DesignSystemSpec } from '@crunch/doc-model';
import { revalidatePath } from 'next/cache';
import { db, requireActor } from '../context';
import {
  archiveDesignSystem,
  createDesignSystem,
  discardDesignSystemDraft,
  publishDesignSystem,
  saveDesignSystemDraft,
  setDefaultDesignSystem,
  updateDesignSystemDetails,
  type NewSystemSource,
} from '../services/design-systems';
import { run, type ActionResult } from './result';

const base = (slug: string) => `/w/${slug}/design-systems`;

export async function createDesignSystemAction(input: {
  name: string;
  description?: string;
  source?: NewSystemSource;
}): Promise<ActionResult<{ id: string }>> {
  const actor = await requireActor();
  const res = await run(async () => ({ id: (await createDesignSystem(db(), actor, input)).id }));
  revalidatePath(base(actor.workspace.slug));
  return res;
}

export async function updateDesignSystemDetailsAction(
  id: string,
  input: { name?: string; description?: string },
): Promise<ActionResult> {
  const actor = await requireActor();
  const res = await run(async () => {
    await updateDesignSystemDetails(db(), actor, id, input);
    return undefined;
  });
  revalidatePath(base(actor.workspace.slug), 'layout');
  return res;
}

export async function saveDesignSystemDraftAction(
  id: string,
  spec: DesignSystemSpec,
  baseRevision?: string,
): Promise<ActionResult<{ revision: string; spec: DesignSystemSpec }>> {
  const actor = await requireActor();
  const res = await run(() => saveDesignSystemDraft(db(), actor, id, { spec, baseRevision }));
  revalidatePath(base(actor.workspace.slug), 'layout');
  return res;
}

export async function discardDesignSystemDraftAction(
  id: string,
): Promise<ActionResult<{ revision: string; spec: DesignSystemSpec }>> {
  const actor = await requireActor();
  const res = await run(() => discardDesignSystemDraft(db(), actor, id));
  revalidatePath(base(actor.workspace.slug), 'layout');
  return res;
}

export async function publishDesignSystemAction(
  id: string,
  notes?: string,
): Promise<ActionResult<{ version: number }>> {
  const actor = await requireActor();
  const res = await run(async () => ({
    version: (await publishDesignSystem(db(), actor, id, { notes })).version,
  }));
  revalidatePath(base(actor.workspace.slug), 'layout');
  return res;
}

export async function setDefaultDesignSystemAction(id: string): Promise<ActionResult> {
  const actor = await requireActor();
  const res = await run(async () => {
    await setDefaultDesignSystem(db(), actor, id);
    return undefined;
  });
  revalidatePath(base(actor.workspace.slug), 'layout');
  return res;
}

export async function archiveDesignSystemAction(id: string): Promise<ActionResult> {
  const actor = await requireActor();
  const res = await run(async () => {
    await archiveDesignSystem(db(), actor, id);
    return undefined;
  });
  revalidatePath(base(actor.workspace.slug), 'layout');
  return res;
}
