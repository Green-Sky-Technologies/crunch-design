import { HANDOFF_SCHEMA_VERSION, handoffBundle } from '@crunch/contracts';
import { sampleLandingDoc, starterDesignSystem } from '@crunch/doc-model';
import { describe, expect, it } from 'vitest';
import {
  buildHandoffBundle,
  frameNodes,
  handoffJsonSchema,
  HANDOFF_README,
  resolveTokens,
  summarizeIntent,
} from './bundle';
import { ExportError } from './html';

const ds = starterDesignSystem();
const project = {
  id: '3f2b8f0e-8a39-4b8e-9a51-0d6f4c1c2e11',
  name: 'Landing',
  description: 'Marketing site for Acme',
};

function build(over: Partial<Parameters<typeof buildHandoffBundle>[0]> = {}) {
  return buildHandoffBundle({
    project,
    doc: sampleLandingDoc(),
    designSystem: { spec: ds, version: 3 },
    intent: {
      projectName: project.name,
      projectDescription: project.description,
      versions: [{ name: 'Review', description: 'Hero copy approved' }],
      conversationTitles: ['Darker hero', null],
    },
    generatedAt: new Date('2026-11-03T12:00:00Z'),
    ...over,
  });
}

describe('handoff bundle', () => {
  it('validates against the contract schema', () => {
    const b = build();
    expect(handoffBundle.safeParse(b).success).toBe(true);
    // Round-trips through JSON (what consumers actually read).
    expect(handoffBundle.parse(JSON.parse(JSON.stringify(b)))).toEqual(b);
    expect(b.schemaVersion).toBe(HANDOFF_SCHEMA_VERSION);
    expect(b.generatedAt).toBe('2026-11-03T12:00:00.000Z');
    expect(b.designSystem.version).toBe(3);
    expect(b.responsive).toEqual({
      breakpoints: { md: ds.breakpoints.md, lg: ds.breakpoints.lg },
      approach: 'mobile-first',
    });
  });

  it('includes pre-order nodes and annotation-free HTML per frame', () => {
    const doc = sampleLandingDoc();
    const [f] = build().frames;
    expect(f!.frame).toEqual(doc.frames[0]);
    expect(f!.nodes[0]!.id).toBe(doc.frames[0]!.rootNodeId);
    expect(f!.nodes).toHaveLength(Object.keys(doc.nodes).length);
    // Pre-order: every node appears after its parent.
    const pos = new Map(f!.nodes.map((n, i) => [n.id, i]));
    for (const n of f!.nodes)
      if (n.parentId) expect(pos.get(n.parentId)!).toBeLessThan(pos.get(n.id)!);
    expect(f!.html).toContain('<!doctype html>');
    expect(f!.html).not.toContain('data-cd-id');
    expect(f!.screenshots).toEqual({});
  });

  it('inventories component usage', () => {
    const b = build();
    const doc = sampleLandingDoc();
    const instances = Object.values(doc.nodes).filter((n) => n.type === 'instance');
    expect(b.components.flatMap((c) => c.usages).sort()).toEqual(instances.map((n) => n.id).sort());
  });

  it('resolves tokens (aliases followed, valid overrides applied)', () => {
    const tokens = resolveTokens(ds);
    expect(Object.keys(tokens).sort()).toEqual(Object.keys(ds.tokens).sort());
    for (const v of Object.values(tokens)) expect(['string', 'number']).toContain(typeof v);
    const withOverride = resolveTokens(ds, { 'color.background': '#000000', 'nope.x': 1 });
    expect(withOverride['color.background']).toBe('#000000');
    expect(withOverride).not.toHaveProperty('nope.x');
  });

  it('builds a deterministic intent summary without an LLM', () => {
    const intent = build().intent;
    expect(intent.summary).toContain('Marketing site for Acme');
    expect(intent.summary).toContain('1 frame');
    expect(intent.notes).toEqual([
      'Version “Review”: Hero copy approved',
      'Agent conversation: Darker hero',
    ]);
    const noDesc = summarizeIntent(
      { projectName: 'X', projectDescription: null },
      sampleLandingDoc(),
    );
    expect(noDesc.summary).toContain('Design for “X”');
    expect(noDesc.notes).toEqual([]);
    const long = summarizeIntent(
      {
        projectName: 'X',
        projectDescription: 'd'.repeat(20_000),
        versions: Array.from({ length: 150 }, (_, i) => ({ name: `v${i}`, description: null })),
      },
      sampleLandingDoc(),
    );
    expect(long.summary.length).toBeLessThanOrEqual(10_000);
    expect(long.notes).toHaveLength(100);
  });

  it('accepts a precomputed intent and a frame subset; rejects unknown frames', () => {
    const doc = sampleLandingDoc();
    const b = build({
      intent: { summary: 'Given', notes: [] },
      frameIds: [doc.frames[0]!.id],
      screenshots: { [doc.frames[0]!.id]: { base: 'https://x/base.png' } },
    });
    expect(b.intent.summary).toBe('Given');
    expect(b.frames[0]!.screenshots).toEqual({ base: 'https://x/base.png' });
    expect(() => build({ frameIds: ['f_nope000001'] })).toThrow(ExportError);
  });

  it('ships a JSON Schema and agent instructions', () => {
    const schema = handoffJsonSchema() as { type?: string; properties?: Record<string, unknown> };
    expect(schema.type).toBe('object');
    expect(Object.keys(schema.properties ?? {})).toEqual(
      expect.arrayContaining(['schemaVersion', 'frames', 'designSystem', 'intent', 'responsive']),
    );
    expect(HANDOFF_README).toContain('Implement handoff.json');
  });

  it('frameNodes tolerates missing children', () => {
    const doc = sampleLandingDoc();
    const root = doc.nodes[doc.frames[0]!.rootNodeId]!;
    const broken = {
      ...doc,
      nodes: { ...doc.nodes, [root.id]: { ...root, children: ['n_missing001'] } },
    };
    expect(frameNodes(broken, root.id).map((n) => n.id)).toEqual([root.id]);
  });
});
