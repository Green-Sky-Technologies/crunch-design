import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ForbiddenError } from '@crunch/authz';
import { designSystems, eq } from '@crunch/db';
import { starterDesignSystem, type ComponentDef } from '@crunch/doc-model';
import {
  archiveDesignSystem,
  createDesignSystem,
  discardDesignSystemDraft,
  getDesignSystem,
  getDesignSystemVersionSpec,
  listDesignSystems,
  listDesignSystemVersions,
  publishDesignSystem,
  removeDesignSystemComponent,
  safeParseSpec,
  saveDesignSystemDraft,
  setDefaultDesignSystem,
  setDesignSystemToken,
  updateDesignSystemDetails,
  upsertDesignSystemComponent,
} from '@/server/services/design-systems';
import { createProject } from '@/server/services/projects';
import { NotFoundError, ValidationError } from '@/server/services/types';
import { makeActor, reset, testDb } from './helpers';

const { db, close } = testDb();
afterAll(close);
beforeEach(() => reset(db));

async function defaultSystem(actor: Awaited<ReturnType<typeof makeActor>>) {
  const [ds] = await listDesignSystems(db, actor);
  return ds!;
}

const card: ComponentDef = {
  id: 'Card',
  name: 'Card',
  props: { title: { type: 'text', default: 'Title' } },
  variants: {},
  rootNodeId: 'n_cardroot1',
  nodes: {
    n_cardroot1: {
      id: 'n_cardroot1',
      type: 'box',
      tag: 'article',
      parentId: null,
      children: ['n_cardtitl1'],
      positioning: 'flow',
      props: {},
      style: { base: { backgroundColor: { token: 'color.surface' } } },
    },
    n_cardtitl1: {
      id: 'n_cardtitl1',
      type: 'text',
      tag: 'h3',
      parentId: 'n_cardroot1',
      children: [],
      positioning: 'flow',
      bind: { text: 'title' },
      props: { text: 'Title' },
      style: {},
    },
  },
  variantStyles: [],
};

describe('spec validation', () => {
  it('accepts the starter and rejects broken cross-references', () => {
    expect(safeParseSpec(starterDesignSystem()).ok).toBe(true);

    const alias = starterDesignSystem();
    alias.tokens['color.link'] = { type: 'color', value: { ref: 'color.nope' } };
    expect(safeParseSpec(alias)).toMatchObject({ ok: false });

    const wrongType = starterDesignSystem();
    wrongType.tokens['color.link'] = { type: 'color', value: { ref: 'space.4' } };
    expect(safeParseSpec(wrongType).ok).toBe(false);

    const cycle = starterDesignSystem();
    cycle.tokens['color.a'] = { type: 'color', value: { ref: 'color.b' } };
    cycle.tokens['color.b'] = { type: 'color', value: { ref: 'color.a' } };
    expect(safeParseSpec(cycle).ok).toBe(false);

    const theme = starterDesignSystem();
    theme.themes.dark!['color.text'] = '12px';
    expect(safeParseSpec(theme).ok).toBe(false);

    const badBind = starterDesignSystem();
    badBind.components.Card = { ...card, props: {} };
    expect(safeParseSpec(badBind).ok).toBe(false);

    const orphan = starterDesignSystem();
    orphan.components.Card = {
      ...card,
      nodes: { ...card.nodes, n_cardroot1: { ...card.nodes.n_cardroot1!, children: [] } },
    };
    expect(safeParseSpec(orphan).ok).toBe(false);

    const selfNest = starterDesignSystem();
    selfNest.components.Card = {
      ...card,
      nodes: {
        ...card.nodes,
        n_cardroot1: { ...card.nodes.n_cardroot1!, children: ['n_cardtitl1', 'n_cardself1'] },
        n_cardself1: {
          id: 'n_cardself1',
          type: 'instance',
          parentId: 'n_cardroot1',
          children: [],
          positioning: 'flow',
          style: {},
          componentRef: { componentId: 'Card', variant: {} },
          props: { values: {} },
        },
      },
    };
    expect(safeParseSpec(selfNest).ok).toBe(false);
  });
});

