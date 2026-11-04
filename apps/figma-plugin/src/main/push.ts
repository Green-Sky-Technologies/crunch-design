/**
 * Applies a PushPlan to the current page (Story 8.2).
 *
 * Every node we create carries the CrunchDesign NodeId in plugin data. On a re-push we collect the
 * managed nodes under the previously pushed frame, `reconcile()` them against the plan, and then
 * update matched nodes in place, create only the new ones and remove only the stale ones. Nodes
 * the user added by hand (no plugin data) are left alone. Unchanged nodes (same hash) skip
 * property writes entirely.
 */
import {
  flattenSpecs,
  PLUGIN_COMPONENT_KEY,
  PLUGIN_DATA_KEY,
  PLUGIN_FRAME_KEY,
  PLUGIN_HASH_KEY,
  PLUGIN_KIND_KEY,
  PLUGIN_PROJECT_KEY,
  reconcile,
  type BindableField,
  type ComponentSpec,
  type ExistingNode,
  type FrameSpec,
  type ImageSpec,
  type InstanceSpec,
  type NodeSpec,
  type PaintSpec,
  type PushPlan,
  type ReportItem,
  type TextSpec,
} from '@crunch/figma-convert/plugin';
import { collector, type Note } from './note';
import { dataUrlBytes, effect, gradientPaint, solidPaint } from './paints';
import { removeKeepingUserLayers, type RemovableNode } from './removal';
import { upsertVariables } from './variables';

export interface PushOutcome {
  nodeMap: Record<string, string>;
  report: ReportItem[];
  created: number;
  updated: number;
  unchanged: number;
  removed: number;
  pageId: string;
}

const COMPONENTS_ROOT_KEY = 'cd:components-root';
const FALLBACK_FONT: FontName = { family: 'Inter', style: 'Regular' };

const NODE_FIELDS: BindableField[] = [
  'width',
  'height',
  'minWidth',
  'maxWidth',
  'minHeight',
  'maxHeight',
  'itemSpacing',
  'counterAxisSpacing',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'topLeftRadius',
  'topRightRadius',
  'bottomLeftRadius',
  'bottomRightRadius',
  'strokeWeight',
  'opacity',
];
const TEXT_FIELDS: BindableField[] = ['fontFamily', 'fontSize', 'fontWeight', 'letterSpacing'];

type Parent = BaseNode & ChildrenMixin;
type Managed = SceneNode;

const isAutoLayout = (n: BaseNode | null): boolean =>
  !!n &&
  (n.type === 'FRAME' || n.type === 'COMPONENT' || n.type === 'INSTANCE') &&
  (n as FrameNode).layoutMode !== 'NONE';

/** Managed nodes under (and including) `root`, without descending into instances. */
function collectManaged(root: SceneNode): { node: Managed; existing: ExistingNode }[] {
  const out: { node: Managed; existing: ExistingNode }[] = [];
  const visit = (n: SceneNode) => {
    const cdId = n.getPluginData(PLUGIN_DATA_KEY);
    if (cdId) {
      out.push({
        node: n,
        existing: {
          cdId,
          figmaId: n.id,
          kind: n.getPluginData(PLUGIN_KIND_KEY),
          hash: n.getPluginData(PLUGIN_HASH_KEY),
        },
      });
    }
    if (n.type !== 'INSTANCE' && 'children' in n) for (const c of n.children) visit(c);
  };
  visit(root);
  return out;
}

class Applier {
  readonly nodeMap: Record<string, string> = {};
  created = 0;
  updated = 0;
  unchanged = 0;
  removed = 0;
  private fonts = new Set<string>();
  private failedFonts = new Set<string>();
  readonly components = new Map<string, ComponentNode>();
  /** componentKey -> (definition NodeId -> child index path inside the component). */
  readonly componentPaths = new Map<string, Map<string, number[]>>();
  private images = new Map<string, string | null>();

  constructor(
    private readonly vars: Map<string, Variable>,
    private readonly note: Note,
  ) {}

  // -------------------------------------------------------------- fonts

