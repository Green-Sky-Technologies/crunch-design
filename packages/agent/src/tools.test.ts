import { describe, expect, it, vi } from 'vitest';
import { AGENT_TOOLS, toolsFor } from '@crunch/contracts';
import { sampleLandingDoc, starterDesignSystem, type DocOp } from '@crunch/doc-model';
import {
  contractToolDefs,
  executeTool,
  memoryHost,
  outline,
  scopeViolation,
  subtree,
  breadcrumb,
} from './index';

const doc = () => sampleLandingDoc();
const ds = starterDesignSystem();
const json = (r: { content: string }) => JSON.parse(r.content);

const setGap = (id: string, value: unknown): DocOp => ({
  op: 'setStyle',
  id,
  breakpoint: 'base',
  prop: 'gap',
  value,
});

describe('context views', () => {
  it('outlines frames and nodes compactly, with depth limits', () => {
    const text = outline(doc());
    expect(text).toContain('frame f_desktop001 "Landing — Desktop"');
    expect(text).toContain('n_herotitle1 text<h1> "Headline"');
    expect(text).toContain('instance(Button)');
    const shallow = outline(doc(), { maxDepth: 1 });
    expect(shallow).not.toContain('n_herotitle1');
    expect(shallow).toMatch(/… 3 children/);
    expect(outline(doc())).toBe(outline(doc())); // deterministic
  });

  it('returns a subtree in pre-order and a breadcrumb', () => {
    const s = subtree(doc(), 'n_hero000001')!;
    expect(s.nodes[0]!.id).toBe('n_hero000001');
    expect(s.nodes.map((n) => n.id)).toContain('n_herotitle1');
    expect(subtree(doc(), 'n_missing0000')).toBeNull();
    expect(breadcrumb(doc(), 'n_herotitle1')).toBe('Page › Hero › Headline');
  });
});

describe('tool definitions', () => {
  it('covers every contract tool for each runtime, in toolsFor order, with JSON schemas', () => {
    const interactive = contractToolDefs('interactive');
    expect(interactive.map((t) => t.name)).toEqual(toolsFor('interactive').map((t) => t.name));
    expect(interactive.map((t) => t.name)).not.toContain('capture_url');
    expect(contractToolDefs('job').map((t) => t.name)).toContain('capture_url');
    for (const t of contractToolDefs('job')) expect(t.input_schema.type).toBe('object');
    expect(JSON.stringify(contractToolDefs('job'))).toBe(JSON.stringify(contractToolDefs('job')));
  });
});