describe('design systems', () => {
  it('the default system starts as the starter spec and edits are validated and stored', async () => {
    const editor = await makeActor(db, 'editor');
    const ds = await defaultSystem(editor);
    expect(ds.isDefault).toBe(true);
    expect(ds.latestVersion).toBeNull();
    const detail = await getDesignSystem(db, editor, ds.id);
    expect(detail.draft).toEqual(starterDesignSystem());

    const spec = structuredClone(detail.draft);
    spec.tokens['color.primary'] = { type: 'color', value: '#ff0000' };
    const saved = await saveDesignSystemDraft(db, editor, ds.id, {
      spec,
      baseRevision: ds.revision,
    });
    expect((await getDesignSystem(db, editor, ds.id)).draft.tokens['color.primary']!.value).toBe(
      '#ff0000',
    );

    // stale revision is rejected
    await expect(
      saveDesignSystemDraft(db, editor, ds.id, { spec, baseRevision: ds.revision }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(saved.revision).not.toBe(ds.revision);

    // invalid specs never reach the database
    const bad = structuredClone(spec);
    bad.tokens['color.primary'] = { type: 'color', value: 'not-a-color' };
    await expect(saveDesignSystemDraft(db, editor, ds.id, { spec: bad })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(
      saveDesignSystemDraft(db, editor, ds.id, { spec: { schemaVersion: 2 } }),
    ).rejects.toBeInstanceOf(ValidationError);
    const [row] = await db.select().from(designSystems).where(eq(designSystems.id, ds.id));
    expect(safeParseSpec(row!.draft).ok).toBe(true);
  });

  it('tokens and components can be edited one at a time', async () => {
    const editor = await makeActor(db, 'editor');
    const ds = await defaultSystem(editor);
    await setDesignSystemToken(db, editor, ds.id, 'color.link', {
      type: 'color',
      value: { ref: 'color.primary' },
    });
    // a referenced token can't be deleted
    await expect(
      setDesignSystemToken(db, editor, ds.id, 'color.primary', null),
    ).rejects.toBeInstanceOf(ValidationError);
    await setDesignSystemToken(db, editor, ds.id, 'color.link', null);
    // deleting removes theme overrides too
    await setDesignSystemToken(db, editor, ds.id, 'color.muted', null);
    const d = (await getDesignSystem(db, editor, ds.id)).draft;
    expect(d.tokens['color.link']).toBeUndefined();
    expect(d.themes.dark!['color.muted']).toBeUndefined();
    await expect(
      setDesignSystemToken(db, editor, ds.id, 'space.4', { type: 'dimension', value: 'red' }),
    ).rejects.toBeInstanceOf(ValidationError);

    await upsertDesignSystemComponent(db, editor, ds.id, card);
    expect((await getDesignSystem(db, editor, ds.id)).draft.components.Card).toBeTruthy();
    await removeDesignSystemComponent(db, editor, ds.id, 'Card');
    expect((await getDesignSystem(db, editor, ds.id)).draft.components.Card).toBeUndefined();
    await expect(removeDesignSystemComponent(db, editor, ds.id, 'Card')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('publishing snapshots the draft into immutable versions', async () => {
    const editor = await makeActor(db, 'editor');
    const ds = await defaultSystem(editor);
    const v1 = await publishDesignSystem(db, editor, ds.id, { notes: 'First' });
    expect(v1.version).toBe(1);
    expect((await getDesignSystem(db, editor, ds.id)).system).toMatchObject({
      latestVersion: 1,
      hasUnpublishedChanges: false,
    });
    // publishing again with no changes is refused
    await expect(publishDesignSystem(db, editor, ds.id)).rejects.toBeInstanceOf(ValidationError);

    await setDesignSystemToken(db, editor, ds.id, 'color.primary', {
      type: 'color',
      value: '#00ff00',
    });
    expect((await getDesignSystem(db, editor, ds.id)).system.hasUnpublishedChanges).toBe(true);
    // the published version is unaffected by draft edits
    expect(
      (await getDesignSystemVersionSpec(db, editor, ds.id, 1)).tokens['color.primary']!.value,
    ).toBe('#4f46e5');

    await publishDesignSystem(db, editor, ds.id);
    expect((await listDesignSystemVersions(db, editor, ds.id)).map((v) => v.version)).toEqual([
      2, 1,
    ]);

    await setDesignSystemToken(db, editor, ds.id, 'color.primary', {
      type: 'color',
      value: '#0000ff',
    });
    await discardDesignSystemDraft(db, editor, ds.id);
    expect((await getDesignSystem(db, editor, ds.id)).draft.tokens['color.primary']!.value).toBe(
      '#00ff00',
    );
    await expect(getDesignSystemVersionSpec(db, editor, ds.id, 9)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('a workspace has multiple systems; default and archive rules apply', async () => {
    const editor = await makeActor(db, 'editor');
    const def = await defaultSystem(editor);
    const blank = await createDesignSystem(db, editor, {
      name: ' Brand B ',
      source: { kind: 'blank' },
    });
    expect(blank.name).toBe('Brand B');
    expect(Object.keys((await getDesignSystem(db, editor, blank.id)).draft.tokens)).toHaveLength(0);

    await setDesignSystemToken(db, editor, def.id, 'color.brand', {
      type: 'color',
      value: '#123456',
    });
    const copy = await createDesignSystem(db, editor, {
      name: 'Copy',
      source: { kind: 'copy', designSystemId: def.id },
    });
    expect((await getDesignSystem(db, editor, copy.id)).draft.tokens['color.brand']).toBeTruthy();
    await updateDesignSystemDetails(db, editor, copy.id, { name: 'Renamed', description: 'x' });
    expect((await listDesignSystems(db, editor)).map((s) => s.name)).toEqual([
      'Default',
      'Brand B',
      'Renamed',
    ]);

    await expect(archiveDesignSystem(db, editor, def.id)).rejects.toBeInstanceOf(ValidationError);
    await setDefaultDesignSystem(db, editor, blank.id);
    const list = await listDesignSystems(db, editor);
    expect(list.filter((s) => s.isDefault).map((s) => s.id)).toEqual([blank.id]);

    // new projects use the default system; a used system can't be archived
    const p = await createProject(db, editor, { name: 'P' });
    expect(p.designSystemId).toBe(blank.id);
    await setDefaultDesignSystem(db, editor, def.id);
    await expect(archiveDesignSystem(db, editor, blank.id)).rejects.toBeInstanceOf(ValidationError);
    await archiveDesignSystem(db, editor, copy.id);
    expect((await listDesignSystems(db, editor)).map((s) => s.id)).not.toContain(copy.id);
    await expect(getDesignSystem(db, editor, copy.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('viewers read but cannot edit; other workspaces see nothing', async () => {
    const editor = await makeActor(db, 'editor');
    const viewer = await makeActor(db, 'viewer', editor.workspace);
    const outsider = await makeActor(db, 'admin');
    const ds = await defaultSystem(editor);
    expect((await getDesignSystem(db, viewer, ds.id)).system.id).toBe(ds.id);
    const spec = starterDesignSystem();
    await expect(saveDesignSystemDraft(db, viewer, ds.id, { spec })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(publishDesignSystem(db, viewer, ds.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createDesignSystem(db, viewer, { name: 'x' })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(getDesignSystem(db, outsider, ds.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(saveDesignSystemDraft(db, outsider, ds.id, { spec })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(publishDesignSystem(db, outsider, ds.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      createDesignSystem(db, outsider, {
        name: 'steal',
        source: { kind: 'copy', designSystemId: ds.id },
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(getDesignSystem(db, editor, 'nope')).rejects.toBeInstanceOf(NotFoundError);
  });
});