  async loadFonts(specs: NodeSpec[]) {
    const wanted = new Map<string, FontName>();
    for (const s of specs)
      if (s.kind === 'TEXT') wanted.set(`${s.font.family}|${s.font.style}`, s.font);
    await figma.loadFontAsync(FALLBACK_FONT);
    this.fonts.add(`${FALLBACK_FONT.family}|${FALLBACK_FONT.style}`);
    await Promise.all(
      [...wanted].map(async ([key, font]) => {
        try {
          await figma.loadFontAsync(font);
          this.fonts.add(key);
        } catch {
          this.failedFonts.add(key);
        }
      }),
    );
  }

  private font(spec: TextSpec): FontName {
    const key = `${spec.font.family}|${spec.font.style}`;
    if (this.fonts.has(key)) return spec.font;
    this.note(
      'warning',
      `Font "${spec.font.family} ${spec.font.style}" isn't available; used Inter Regular`,
      spec.font.family,
    );
    return FALLBACK_FONT;
  }

  // -------------------------------------------------------------- variables

  private variable(token: string | undefined): Variable | null {
    if (!token) return null;
    const v = this.vars.get(token);
    return v ?? null;
  }

  private async paints(list: PaintSpec[], at: NodeSpec): Promise<Paint[]> {
    const out: Paint[] = [];
    for (const p of list) {
      if (p.type === 'SOLID') {
        let paint: SolidPaint = solidPaint(p.color);
        const v = this.variable(p.bind);
        if (v) paint = figma.variables.setBoundVariableForPaint(paint, 'color', v);
        out.push(paint);
      } else if (p.type === 'IMAGE') {
        const hash = await this.imageHash(p.src, at);
        if (hash)
          out.push({
            type: 'IMAGE',
            imageHash: hash,
            scaleMode: p.scaleMode,
            visible: true,
            opacity: 1,
            blendMode: 'NORMAL',
          });
        else out.push(solidPaint({ r: 0.9, g: 0.9, b: 0.9, a: 1 }));
      } else out.push(gradientPaint(p));
    }
    return out;
  }

  private async imageHash(src: string, at: NodeSpec): Promise<string | null> {
    if (this.images.has(src)) return this.images.get(src)!;
    let hash: string | null = null;
    try {
      const bytes = dataUrlBytes(src, (b) => figma.base64Decode(b));
      const image = bytes ? figma.createImage(bytes) : await figma.createImageAsync(src);
      hash = image.hash;
    } catch {
      this.note(
        'warning',
        "Image couldn't be loaded (its host must be allowed in the plugin manifest); used a placeholder",
        'image',
        at.cdId,
      );
    }
    this.images.set(src, hash);
    return hash;
  }

  private bind(node: SceneNode, spec: NodeSpec) {
    const fields = spec.kind === 'TEXT' ? [...NODE_FIELDS, ...TEXT_FIELDS] : NODE_FIELDS;
    const bindable = node as SceneNode & {
      setBoundVariable(field: string, v: Variable | null): void;
      boundVariables?: Record<string, unknown>;
    };
    for (const field of fields) {
      const v = this.variable(spec.binds[field]);
      try {
        if (v) bindable.setBoundVariable(field, v);
        else if (bindable.boundVariables?.[field]) bindable.setBoundVariable(field, null);
      } catch {
        if (v)
          this.note(
            'info',
            `Couldn't bind ${field} to a variable; kept the literal value`,
            spec.binds[field],
          );
      }
    }
  }

  // -------------------------------------------------------------- create / apply

  private async create(spec: NodeSpec): Promise<SceneNode> {
    this.created++;
    switch (spec.kind) {
      case 'FRAME': {
        const f = figma.createFrame();
        f.fills = [];
        return f;
      }
      case 'TEXT':
        return figma.createText();
      case 'IMAGE':
        return figma.createRectangle();
      case 'SVG':
        try {
          return figma.createNodeFromSvg(spec.svg);
        } catch {
          this.note(
            'warning',
            "SVG couldn't be imported into Figma; used an empty frame",
            'svg',
            spec.cdId,
          );
          return figma.createFrame();
        }
      case 'INSTANCE': {
        const comp = this.components.get(spec.componentKey);
        if (comp) return comp.createInstance();
        this.note(
          'error',
          `Component ${spec.componentKey} missing; used an empty frame`,
          spec.componentKey,
          spec.cdId,
        );
        return figma.createFrame();
      }
    }
  }

