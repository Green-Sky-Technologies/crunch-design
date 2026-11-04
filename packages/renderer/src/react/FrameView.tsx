'use client';

/**
 * Live DOM renderer for one frame (Story 2.3).
 *
 * - Renders into a Shadow DOM, so design CSS and app CSS never leak into each other.
 * - Every node is a memoized <NodeView> subscribed to its own node in a tiny store. When the doc
 *   changes, only nodes whose object identity changed re-render (immer gives structural sharing).
 * - CSS is per-node rules in a registry, flushed to one <style> per frame in a microtask.
 */
import {
  createContext,
  createElement,
  Fragment,
  memo,
  useContext,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import type { DesignDoc, DesignSystemSpec, Node } from '@crunch/doc-model';
import { breakpointsOf, rnodeCss, sharedCss, type RenderContext } from '../core';
import { layoutKey, layoutOf, ROOT_LAYOUT, type ParentLayouts } from '../css';
import {
  DEFAULT_OPTIONS,
  describe,
  rnodeFor,
  type ElementDesc,
  type RenderOptions,
  type RNode,
} from '../describe';

// ---------------------------------------------------------------------------------------------
// Doc store: lets each NodeView subscribe to its own node.
// ---------------------------------------------------------------------------------------------

class DocStore {
  private listeners = new Set<() => void>();
  constructor(public doc: DesignDoc) {}
  set(doc: DesignDoc) {
    if (doc === this.doc) return;
    this.doc = doc;
    for (const l of this.listeners) l();
  }
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
}

// ---------------------------------------------------------------------------------------------
// Style registry: one rule string per render key, flushed to a <style> element.
// ---------------------------------------------------------------------------------------------

export class StyleRegistry {
  private rules = new Map<string, string>();
  private scheduled = false;
  constructor(private el: HTMLStyleElement | null = null) {}
  attach(el: HTMLStyleElement) {
    this.el = el;
    this.flush();
  }
  set(key: string, css: string) {
    if (this.rules.get(key) === css) return;
    this.rules.set(key, css);
    this.schedule();
  }
  delete(key: string) {
    if (this.rules.delete(key)) this.schedule();
  }
  /** Current stylesheet text (tests, debugging). */
  text() {
    return [...this.rules.values()].join('\n');
  }
  private schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => this.flush());
  }
  flush() {
    this.scheduled = false;
    if (this.el) this.el.textContent = this.text();
  }
}

interface FrameCtx {
  store: DocStore;
  registry: StyleRegistry;
  ctx: RenderContext;
  /** Ref, so changing the callback never invalidates the context (which re-renders every node). */
  onRender: { current?: (key: string) => void };
}
const Ctx = createContext<FrameCtx | null>(null);
const useFrameCtx = () => {
  const c = useContext(Ctx);
  if (!c) throw new Error('NodeView outside FrameView');
  return c;
};

// ---------------------------------------------------------------------------------------------
// Element creation from ElementDesc (shared markup with the static renderer).
// ---------------------------------------------------------------------------------------------

const camel = (s: string) => s.replace(/[-:]([a-z])/g, (_, c: string) => c.toUpperCase());

function reactProps(attrs: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') out.className = v;
    else if (k.startsWith('data-') || k.startsWith('aria-')) out[k] = v;
    else if (k.includes('-') || k.includes(':')) out[camel(k)] = v;
    else out[k] = v;
  }
  return out;
}

function element(desc: ElementDesc, children: ReactNode): ReactNode {
  const props: Record<string, unknown> = reactProps(desc.attrs);
  if (desc.svgHtml !== undefined) {
    props.dangerouslySetInnerHTML = { __html: desc.svgHtml };
    return createElement(desc.tag, props);
  }
  if (desc.void) return createElement(desc.tag, props);
  return createElement(desc.tag, props, desc.text ?? children);
}

// ---------------------------------------------------------------------------------------------
// Node views
// ---------------------------------------------------------------------------------------------

function useRule(key: string, css: string) {
  const { registry } = useFrameCtx();
  useInsertionEffect(() => {
    registry.set(key, css);
    return () => registry.delete(key);
  }, [registry, key, css]);
}

/** Concrete RNode subtree (component instance parts). Not memoized: re-renders with its instance. */
function PartView({ r, parents }: { r: RNode; parents: ParentLayouts }): ReactNode {
  const { ctx } = useFrameCtx();
  useRule(r.key, rnodeCss(r, parents, ctx));
  const childParents = layoutOf(r.style);
  return element(
    describe(r, ctx.options),
    r.children?.map((c) => <PartView key={c.key} r={c} parents={childParents} />),
  );
}

