import { describe, expect, it } from 'vitest';
import { removeKeepingUserLayers, type RemovableNode } from './removal';

/** Tiny fake of Figma's node tree: appendChild reparents, remove deletes the subtree. */
class FakeNode implements RemovableNode {
  children: FakeNode[] = [];
  parent: FakeNode | null = null;
  removed = false;
  layoutPositioning = 'AUTO';
  private data: Record<string, string> = {};
  constructor(
    public id: string,
    public type: string,
    public x: number,
    public y: number,
    cdId?: string,
    public layoutMode = 'NONE',
  ) {
    if (cdId) this.data['cd:id'] = cdId;
  }
  get absoluteTransform(): number[][] {
    const px =
      this.parent && this.parent.type !== 'PAGE'
        ? this.parent.absoluteTransform
        : [
            [1, 0, 0],
            [0, 1, 0],
          ];
    return [
      [1, 0, px[0]![2]! + this.x],
      [0, 1, px[1]![2]! + this.y],
    ];
  }
  getPluginData(k: string) {
    return this.data[k] ?? '';
  }
  add(...kids: FakeNode[]) {
    for (const k of kids) this.appendChild(k);
    return this;
  }
  appendChild(child: RemovableNode) {
    const c = child as FakeNode;
    if (c.parent) c.parent.children = c.parent.children.filter((x) => x !== c);
    c.parent = this;
    this.children.push(c);
  }
  remove() {
    const mark = (n: FakeNode) => {
      n.removed = true;
      n.children.forEach(mark);
    };
    mark(this);
    if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this);
  }
}

describe('removeKeepingUserLayers', () => {
  it('re-push removing a managed card keeps the layer the user drew inside it, in place', () => {
    const page = new FakeNode('0:1', 'PAGE', 0, 0);
    const root = new FakeNode('1:1', 'FRAME', 100, 100, 'n_root', 'VERTICAL');
    const card = new FakeNode('1:2', 'FRAME', 20, 30, 'n_card');
    const mine = new FakeNode('1:3', 'RECTANGLE', 5, 6); // hand-made, no plugin data
    page.add(root.add(card.add(mine)));

    const res = removeKeepingUserLayers(page, [root], ['1:2']);
    expect(res).toEqual({ removed: 1, rescued: 1 });
    expect(card.removed).toBe(true);
    expect(mine.removed).toBe(false);
    expect(mine.parent).toBe(root);
    expect(mine.layoutPositioning).toBe('ABSOLUTE'); // root is auto-layout: don't reflow it
    expect(mine.absoluteTransform[0]![2]).toBe(125); // same canvas position as before
    expect(mine.absoluteTransform[1]![2]).toBe(136);
  });

  it('a replaced root frame hands its user layers to the page', () => {
    const page = new FakeNode('0:1', 'PAGE', 0, 0);
    const oldRoot = new FakeNode('2:1', 'FRAME', 10, 10, 'n_old');
    const sticker = new FakeNode('2:2', 'FRAME', 1, 2);
    const newRoot = new FakeNode('2:3', 'FRAME', 0, 0, 'n_new');
    page.add(oldRoot.add(sticker), newRoot);
    removeKeepingUserLayers(page, [newRoot, oldRoot], ['2:1']);
    expect(oldRoot.removed).toBe(true);
    expect(sticker.parent).toBe(page);
    expect([sticker.x, sticker.y]).toEqual([11, 12]);
  });

  it('does nothing when nothing is stale', () => {
    const page = new FakeNode('0:1', 'PAGE', 0, 0);
    expect(removeKeepingUserLayers(page, [], [])).toEqual({ removed: 0, rescued: 0 });
  });
});