  /** Place one spec under `parent` at `index`, reusing `existing` when given. */
  async place(
    spec: NodeSpec,
    parent: Parent,
    index: number,
    existing: Map<string, Managed>,
    plan: { update: Map<string, string>; unchanged: Set<string> },
    reuse?: SceneNode,
  ): Promise<SceneNode> {
    const figmaId = plan.update.get(spec.cdId);
    let node: SceneNode | undefined = reuse ?? (figmaId ? existing.get(figmaId) : undefined);
    let fresh = !!reuse; // a root just created by tree()
    if (node && !fresh && spec.kind === 'SVG' && !plan.unchanged.has(spec.cdId)) {
      node.remove(); // SVG content changed: re-import
      this.removed++;
      node = undefined;
    }
    if (node && spec.kind === 'INSTANCE' && node.type === 'INSTANCE') {
      const comp = this.components.get(spec.componentKey);
      const main = await node.getMainComponentAsync();
      if (comp && main?.id !== comp.id) node.swapComponent(comp);
    }
    if (!node) {
      node = await this.create(spec);
      fresh = true;
    } else if (!fresh) {
      if (plan.unchanged.has(spec.cdId)) this.unchanged++;
      else this.updated++;
    }

    if (node.parent !== parent || parent.children.indexOf(node) !== index) {
      parent.insertChild(Math.min(index, parent.children.length), node);
    }
    if (fresh || !plan.unchanged.has(spec.cdId)) await this.apply(node, spec, parent);
    node.setPluginData(PLUGIN_DATA_KEY, spec.cdId);
    node.setPluginData(PLUGIN_KIND_KEY, spec.kind);
    node.setPluginData(PLUGIN_HASH_KEY, spec.hash);
    this.nodeMap[spec.cdId] = node.id;

    if (spec.kind === 'FRAME' && 'children' in node && node.type !== 'INSTANCE') {
      for (let i = 0; i < spec.children.length; i++) {
        await this.place(spec.children[i]!, node as Parent, i, existing, plan);
      }
    }
    return node;
  }

  private async apply(node: SceneNode, spec: NodeSpec, parent: Parent) {
    node.name = spec.name;
    node.visible = spec.visible;
    if ('opacity' in node) node.opacity = spec.opacity;

    if (spec.kind === 'FRAME' && (node.type === 'FRAME' || node.type === 'COMPONENT'))
      await this.frame(node, spec);
    else if (spec.kind === 'TEXT' && node.type === 'TEXT') await this.text(node, spec);
    else if (spec.kind === 'IMAGE' && node.type === 'RECTANGLE') await this.image(node, spec);
    else if (spec.kind === 'INSTANCE' && node.type === 'INSTANCE') await this.instance(node, spec);

    if ('effects' in node) node.effects = spec.effects.map(effect);
    this.layoutChild(node, spec, parent);
    if ('rotation' in node && (spec.rotation !== 0 || node.rotation !== 0))
      node.rotation = spec.rotation;
    this.bind(node, spec);
  }

  private async frame(node: FrameNode | ComponentNode, spec: FrameSpec) {
    const l = spec.layout;
    node.layoutMode = l.mode;
    if (l.mode !== 'NONE') {
      node.layoutWrap = l.mode === 'HORIZONTAL' && l.wrap ? 'WRAP' : 'NO_WRAP';
      node.itemSpacing = l.itemSpacing;
      if (node.layoutWrap === 'WRAP') node.counterAxisSpacing = l.counterAxisSpacing;
      node.paddingTop = l.padding.top;
      node.paddingRight = l.padding.right;
      node.paddingBottom = l.padding.bottom;
      node.paddingLeft = l.padding.left;
      node.primaryAxisAlignItems = l.primaryAlign;
      node.counterAxisAlignItems = l.counterAlign;
    }
    node.fills = await this.paints(spec.fills, spec);
    node.strokes = await this.paints(spec.strokes, spec);
    if (spec.strokes.length) {
      node.strokeAlign = 'INSIDE';
      const w = spec.strokeWeights;
      if (w.top === w.right && w.top === w.bottom && w.top === w.left) node.strokeWeight = w.top;
      else {
        node.strokeTopWeight = w.top;
        node.strokeRightWeight = w.right;
        node.strokeBottomWeight = w.bottom;
        node.strokeLeftWeight = w.left;
      }
      node.dashPattern = spec.dashed ? [4, 4] : [];
    }
    node.topLeftRadius = spec.radii.topLeft;
    node.topRightRadius = spec.radii.topRight;
    node.bottomRightRadius = spec.radii.bottomRight;
    node.bottomLeftRadius = spec.radii.bottomLeft;
    node.clipsContent = spec.clipsContent;
  }

