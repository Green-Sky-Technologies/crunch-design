import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ForbiddenError } from '@crunch/authz';
import { sampleLandingDoc, starterDesignSystem } from '@crunch/doc-model';
import { diffSystemsForDoc } from '@/server/services/design-systems/diff';
import {
  createDesignSystem,
  listDesignSystems,
  publishDesignSystem,
  setDesignSystemToken,
} from '@/server/services/design-systems';
import {
  previewProjectDesignSystemSwitch,
  resolveProjectDesignSystem,
  switchProjectDesignSystem,
} from '@/server/services/project-design-system';
import { createProject, getProject } from '@/server/services/projects';
import { NotFoundError } from '@/server/services/types';
import { makeActor, reset, testDb } from './helpers';

describe('diffSystemsForDoc (Story 4.3 preview)', () => {
  it('reports only what the doc uses', () => {
    const doc = sampleLandingDoc();
    const from = starterDesignSystem();
    expect(diffSystemsForDoc(doc, from, starterDesignSystem()).unchanged).toBe(true);

    const to = starterDesignSystem();
    to.tokens['color.primary'] = { type: 'color', value: '#ff0000' }; // used inside Button
    to.tokens['color.accent'] = { type: 'color', value: '#00ff00' }; // not used by the doc
    delete to.tokens['color.surface']; // used by feature cards
    to.tokens['text.lg'] = { type: 'dimension', value: '1.2rem' }; // type change
    to.breakpoints = { md: 800, lg: 1200 };
    delete to.themes.dark;
    to.components.Button!.variants.variant!.options = ['primary'];
    to.components.Button!.variants.variant!.default = 'primary';
    to.components.Button!.variantStyles = [];

    const d = diffSystemsForDoc(doc, from, to);
    expect(d.unchanged).toBe(false);
    const byPath = Object.fromEntries(d.tokens.map((t) => [t.path, t]));
    expect(byPath['color.primary']).toMatchObject({
      kind: 'changed',
      from: '#4f46e5',
      to: '#ff0000',
    });
    expect(byPath['color.primary']!.nodeCount).toBeGreaterThan(0);
    expect(byPath['color.surface']).toMatchObject({ kind: 'missing', to: null });
    expect(byPath['text.lg']).toMatchObject({ kind: 'type-changed' });
    expect(byPath['color.accent']).toBeUndefined();
    expect(d.components).toHaveLength(1);
    expect(d.components[0]).toMatchObject({ id: 'Button', kind: 'changed' });
    expect(d.breakpoints).toEqual({ from: { md: 768, lg: 1024 }, to: { md: 800, lg: 1200 } });
    expect(d.themesRemoved).toEqual(['dark']);

    const noButton = starterDesignSystem();
    delete noButton.components.Button;
    expect(diffSystemsForDoc(doc, from, noButton).components[0]).toMatchObject({
      kind: 'missing',
    });
  });

  it('flags project token overrides that the target cannot apply', () => {
    const doc = { ...sampleLandingDoc(), tokenOverrides: { 'color.primary': '#000000' } };
    const to = starterDesignSystem();
    delete to.tokens['color.primary'];
    to.tokens['color.cta'] = { type: 'color', value: '#123456' };
    to.components.Button!.nodes.n_btnroot01!.style.base!.backgroundColor = { token: 'color.cta' };
    expect(diffSystemsForDoc(doc, starterDesignSystem(), to).overridesDropped).toEqual([
      'color.primary',
    ]);
  });
});

describe('switching a project between systems', () => {
  const { db, close } = testDb();
  afterAll(close);
  beforeEach(() => reset(db));

  it('previews then switches, pinning the target version', async () => {
    const editor = await makeActor(db, 'editor');
    const [def] = await listDesignSystems(db, editor);
    const brand = await createDesignSystem(db, editor, { name: 'Brand' });
    await setDesignSystemToken(db, editor, brand.id, 'color.background', {
      type: 'color',
      value: '#000000',
    });
    const p = await createProject(db, editor, { name: 'P' });

    // Brand v1 (created with the system) is the starter; the draft edit isn't published yet.
    const v1Preview = await previewProjectDesignSystemSwitch(db, editor, p.id, {
      designSystemId: brand.id,
    });
    expect(v1Preview.target).toMatchObject({ name: 'Brand', version: 1 });
    expect(v1Preview.diff.unchanged).toBe(true);

    await publishDesignSystem(db, editor, brand.id);
    const preview = await previewProjectDesignSystemSwitch(db, editor, p.id, {
      designSystemId: brand.id,
    });
    expect(preview.target).toMatchObject({ version: 2 });
    expect(preview.diff.tokens.map((t) => t.path)).toEqual(['color.background']);
    // Previewing writes nothing.
    expect((await getProject(db, editor, p.id)).designSystemId).toBe(def!.id);
    await setDesignSystemToken(db, editor, brand.id, 'color.background', {
      type: 'color',
      value: '#222222',
    });
    const r = await switchProjectDesignSystem(db, editor, p.id, { designSystemId: brand.id });
    expect(r).toMatchObject({ id: brand.id, version: 2, pinned: true });
    const resolved = await resolveProjectDesignSystem(
      db,
      editor,
      await getProject(db, editor, p.id),
    );
    expect(resolved.spec.tokens['color.background']!.value).toBe('#000000');

    // Switching always pins a real version, never a draft.
    const back = await switchProjectDesignSystem(db, editor, p.id, { designSystemId: def!.id });
    expect(back).toMatchObject({ id: def!.id, version: 1, pinned: true });
    await setDesignSystemToken(db, editor, def!.id, 'color.background', {
      type: 'color',
      value: '#333333',
    });
    const after = await resolveProjectDesignSystem(db, editor, await getProject(db, editor, p.id));
    expect(after.spec.tokens['color.background']!.value).toBe('#ffffff');
    const v1 = await switchProjectDesignSystem(db, editor, p.id, {
      designSystemId: brand.id,
      version: 1,
    });
    expect(v1).toMatchObject({ version: 1, pinned: true });
    await expect(
      switchProjectDesignSystem(db, editor, p.id, { designSystemId: brand.id, version: 5 }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('enforces permissions and workspace scoping', async () => {
    const editor = await makeActor(db, 'editor');
    const viewer = await makeActor(db, 'viewer', editor.workspace);
    const outsider = await makeActor(db, 'admin');
    const [foreign] = await listDesignSystems(db, outsider);
    const p = await createProject(db, editor, { name: 'P' });
    const [def] = await listDesignSystems(db, editor);

    // Viewers may preview but not switch.
    await previewProjectDesignSystemSwitch(db, viewer, p.id, { designSystemId: def!.id });
    await expect(
      switchProjectDesignSystem(db, viewer, p.id, { designSystemId: def!.id }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // Another workspace's system is invisible.
    await expect(
      switchProjectDesignSystem(db, editor, p.id, { designSystemId: foreign!.id }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      previewProjectDesignSystemSwitch(db, outsider, p.id, { designSystemId: foreign!.id }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