describe('tool handlers', () => {
  it('validates input with Zod and reports errors as tool results', async () => {
    const host = memoryHost(doc(), ds);
    const r = await executeTool(host, 'get_subtree', { nodeId: 1 });
    expect(r.isError).toBe(true);
    expect(json(r).error).toMatch(/Invalid input for get_subtree/);
    expect((await executeTool(host, 'nope', {})).isError).toBe(true);
    expect((await executeTool(host, 'patch_nodes', { label: 'x', ops: [] })).isError).toBe(true);
    expect(
      (await executeTool(host, 'patch_nodes', { label: 'x', ops: [{ op: 'explode' }] })).isError,
    ).toBe(true);
  });

  it('patch_nodes commits one transaction touching only the targeted node', async () => {
    const host = memoryHost(doc(), ds);
    const r = await executeTool(host, 'patch_nodes', {
      label: 'Bigger headline',
      ops: [
        {
          op: 'setStyle',
          id: 'n_herotitle1',
          breakpoint: 'base',
          prop: 'fontSize',
          value: { token: 'text.6xl' },
        },
      ],
    });
    expect(r.isError).toBe(false);
    expect(r.touched).toEqual(['n_herotitle1']);
    expect(host.commits).toHaveLength(1);
    expect(host.doc.nodes['n_herotitle1']!.style.base?.fontSize).toEqual({ token: 'text.6xl' });
  });

  it('surfaces reducer errors so the model can correct itself', async () => {
    const host = memoryHost(doc(), ds);
    const r = await executeTool(host, 'patch_nodes', {
      label: 'x',
      ops: [{ op: 'removeNode', id: 'n_missing0001' }],
    });
    expect(r.isError).toBe(true);
    expect(json(r).error).toMatch(/not found/);
    expect(host.commits).toHaveLength(0);
  });

  it('enforces subtree scope unless a wider change is approved', async () => {
    const scoped = memoryHost(doc(), ds, {
      scope: { rootNodeId: 'n_hero000001', allowWider: false },
    });
    const inside = await executeTool(scoped, 'patch_nodes', {
      label: 'ok',
      ops: [setGap('n_hero000001', { token: 'space.8' })],
    });
    expect(inside.isError).toBe(false);
    const outside = await executeTool(scoped, 'patch_nodes', {
      label: 'no',
      ops: [setGap('n_features01', 4)],
    });
    expect(outside.isError).toBe(true);
    expect(json(outside).error).toMatch(/Out of scope/);
    expect((await executeTool(scoped, 'insert_frame', { frame: {}, nodes: [] })).isError).toBe(
      true,
    );

    const wide = memoryHost(doc(), ds, { scope: { rootNodeId: 'n_hero000001', allowWider: true } });
    expect(
      (await executeTool(wide, 'patch_nodes', { label: 'ok', ops: [setGap('n_features01', 4)] }))
        .isError,
    ).toBe(false);
  });

  it('scopeViolation allows inserts under scoped parents and edits to the new nodes', () => {
    const d = doc();
    const ops: DocOp[] = [
      {
        op: 'insertSubtree',
        parentId: 'n_hero000001',
        index: 0,
        nodes: [
          {
            id: 'n_newbadge01',
            type: 'text',
            tag: 'span',
            parentId: 'n_hero000001',
            children: [],
            positioning: 'flow',
            style: {},
            props: { text: 'New' },
          },
        ],
      },
      setGap('n_newbadge01', 2),
    ];
    expect(scopeViolation(d, 'n_hero000001', ops)).toBeNull();
    expect(scopeViolation(d, 'n_hero000001', [{ op: 'removeNode', id: 'n_hero000001' }])).toMatch(
      /scoped node itself/,
    );
    expect(
      scopeViolation(d, 'n_hero000001', [
        { op: 'setTokenOverride', path: 'color.primary', value: '#000' },
      ]),
    ).toMatch(/outside/);
  });

  it('caps patch size on the interactive path', async () => {
    const host = memoryHost(doc(), ds, { maxOpsPerPatch: 2 });
    const ops = [1, 2, 3].map((v) => setGap('n_hero000001', v));
    const r = await executeTool(host, 'patch_nodes', { label: 'x', ops });
    expect(json(r).error).toMatch(/generation job/);
  });

  it('insert_frame places new frames beside existing ones', async () => {
    const host = memoryHost(doc(), ds);
    const onFrameCreated = vi.fn();
    host.onFrameCreated = onFrameCreated;
    const r = await executeTool(host, 'insert_frame', {
      frame: {
        id: 'f_alt0000001',
        name: 'Alt',
        rootNodeId: 'n_altroot001',
        width: 1280,
        height: 'auto',
      },
      nodes: [
        {
          id: 'n_altroot001',
          type: 'box',
          tag: 'main',
          parentId: null,
          children: [],
          positioning: 'flow',
          style: {},
          props: {},
        },
      ],
    });
    expect(r.isError).toBe(false);
    expect(json(r)).toMatchObject({ frameId: 'f_alt0000001', canvas: { x: 1440, y: 0 } });
    expect(host.doc.frames).toHaveLength(2);
    expect(onFrameCreated).toHaveBeenCalledOnce();
  });

  it('create_slider validates bindings and stores an agent slider', async () => {
    const host = memoryHost(doc(), ds);
    const slider = {
      id: 's_density001',
      label: 'Density',
      min: 0,
      max: 10,
      step: 1,
      value: 5,
      bindings: [
        {
          target: { nodeId: 'n_features01', prop: 'gap', breakpoint: 'base' },
          map: { type: 'linear', from: 4, to: 40 },
        },
      ],
    };
    const r = await executeTool(host, 'create_slider', { slider });
    expect(r.isError).toBe(false);
    expect(host.doc.sliders[0]).toMatchObject({ id: 's_density001', createdBy: 'agent' });
    const bad = await executeTool(host, 'create_slider', {
      slider: {
        ...slider,
        id: 's_bad0000001',
        bindings: [{ target: { token: 'color.nope' }, map: slider.bindings[0]!.map }],
      },
    });
    expect(json(bad).error).toMatch(/unknown token/);
  });

  it('reads the design system and runs the linter through its contract', async () => {
    const lint = vi.fn((..._args: unknown[]) => [
      {
        code: 'contrast' as const,
        severity: 'error' as const,
        message: 'Low contrast',
        nodeId: 'n_herobody01',
      },
    ]);
    const host = memoryHost(doc(), ds, {
      scope: { rootNodeId: 'n_hero000001', allowWider: false },
      lint,
    });
    const dsRes = json(await executeTool(host, 'get_design_system', { sections: ['tokens'] }));
    expect(Object.keys(dsRes)).not.toContain('components');
    expect(dsRes.tokens['color.primary']).toBeDefined();
    const lintRes = json(await executeTool(host, 'run_lint', {}));
    expect(lintRes).toMatchObject({ count: 1, issues: [{ code: 'contrast', hasFix: false }] });
    expect(lint.mock.calls[0]![2]).toMatchObject({
      nodeIds: expect.arrayContaining(['n_herotitle1']),
    });
  });

  it('keeps job-only tools out of the interactive runtime', async () => {
    const interactive = memoryHost(doc(), ds);
    expect(
      json(await executeTool(interactive, 'capture_url', { url: 'https://example.com' })).error,
    ).toMatch(/only available in background jobs/);
    const job = memoryHost(doc(), ds, { runtime: 'job' });
    expect(
      json(await executeTool(job, 'capture_url', { url: 'https://example.com' })).error,
    ).toMatch(/not available yet/);
    expect(Object.keys(AGENT_TOOLS)).toHaveLength(10);
  });
});