  private async text(node: TextNode, spec: TextSpec) {
    node.fontName = this.font(spec);
    node.characters = spec.characters;
    node.fontSize = Math.max(1, spec.fontSize);
    node.lineHeight = spec.lineHeight;
    node.letterSpacing = spec.letterSpacing;
    node.textAlignHorizontal = spec.textAlign;
    node.textCase = spec.textCase;
    node.textDecoration = spec.textDecoration;
    node.textAutoResize = spec.autoResize;
    node.fills = await this.paints(spec.fills, spec);
  }

  private async image(node: RectangleNode, spec: ImageSpec) {
    node.fills = await this.paints(spec.fills, spec);
    node.topLeftRadius = spec.radii.topLeft;
    node.topRightRadius = spec.radii.topRight;
    node.bottomRightRadius = spec.radii.bottomRight;
    node.bottomLeftRadius = spec.radii.bottomLeft;
  }

  private async instance(node: InstanceNode, spec: InstanceSpec) {
    node.resetOverrides();
    const paths = this.componentPaths.get(spec.componentKey);
    const at = (defId: string): SceneNode | null => {
      const path = paths?.get(defId);
      if (!path) return null;
      let cur: SceneNode = node;
      for (const i of path) {
        if (!('children' in cur)) return null;
        const next: SceneNode | undefined = cur.children[i];
        if (!next) return null;
        cur = next;
      }
      return cur;
    };
    for (const [defId, chars] of Object.entries(spec.textOverrides)) {
      const t = at(defId);
      if (t?.type !== 'TEXT') {
        this.note('warning', 'Instance text override target not found', defId, spec.cdId);
        continue;
      }
      const fn = t.fontName;
      await figma.loadFontAsync(fn === figma.mixed ? FALLBACK_FONT : fn);
      t.characters = chars;
    }
    for (const defId of spec.hidden) {
      const t = at(defId);
      if (t) t.visible = false;
    }
  }

  /** Size, sizing mode and absolute position; depends on the parent's layout. */
  private layoutChild(node: SceneNode, spec: NodeSpec, parent: Parent) {
    const auto = isAutoLayout(parent);
    if (auto && 'layoutPositioning' in node)
      node.layoutPositioning = spec.absolute ? 'ABSOLUTE' : 'AUTO';
    if ('resize' in node) {
      const w = Math.max(0.01, spec.width);
      const h = Math.max(0.01, spec.height);
      if (node.type === 'TEXT' && spec.kind === 'TEXT') {
        if (spec.autoResize !== 'WIDTH_AND_HEIGHT')
          node.resize(w, spec.autoResize === 'NONE' ? h : Math.max(1, node.height));
        node.textAutoResize = spec.autoResize;
      } else node.resize(w, h);
    }
    if ('layoutSizingHorizontal' in node) {
      const set = (
        axis: 'layoutSizingHorizontal' | 'layoutSizingVertical',
        v: NodeSpec['sizing']['horizontal'],
      ) => {
        let want = v;
        if (want === 'FILL' && (!auto || spec.absolute)) want = 'FIXED';
        if (
          want === 'HUG' &&
          !(isAutoLayout(node) || node.type === 'TEXT' || node.type === 'INSTANCE')
        )
          want = 'FIXED';
        try {
          (node as FrameNode)[axis] = want;
        } catch {
          this.note('info', `Couldn't set ${want} sizing; kept a fixed size`, axis, spec.cdId);
        }
      };
      set('layoutSizingHorizontal', spec.sizing.horizontal);
      set('layoutSizingVertical', spec.sizing.vertical);
    }
    if (spec.absolute) {
      node.x = spec.absolute.x;
      node.y = spec.absolute.y;
    }
    const minmax = node as FrameNode;
    for (const k of ['minWidth', 'maxWidth', 'minHeight', 'maxHeight'] as const) {
      const v = spec[k];
      try {
        if (v !== undefined) minmax[k] = v;
        else if (k in minmax && minmax[k] !== null) minmax[k] = null;
      } catch {
        // min/max only apply to auto-layout frames and their children
      }
    }
  }

