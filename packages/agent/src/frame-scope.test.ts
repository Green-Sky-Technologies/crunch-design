import { describe, expect, it } from 'vitest';
import { sampleLandingDoc, starterDesignSystem, type DocOp } from '@crunch/doc-model';
import { executeTool, frameScopeViolation, memoryHost } from './index';

const ds = starterDesignSystem();
const gap = (id: string): DocOp => ({
  op: 'setStyle',
  id,
  breakpoint: 'base',
  prop: 'gap',
  value: 4,
});
const newFrame = (n: number) => ({
  frame: {
    id: `f_new0000000${n}`,
    name: `New ${n}`,
    rootNodeId: `n_newroot000${n}`,
    width: 1280,
    height: 'auto' as const,
  },
  nodes: [
    {
      id: `n_newroot000${n}`,
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

describe('frame scope (structural job scope)', () => {
  it('redesign: edits only its target frames, no new frames, no token overrides', async () => {
    const host = memoryHost(sampleLandingDoc(), ds, {
      runtime: 'job',
      frameScope: { frameIds: ['f_desktop001'], createdFrameIds: [], allowNewFrames: false },
    });
    expect(
      (await executeTool(host, 'patch_nodes', { label: 'x', ops: [gap('n_hero000001')] })).isError,
    ).toBe(false);
    const frame = await executeTool(host, 'insert_frame', newFrame(1));
    expect(JSON.parse(frame.content).error).toMatch(/cannot add frames/);
    const token = await executeTool(host, 'patch_nodes', {
      label: 'x',
      ops: [{ op: 'setTokenOverride', path: 'color.primary', value: '#000000' }],
    });
    expect(JSON.parse(token.content).error).toMatch(/every frame/);
  });

  it('alternatives: the original is read-only; frames the job creates are editable', async () => {
    const host = memoryHost(sampleLandingDoc(), ds, {
      runtime: 'job',
      frameScope: { frameIds: [], createdFrameIds: [], allowNewFrames: true },
    });
    const orig = await executeTool(host, 'patch_nodes', { label: 'x', ops: [gap('n_hero000001')] });
    expect(JSON.parse(orig.content).error).toMatch(/outside this job's frames/);
    expect((await executeTool(host, 'insert_frame', newFrame(2))).isError).toBe(false);
    expect(
      (await executeTool(host, 'patch_nodes', { label: 'x', ops: [gap('n_newroot0002')] })).isError,
    ).toBe(false);
  });

  it('tracks nodes and frames inserted earlier in the same batch', () => {
    const doc = sampleLandingDoc();
    const scope = { frameIds: [], createdFrameIds: [], allowNewFrames: true };
    const f = newFrame(3);
    const ops: DocOp[] = [
      {
        op: 'insertFrame',
        index: 1,
        frame: { ...f.frame, canvas: { x: 0, y: 0 }, previewBreakpoints: [] },
        nodes: f.nodes as never,
      },
      gap('n_newroot0003'),
      { op: 'updateFrame', id: 'f_new00000003', patch: { name: 'Renamed' } },
    ];
    expect(frameScopeViolation(doc, scope, ops)).toBeNull();
    expect(frameScopeViolation(doc, scope, [{ op: 'removeFrame', id: 'f_desktop001' }])).toMatch(
      /outside/,
    );
  });
});
