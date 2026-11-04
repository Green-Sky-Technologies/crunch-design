/** Push to Figma (Story 8.2): plan building, permissions, payload validation, link recording. */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ForbiddenError } from '@crunch/authz';
import { designDocs, eq, figmaLinks } from '@crunch/db';
import { sampleLandingDoc } from '@crunch/doc-model';
import type { PushPlan } from '@crunch/figma-convert';
import { buildPushPlan, listFigmaLinks, recordPush } from '@/server/services/figma';
import { pluginBody, pluginRoute } from '@/server/services/figma/plugin-http';
import { pushPlanRequest, pushResultRequest } from '@/server/services/figma/schemas';
import { createPluginToken } from '@/server/services/plugin-tokens';
import { createProject } from '@/server/services/projects';
import { NotFoundError } from '@/server/services/types';
import { upsertMember } from '@/server/services/workspaces';
import type { Actor } from '@/server/services/types';
import { makeActor, reset, testDb } from './helpers';

const { db, close } = testDb();
afterAll(close);
beforeEach(() => reset(db));

async function member(role: Actor['role'], ws?: Actor['workspace']) {
  const a = await makeActor(db, role, ws);
  await upsertMember(db, a.workspace.id, a.userId, role);
  return a;
}

async function landingProject(actor: Actor) {
  const p = await createProject(db, actor, { name: 'Landing' });
  await db.insert(designDocs).values({
    projectId: p.id,
    workspaceId: actor.workspace.id,
    version: 4,
    doc: sampleLandingDoc(),
  });
  return p;
}

const planRoute = pluginRoute<{ projectId: string }>(
  async ({ req, actor, db, params }) =>
    buildPushPlan(db, actor, params.projectId, await pluginBody(req, pushPlanRequest, 16_384)),
  { db: () => db },
);

describe('push plan', () => {
  it('returns frames, components, variables and a report for editors via the plugin API', async () => {
    const editor = await member('editor');
    const p = await landingProject(editor);
    const { token } = await createPluginToken(db, editor, { name: 'fig' });
    const res = await planRoute(
      new Request('http://x/push-plan', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, origin: 'null' },
        body: JSON.stringify({ width: 375 }),
      }),
      { params: Promise.resolve({ projectId: p.id }) },
    );
    expect(res.status).toBe(200);
    const plan = (await res.json()) as PushPlan;
    expect(plan).toMatchObject({ version: 1, projectId: p.id, docVersion: 4 });
    expect(plan.frames[0]).toMatchObject({ width: 375, breakpoint: 'base' });
    expect(plan.components.length).toBe(2);
    expect(plan.variables?.modes).toEqual(['light', 'dark']);
    expect(Array.isArray(plan.report)).toBe(true);
  });

  it('rejects viewers, other workspaces and bad input', async () => {
    const editor = await member('editor');
    const p = await landingProject(editor);
    const viewer = await member('viewer', editor.workspace);
    await expect(buildPushPlan(db, viewer, p.id, {})).rejects.toThrow(ForbiddenError);
    const outsider = await member('editor');
    await expect(buildPushPlan(db, outsider, p.id, {})).rejects.toThrow(NotFoundError);
    expect(pushPlanRequest.safeParse({ width: 99999 }).success).toBe(false);
    expect(pushPlanRequest.safeParse({ frameIds: [], extra: 1 }).success).toBe(false);
  });
});

describe('push result', () => {
  const result = (nodeMap: Record<string, string>) =>
    pushResultRequest.parse({
      fileKey: 'AbCdEfGhIjKlMn',
      fileName: 'Marketing',
      pageId: '0:1',
      docVersion: 4,
      nodeMap,
      report: [{ severity: 'warning', message: 'Margins…', count: 3 }],
    });

  it('records the node map per project and file, merging later partial pushes', async () => {
    const editor = await member('editor');
    const p = await landingProject(editor);
    const first = await recordPush(
      db,
      editor,
      p.id,
      result({ n_root000001: '1:2', n_nav0000001: '1:3' }),
    );
    expect(first).toMatchObject({ figmaFileKey: 'AbCdEfGhIjKlMn', nodeCount: 2 });
    const second = await recordPush(
      db,
      editor,
      p.id,
      result({ n_nav0000001: '1:9', n_new0000001: '1:10' }),
    );
    expect(second.nodeCount).toBe(3);
    const [row] = await db.select().from(figmaLinks).where(eq(figmaLinks.projectId, p.id));
    expect(row!.nodeMap).toEqual({
      n_root000001: '1:2',
      n_nav0000001: '1:9',
      n_new0000001: '1:10',
    });
    expect(row!.direction).toBe('push');

    const links = await listFigmaLinks(db, editor, p.id);
    expect(links).toHaveLength(1);
    expect(links[0]!.report[0]).toMatchObject({ severity: 'warning', count: 3 });
  });

  it('validates file keys and node ids', () => {
    expect(
      pushResultRequest.safeParse({ fileKey: '../etc', docVersion: 1, nodeMap: {}, report: [] })
        .success,
    ).toBe(false);
    expect(
      pushResultRequest.safeParse({
        fileKey: 'local:0b9f3f9e-7d1f-4a51-9f0c-5f5c3f0b1a2b',
        docVersion: 1,
        nodeMap: { a: 'javascript:1' },
        report: [],
      }).success,
    ).toBe(false);
  });
});