  // -------------------------------------------------------------- trees

  /**
   * Reconcile a whole tree whose root lives at `rootNode` (null on first push) and return the
   * root node. `makeRoot` creates the root when there's nothing to update.
   */
  async tree(
    root: NodeSpec,
    rootNode: SceneNode | null,
    host: Parent,
    hostIndex: number,
    makeRoot?: () => SceneNode,
  ): Promise<SceneNode> {
    const managed = rootNode ? collectManaged(rootNode) : [];
    const planned = flattenSpecs(root).map((s) => ({ cdId: s.cdId, kind: s.kind, hash: s.hash }));
    const r = reconcile(
      planned,
      managed.map((m) => m.existing),
    );
    const byId = new Map(managed.map((m) => [m.node.id, m.node]));
    // Keep the root node's identity when it can be updated, even if it moved.
    let reuse: SceneNode | undefined;
    if (!r.update.has(root.cdId) && makeRoot) {
      reuse = makeRoot();
      this.created++;
    }
    const node = await this.place(root, host, hostIndex, byId, r, reuse);
    // Detach copies first, so they count as user layers and are kept by the removal below.
    for (const id of r.detach) {
      const n = byId.get(id);
      if (n && !n.removed) {
        n.setPluginData(PLUGIN_DATA_KEY, '');
        n.setPluginData(PLUGIN_HASH_KEY, '');
        n.setPluginData(PLUGIN_KIND_KEY, '');
      }
    }
    // Removing a stale managed node must not delete layers the user added inside it.
    const roots = [node, ...(rootNode && rootNode !== node && !rootNode.removed ? [rootNode] : [])];
    const res = removeKeepingUserLayers(
      host as unknown as RemovableNode,
      roots as unknown as RemovableNode[],
      r.remove.filter((id) => id !== node.id),
    );
    this.removed += res.removed;
    if (res.rescued)
      this.note(
        'info',
        `Kept ${res.rescued} hand-made layer(s) that were inside removed layers; moved them to the parent`,
        'layers',
      );
    return node;
  }

  recordPaths(key: string, comp: ComponentNode) {
    const paths = new Map<string, number[]>();
    const visit = (n: SceneNode, path: number[]) => {
      const id = n.getPluginData(PLUGIN_DATA_KEY);
      if (id) paths.set(id, path);
      if ('children' in n && n.type !== 'INSTANCE')
        n.children.forEach((c, i) => visit(c, [...path, i]));
    };
    visit(comp, []);
    this.componentPaths.set(key, paths);
  }
}

function componentsContainer(): FrameNode {
  const page = figma.currentPage;
  const found = page.children.find(
    (n) => n.type === 'FRAME' && n.getPluginData(COMPONENTS_ROOT_KEY) === '1',
  );
  if (found) return found as FrameNode;
  const f = figma.createFrame();
  f.name = 'CrunchDesign components';
  f.setPluginData(COMPONENTS_ROOT_KEY, '1');
  f.layoutMode = 'HORIZONTAL';
  f.layoutWrap = 'WRAP';
  f.itemSpacing = 32;
  f.counterAxisSpacing = 32;
  f.paddingTop = f.paddingBottom = f.paddingLeft = f.paddingRight = 32;
  f.primaryAxisSizingMode = 'AUTO';
  f.counterAxisSizingMode = 'AUTO';
  f.fills = [];
  const right = Math.max(0, ...page.children.filter((c) => c !== f).map((c) => c.x + c.width));
  f.x = right + 400;
  f.y = 0;
  page.appendChild(f);
  return f;
}

