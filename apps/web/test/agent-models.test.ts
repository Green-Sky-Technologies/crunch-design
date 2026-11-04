import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ForbiddenError } from '@crunch/authz';
import { agentMessages, eq } from '@crunch/db';
import { MODEL_TIERS } from '@crunch/providers';
import { sendMessage } from '@/server/services/agent';
import { startGenerationJob } from '@/server/services/agent/generation';
import { getAgentSettings, updateModelSettings } from '@/server/services/agent/model-settings';
import { createProject } from '@/server/services/projects';
import { ValidationError } from '@/server/services/types';
import { makeActor, reset, testDb } from './helpers';

const { db, close } = testDb();
afterAll(close);
beforeEach(() => reset(db));

describe('model picker settings', () => {
  it('defaults by task tier and shows relative cost', async () => {
    const editor = await makeActor(db, 'editor');
    const s = await getAgentSettings(db, editor);
    expect(s.defaults).toEqual({
      generation: MODEL_TIERS.generation,
      interactive: MODEL_TIERS.interactive,
      utility: MODEL_TIERS.utility,
    });
    expect(s.models.find((m) => m.id === MODEL_TIERS.interactive)).toMatchObject({
      relativeCost: 1,
      relativeCostLabel: '1×',
    });
    expect(s.models.find((m) => m.id === 'claude-opus-5-5')!.relativeCost).toBe(2);
    expect(s.models.every((m) => m.allowed)).toBe(true);
    expect(s.canManage).toBe(false);
  });

  it('admins set defaults and the allowed list; members can only pick allowed models', async () => {
    const admin = await makeActor(db, 'admin');
    const editor = await makeActor(db, 'editor', admin.workspace);
    await expect(
      updateModelSettings(db, editor, { modelDefaults: {}, allowedModels: null }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      updateModelSettings(db, admin, {
        modelDefaults: { interactive: 'claude-opus-5-5' },
        allowedModels: ['claude-haiku-5-5'],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      updateModelSettings(db, admin, {
        modelDefaults: { interactive: 'gpt-4' },
        allowedModels: null,
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    const s = await updateModelSettings(db, admin, {
      modelDefaults: { interactive: 'claude-haiku-5-5' },
      allowedModels: ['claude-haiku-5-5', 'claude-opus-5-5'],
    });
    expect(s.defaults).toMatchObject({
      interactive: 'claude-haiku-5-5',
      generation: 'claude-opus-5-5',
    });
    expect(s.models.find((m) => m.id === 'claude-sonnet-5-5')!.allowed).toBe(false);

    const project = await createProject(db, editor, { name: 'P' });
    const chat = await sendMessage(db, editor, { projectId: project.id, prompt: 'hi' });
    const picked = await sendMessage(db, editor, {
      projectId: project.id,
      conversationId: chat.conversationId,
      prompt: 'hi',
      model: 'claude-opus-5-5',
    });
    const model = async (id: string) =>
      (await db.select().from(agentMessages).where(eq(agentMessages.id, id)))[0]!.model;
    expect(await model(chat.messageId)).toBe('claude-haiku-5-5');
    expect(await model(picked.messageId)).toBe('claude-opus-5-5');
    await expect(
      sendMessage(db, editor, { projectId: project.id, prompt: 'x', model: 'claude-sonnet-5-5' }),
    ).rejects.toBeInstanceOf(ValidationError);

    const job = await startGenerationJob(db, editor, {
      projectId: project.id,
      kind: 'generate',
      prompt: 'A page',
    });
    expect(job.message.model).toBe('claude-opus-5-5');
  });
});
