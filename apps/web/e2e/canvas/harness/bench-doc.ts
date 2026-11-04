/** Benchmark document (Story 3.0/3.10 size): N frames of ~300 nodes each. */
import { SCHEMA_VERSION, type DesignDoc, type Node } from '@crunch/doc-model';

export function benchDoc(frames = 10, sections = 13): DesignDoc {
  const nodes: Record<string, Node> = {};
  let seq = 0;
  const nid = () => `n_b${String(seq++).padStart(9, '0')}`;
  const add = (n: Node) => {
    nodes[n.id] = n;
    if (n.parentId) nodes[n.parentId]!.children.push(n.id);
    return n;
  };
  const box = (
    parentId: string | null,
    style: Node['style'],
    tag: 'div' | 'section' | 'main' = 'div',
  ) =>
    add({
      id: nid(),
      type: 'box',
      tag,
      parentId,
      children: [],
      positioning: 'flow',
      props: {},
      style,
    });
  const text = (parentId: string, t: string, tag: 'h2' | 'p' | 'span', style: Node['style']) =>
    add({
      id: nid(),
      type: 'text',
      tag,
      parentId,
      children: [],
      positioning: 'flow',
      props: { text: t },
      style,
    });

  const out: DesignDoc['frames'] = [];
  for (let f = 0; f < frames; f++) {
    const root = box(
      null,
      {
        base: {
          display: 'flex',
          flexDirection: 'column',
          width: 'fill',
          backgroundColor: { token: 'color.background' },
          fontFamily: { token: 'font.sans' },
        },
      },
      'main',
    );
    for (let s = 0; s < sections; s++) {
      const sec = box(
        root.id,
        {
          base: {
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
            paddingTop: 32,
            paddingBottom: 32,
            paddingLeft: 48,
            paddingRight: 48,
          },
        },
        'section',
      );
      text(sec.id, `Section ${s + 1} of frame ${f + 1}`, 'h2', {
        base: { fontSize: 28, fontWeight: 700, color: { token: 'color.text' } },
      });
      const row = box(sec.id, {
        base: { display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 16 },
      });
      for (let c = 0; c < 4; c++) {
        const card = box(row.id, {
          base: {
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            paddingTop: 16,
            paddingBottom: 16,
            paddingLeft: 16,
            paddingRight: 16,
            borderRadius: 12,
            backgroundColor: { token: 'color.surface' },
          },
        });
        text(card.id, `Card ${c + 1}`, 'h2', { base: { fontSize: 18, fontWeight: 600 } });
        text(card.id, 'Every frame is real DOM, so what you see is what ships.', 'p', {
          base: { fontSize: 14, color: { token: 'color.muted' } },
        });
        const btn = box(card.id, {
          base: {
            display: 'inline-flex',
            paddingTop: 6,
            paddingBottom: 6,
            paddingLeft: 12,
            paddingRight: 12,
            borderRadius: 8,
            backgroundColor: { token: 'color.primary' },
          },
        });
        text(btn.id, 'Action', 'span', { base: { color: '#ffffff', fontSize: 13 } });
      }
    }
    out.push({
      id: `f_bench${String(f).padStart(5, '0')}`,
      name: `Frame ${f + 1}`,
      rootNodeId: root.id,
      canvas: { x: (f % 5) * 1480, y: Math.floor(f / 5) * 3600 },
      width: 1280,
      height: 'auto',
      previewBreakpoints: [],
    });
  }
  return { schemaVersion: SCHEMA_VERSION, frames: out, nodes, sliders: [], tokenOverrides: {} };
}