interface NodeViewProps {
  id: string;
  parents: ParentLayouts;
  /** Memo key for `parents` (layoutKey). */
  parentKey: string;
}

export const NodeView = memo(
  function NodeView({ id, parents }: NodeViewProps): ReactNode {
    const { store, ctx, onRender } = useFrameCtx();
    const node: Node | undefined = useSyncExternalStore(
      store.subscribe,
      () => store.doc.nodes[id],
      () => store.doc.nodes[id],
    );
    onRender.current?.(id);
    const r = useMemo(() => (node ? rnodeFor(node, ctx.ds) : null), [node, ctx.ds]);
    const css = useMemo(() => (r ? rnodeCss(r, parents, ctx) : ''), [r, parents, ctx]);
    useRule(id, css);
    if (!node || !r) return null;

    if (r.children) {
      // Expanded instance: render parts.
      const childParents = layoutOf(r.style);
      return element(
        describe(r, ctx.options),
        r.children.map((c) => <PartView key={c.key} r={c} parents={childParents} />),
      );
    }
    const childParents = layoutOf(node.style);
    const childKey = layoutKey(childParents);
    return element(
      describe(r, ctx.options),
      node.children.length
        ? node.children.map((cid) => (
            <NodeView key={cid} id={cid} parents={childParents} parentKey={childKey} />
          ))
        : null,
    );
  },
  (a, b) => a.id === b.id && a.parentKey === b.parentKey,
);

// ---------------------------------------------------------------------------------------------
// Frame
// ---------------------------------------------------------------------------------------------

export interface FrameViewProps {
  doc: DesignDoc;
  ds: DesignSystemSpec;
  frameId: string;
  options?: Partial<RenderOptions>;
  theme?: string;
  /** Render into a Shadow DOM (default). Tests can set false to inspect the light DOM. */
  shadow?: boolean;
  className?: string;
  /** Debug hook: called whenever a NodeView renders (incremental-render tests, perf HUD). */
  onNodeRender?: (id: string) => void;
}

export function FrameView({
  doc,
  ds,
  frameId,
  options,
  theme,
  shadow = true,
  className,
  onNodeRender,
}: FrameViewProps) {
  const store = useRef<DocStore>(null);
  store.current ??= new DocStore(doc);
  const registry = useRef<StyleRegistry>(null);
  registry.current ??= new StyleRegistry();

  // Push new docs to subscribers after render, so each NodeView re-reads only its own node.
  useLayoutEffect(() => store.current!.set(doc), [doc]);

  const opts = useMemo(() => ({ ...DEFAULT_OPTIONS, ...options }), [options]);
  // Context object changes only when the design system or options change (rare, full re-render).
  // `doc` is a getter, so it always reads the latest doc without invalidating memos.
  const renderCtx = useMemo<RenderContext>(() => {
    const s = store.current!;
    return {
      get doc() {
        return s.doc;
      },
      ds,
      options: opts,
    };
  }, [ds, opts]);
  const onRender = useRef<((key: string) => void) | undefined>(undefined);
  onRender.current = onNodeRender;
  const value = useMemo<FrameCtx>(
    () => ({ store: store.current!, registry: registry.current!, ctx: renderCtx, onRender }),
    [renderCtx],
  );

  const frame = doc.frames.find((f) => f.id === frameId);
  // Token/override CSS only depends on the design system and doc-level overrides.
  const shared = useMemo(
    () => sharedCss({ doc, ds, options: opts }).css,
    [ds, doc.tokenOverrides, opts],
  );
  const frameCss = frame
    ? `.cd-frame[data-frame="${frame.id}"]{width:${frame.width}px;${frame.height === 'auto' ? '' : `min-height:${frame.height}px;`}}`
    : '';

  const hostRef = useRef<HTMLDivElement>(null);
  const [root, setRoot] = useState<ShadowRoot | null>(null);
  useLayoutEffect(() => {
    if (!shadow) return;
    const host = hostRef.current!;
    setRoot(host.shadowRoot ?? host.attachShadow({ mode: 'open' }));
  }, [shadow]);

  if (!frame) return null;
  const content = (
    <Ctx.Provider value={value}>
      <style>{shared}</style>
      <style>{frameCss}</style>
      <style ref={(el) => void (el && registry.current!.attach(el))} />
      <div className="cd-frame" data-frame={frame.id} data-theme={theme}>
        <NodeView id={frame.rootNodeId} parents={ROOT_LAYOUT} parentKey={layoutKey(ROOT_LAYOUT)} />
      </div>
    </Ctx.Provider>
  );
  return (
    <div ref={hostRef} className={className} data-cd-frame-host={frame.id}>
      {shadow ? root ? createPortal(content, root) : <Fragment /> : content}
    </div>
  );
}

export { breakpointsOf };
