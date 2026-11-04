'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { db, requireActor } from '../context';
import { copyDoc } from '../services/design-docs';
import {
  createProject,
  duplicateProject,
  renameProject,
  setProjectArchived,
} from '../services/projects';
import { run, type ActionResult } from './result';

export async function createProjectAction(
  _prev: ActionResult<{ id: string }> | null,
  form: FormData,
): Promise<ActionResult<{ id: string }>> {
  const actor = await requireActor();
  const res = await run(async () => {
    const p = await createProject(db(), actor, {
      name: form.get('name'),
      description: form.get('description'),
    });
    return { id: p.id };
  });
  if (res.ok) redirect(`/w/${actor.workspace.slug}/p/${res.data.id}`);
  return res;
}

export async function renameProjectAction(projectId: string, name: string): Promise<ActionResult> {
  const actor = await requireActor();
  const res = await run(async () => {
    await renameProject(db(), actor, projectId, name);
    return undefined;
  });
  revalidatePath(`/w/${actor.workspace.slug}`, 'layout');
  return res;
}

export async function duplicateProjectAction(projectId: string): Promise<ActionResult> {
  const actor = await requireActor();
  const res = await run(async () => {
    const copy = await duplicateProject(db(), actor, projectId);
    await copyDoc(db(), actor, projectId, copy.id);
    return undefined;
  });
  revalidatePath(`/w/${actor.workspace.slug}`);
  return res;
}

export async function setArchivedAction(
  projectId: string,
  archived: boolean,
): Promise<ActionResult> {
  const actor = await requireActor();
  const res = await run(async () => {
    await setProjectArchived(db(), actor, projectId, archived);
    return undefined;
  });
  revalidatePath(`/w/${actor.workspace.slug}`, 'layout');
  return res;
}
