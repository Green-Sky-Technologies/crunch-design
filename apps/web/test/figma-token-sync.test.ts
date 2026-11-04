/** Token sync with Figma variables (Story 8.4): diff, pull patch, push plan, sync base. */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ForbiddenError } from '@crunch/authz';
import { eq, figmaVariableLinks } from '@crunch/db';
import { starterDesignSystem, type DesignSystemSpec } from '@crunch/doc-model';
import {
  tokensToVariables,
  type VariablesSnapshot,
  type VariablesSpec,
} from '@crunch/figma-convert';
import { syncRequest } from '@/server/services/figma/schemas';
import {
  diffVariables,
  planVariablesPush,
  pullVariables,
  recordVariablesPush,
  type DraftWriter,
} from '@/server/services/figma/token-sync';
import { createProject } from '@/server/services/projects';
import { NotFoundError, ValidationError, type Actor } from '@/server/services/types';
import { makeActor, reset, testDb } from './helpers';

const { db, close } = testDb();
afterAll(close);
beforeEach(() => reset(db));

const FILE = 'AbCdEfGhIjKl1234';

/** What the plugin would read back after a push of `spec` into an empty file. */
function snapshotFrom(spec: VariablesSpec): VariablesSnapshot {
  const ids = new Map(spec.variables.map((v, i) => [v.path, `VariableID:1:${i}`]));
  return {
    collections: [
      {
        id: 'VariableCollectionId:1:0',
        name: spec.collectionName,
        defaultModeId: 'm0',
        managed: true,
        modes: spec.modes.map((m, i) => ({ modeId: `m${i}`, name: m })),
        variables: spec.variables.map((v) => ({
          id: ids.get(v.path)!,
          name: v.name,
          resolvedType: v.type,
          tokenPath: v.path,
          valuesByMode: Object.fromEntries(
            spec.modes.map((m, i) => {
              const val = v.valuesByMode[m]!;
              return [
                `m${i}`,
                typeof val === 'object' && 'alias' in val
                  ? { type: 'VARIABLE_ALIAS' as const, id: ids.get(val.alias)! }
                  : val,
              ];
            }),
          ),
        })),
      },
    ],
  };
}

const req = (input: Record<string, unknown>) => syncRequest.parse({ fileKey: FILE, ...input });

async function setup() {
  const editor = await makeActor(db, 'editor');
  const p = await createProject(db, editor, { name: 'Tokens' });
  const snap = snapshotFrom(tokensToVariables(starterDesignSystem()));
  const primary = snap.collections[0]!.variables.find((v) => v.name === 'color/primary')!;
  primary.valuesByMode.m0 = { r: 1, g: 0, b: 0, a: 1 }; // edited in Figma
  return { editor, projectId: p.id, snap };
}

describe('token sync service', () => {
  it('diffs the project design system against the file (viewers can look)', async () => {
    const { editor, projectId, snap } = await setup();
    const viewer = await makeActor(db, 'viewer', editor.workspace);
    const diff = await diffVariables(
      db,
      viewer,
      projectId,
      req({ snapshot: snap, direction: 'pull' }),
    );
    expect(diff.hasBase).toBe(false);
    expect(diff.entries).toEqual([
      expect.objectContaining({ key: 'base:color.primary', status: 'conflict' }),
    ]);
    expect(diff.designSystem.name).toBe('Default');
    const outsider = await makeActor(db, 'editor');
    await expect(diffVariables(db, outsider, projectId, req({ snapshot: snap }))).rejects.toThrow(
      NotFoundError,
    );
  });

  it('pull: conflicts need a resolution; produces a validated patch; writes via the injected writer', async () => {
    const { editor, projectId, snap } = await setup();
    await expect(
      pullVariables(
        db,
        editor,
        projectId,
        req({ snapshot: snap, selected: ['base:color.primary'] }),
      ),
    ).rejects.toThrow(ValidationError);

    const resolved = req({
      snapshot: snap,
      selected: ['base:color.primary'],
      resolutions: { 'base:color.primary': 'theirs' },
    });
    const dry = await pullVariables(db, editor, projectId, resolved);
    expect(dry.applied).toBe(false);
    expect(dry.patch.tokens['color.primary']).toEqual({ type: 'color', value: '#ff0000' });
    expect(dry.spec.tokens['color.primary']!.value).toBe('#ff0000');

    let written: DesignSystemSpec | null = null;
    const writeDraft: DraftWriter = async (_db, _actor, _id, spec) => {
      written = spec;
    };
    const res = await pullVariables(db, editor, projectId, resolved, { writeDraft });
    expect(res.applied).toBe(true);
    expect(written!.tokens['color.primary']!.value).toBe('#ff0000');
    const [link] = await db
      .select()
      .from(figmaVariableLinks)
      .where(eq(figmaVariableLinks.figmaFileKey, FILE));
    expect(link!.lastPulledAt).toBeInstanceOf(Date);

    const viewer = await makeActor(db, 'viewer', editor.workspace);
    await expect(pullVariables(db, viewer, projectId, resolved)).rejects.toThrow(ForbiddenError);
  });

  it('push: plans variables for the selection, then records the new base so re-diffs are clean', async () => {
    const { editor, projectId, snap } = await setup();
    const push = await diffVariables(
      db,
      editor,
      projectId,
      req({ snapshot: snap, direction: 'push' }),
    );
    expect(push.entries.map((e) => e.key)).toEqual(['base:color.primary']);
    const plan = await planVariablesPush(
      db,
      editor,
      projectId,
      req({
        snapshot: snap,
        direction: 'push',
        selected: ['base:color.primary'],
        resolutions: { 'base:color.primary': 'ours' },
      }),
    );
    expect(plan.remove).toEqual([]);
    expect(plan.variables.variables).toEqual([
      expect.objectContaining({ path: 'color.primary', type: 'COLOR' }),
    ]);

    // The plugin applies it and reports the file's variables back.
    const after = structuredClone(snap);
    after.collections[0]!.variables.find((v) => v.name === 'color/primary')!.valuesByMode.m0 = plan
      .variables.variables[0]!.valuesByMode.light as { r: number; g: number; b: number };
    const rec = await recordVariablesPush(db, editor, projectId, {
      fileKey: FILE,
      snapshot: after,
    });
    expect(rec.synced).toBeGreaterThan(30);

    const again = await diffVariables(
      db,
      editor,
      projectId,
      req({ snapshot: after, direction: 'pull' }),
    );
    expect(again.hasBase).toBe(true);
    expect(again.entries).toEqual([]);

    // A later Figma-only edit is now a plain change, not a conflict.
    const edited = structuredClone(after);
    edited.collections[0]!.variables.find((v) => v.name === 'color/accent')!.valuesByMode.m0 = {
      r: 0,
      g: 0,
      b: 0,
      a: 1,
    };
    const next = await diffVariables(
      db,
      editor,
      projectId,
      req({ snapshot: edited, direction: 'pull' }),
    );
    expect(next.entries).toEqual([
      expect.objectContaining({ key: 'base:color.accent', status: 'changed' }),
    ]);
  });

  it('validates snapshots and selections', () => {
    expect(
      syncRequest.safeParse({ fileKey: FILE, snapshot: { collections: [{ id: 1 }] } }).success,
    ).toBe(false);
    expect(
      syncRequest.safeParse({
        fileKey: FILE,
        snapshot: { collections: [] },
        resolutions: { a: 'auto' },
      }).success,
    ).toBe(false);
  });
});