async function pushComponents(app: Applier, components: ComponentSpec[]) {
  if (!components.length) return;
  const container = componentsContainer();
  for (const c of components) {
    const existing = container.children.find(
      (n) => n.type === 'COMPONENT' && n.getPluginData(PLUGIN_COMPONENT_KEY) === c.key,
    ) as ComponentNode | undefined;
    const index = existing ? container.children.indexOf(existing) : container.children.length;
    let rootSpec: NodeSpec = c.root;
    if (rootSpec.kind !== 'FRAME') {
      // A component must be a frame-like node: wrap leaf roots.
      rootSpec = {
        ...rootSpec,
        kind: 'FRAME',
        cdId: `${c.root.cdId}:frame`,
        layout: {
          mode: 'VERTICAL',
          wrap: false,
          itemSpacing: 0,
          counterAxisSpacing: 0,
          padding: { top: 0, right: 0, bottom: 0, left: 0 },
          primaryAlign: 'MIN',
          counterAlign: 'MIN',
        },
        fills: [],
        strokes: [],
        strokeWeights: { top: 0, right: 0, bottom: 0, left: 0 },
        dashed: false,
        radii: { topLeft: 0, topRight: 0, bottomRight: 0, bottomLeft: 0 },
        clipsContent: false,
        children: [c.root],
      } satisfies FrameSpec;
    }
    if (existing && existing.getPluginData(PLUGIN_DATA_KEY) !== rootSpec.cdId)
      existing.setPluginData(PLUGIN_DATA_KEY, rootSpec.cdId);
    const node = (await app.tree(rootSpec, existing ?? null, container, index, () =>
      figma.createComponent(),
    )) as ComponentNode;
    node.name = c.name;
    node.setPluginData(PLUGIN_COMPONENT_KEY, c.key);
    app.components.set(c.key, node);
    app.recordPaths(c.key, node);
  }
}

/** Apply a plan to the current page. */
export async function applyPushPlan(
  plan: PushPlan,
  progress: (m: string) => void,
): Promise<PushOutcome> {
  const { items, note } = collector();
  const page = figma.currentPage;

  let vars = new Map<string, Variable>();
  if (plan.variables && plan.variables.variables.length) {
    progress(`Updating ${plan.variables.variables.length} variables…`);
    // Design pushes never overwrite existing variables: differing values go through Tokens sync.
    vars = (await upsertVariables(plan.variables, note, { policy: 'create-missing' })).byPath;
  }

  const all = [...plan.frames.map((f) => f.root), ...plan.components.map((c) => c.root)].flatMap(
    flattenSpecs,
  );
  progress('Loading fonts…');
  const app = new Applier(vars, note);
  await app.loadFonts(all);

  progress('Building components…');
  await pushComponents(app, plan.components);

  for (const f of plan.frames) {
    progress(`Pushing "${f.name}"…`);
    const existing = page.children.find(
      (n) =>
        n.getPluginData(PLUGIN_FRAME_KEY) === f.frameId &&
        n.getPluginData(PLUGIN_PROJECT_KEY) === plan.projectId,
    ) as SceneNode | undefined;
    const index = existing ? page.children.indexOf(existing) : page.children.length;
    const node = await app.tree(f.root, existing ?? null, page, index, () => {
      const fr = figma.createFrame();
      fr.fills = [];
      return fr;
    });
    if (!existing) {
      node.x = f.canvas.x;
      node.y = f.canvas.y;
    }
    node.name = `${f.name} · ${f.width}`;
    node.setPluginData(PLUGIN_FRAME_KEY, f.frameId);
    node.setPluginData(PLUGIN_PROJECT_KEY, plan.projectId);
  }

  return {
    nodeMap: app.nodeMap,
    report: [...plan.report, ...items],
    created: app.created,
    updated: app.updated,
    unchanged: app.unchanged,
    removed: app.removed,
    pageId: page.id,
  };
}
