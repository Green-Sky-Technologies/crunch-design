/**
 * StyleProps -> CSS. Shared by the DOM and static renderers, so both emit identical rules.
 *
 * Breakpoints are mobile-first container queries on the frame (`@container cdframe`), so a
 * frame responds to its own width on the canvas, not the browser viewport. For each node we
 * compute the *effective* (cascaded) style at base, md and lg, then emit base in full and only
 * the declarations that change at md and lg. That's what makes `fill` sizing (which depends on
 * the parent's layout) and combined props (translate) correct at every breakpoint.
 */
import {
  BREAKPOINTS,
  isTokenRef,
  STYLE_PROPS,
  tokenCssVar,
  type Breakpoint,
  type ResponsiveStyle,
  type StylePropName,
  type StyleProps,
} from '@crunch/doc-model';

export const FRAME_CONTAINER = 'cdframe';

const UNITLESS = new Set<StylePropName>([
  'opacity',
  'flexGrow',
  'flexShrink',
  'order',
  'zIndex',
  'fontWeight',
  'lineHeight',
  'scale',
  'aspectRatio',
]);

export type Decls = Map<string, string>;

/** Layout facts about a node's parent at one breakpoint (drives `fill` sizing). */
export interface ParentLayout {
  display: string; // 'flex' | 'inline-flex' | 'grid' | 'block' | ...
  direction: 'row' | 'column';
}
export type ParentLayouts = Record<Breakpoint, ParentLayout>;
export const ROOT_LAYOUT: ParentLayouts = {
  base: { display: 'block', direction: 'column' },
  md: { display: 'block', direction: 'column' },
  lg: { display: 'block', direction: 'column' },
};

export function cascade(style: ResponsiveStyle): Record<Breakpoint, StyleProps> {
  const base = { ...(style.base ?? {}) };
  const md = { ...base, ...(style.md ?? {}) };
  const lg = { ...md, ...(style.lg ?? {}) };
  return { base, md, lg };
}

/** Parent layout facts each child needs, per breakpoint. */
export function layoutOf(style: ResponsiveStyle): ParentLayouts {
  const eff = cascade(style);
  const one = (s: StyleProps): ParentLayout => {
    const display = typeof s.display === 'string' ? s.display : 'block';
    const dir = typeof s.flexDirection === 'string' ? s.flexDirection : 'row';
    return { display, direction: dir.startsWith('column') ? 'column' : 'row' };
  };
  return { base: one(eff.base), md: one(eff.md), lg: one(eff.lg) };
}

/** Stable string key for memoizing children on parent layout. */
export const layoutKey = (l: ParentLayouts) =>
  BREAKPOINTS.map((b) => `${l[b].display}/${l[b].direction}`).join('|');

function fmt(prop: StylePropName, value: unknown): string {
  if (isTokenRef(value)) return `var(${tokenCssVar(value.token)})`;
  if (typeof value === 'number') {
    if (prop === 'rotate') return `${value}deg`;
    return UNITLESS.has(prop) ? String(value) : `${value}px`;
  }
  return String(value);
}

const isFlex = (l: ParentLayout) => l.display === 'flex' || l.display === 'inline-flex';

function sizeDecls(axis: 'width' | 'height', value: unknown, parent: ParentLayout, out: Decls) {
  if (value === 'hug') return void out.set(axis, 'fit-content');
  if (value !== 'fill') return void out.set(axis, fmt(axis, value));
  const mainAxis = parent.direction === 'row' ? 'width' : 'height';
  if (isFlex(parent)) {
    if (axis === mainAxis) {
      out.set('flex-grow', '1');
      out.set('flex-basis', '0%');
      out.set(axis === 'width' ? 'min-width' : 'min-height', '0');
    } else {
      out.set('align-self', 'stretch');
    }
  } else {
    out.set(axis, '100%');
  }
}

/** Declarations for one node at one breakpoint, from its effective style. */
export function declarations(
  s: StyleProps,
  parent: ParentLayout,
  opts: { absolute: boolean; isBox: boolean; hidden: boolean },
): Decls {
  const out: Decls = new Map();
  if (opts.absolute) out.set('position', 'absolute');
  else if (opts.isBox) out.set('position', 'relative');

  for (const key of Object.keys(s) as StylePropName[]) {
    const value = s[key];
    if (value === undefined) continue;
    switch (key) {
      case 'width':
      case 'height':
        sizeDecls(key, value, parent, out);
        break;
      case 'translateX':
      case 'translateY':
        break; // combined below
      case 'blur':
        out.set('filter', `blur(${fmt(key, value)})`);
        break;
      case 'top':
      case 'right':
      case 'bottom':
      case 'left':
        if (opts.absolute) out.set(key, fmt(key, value));
        break;
      default:
        out.set(STYLE_PROPS[key].css, fmt(key, value));
    }
  }
  if (s.translateX !== undefined || s.translateY !== undefined) {
    out.set(
      'translate',
      `${fmt('translateX', s.translateX ?? 0)} ${fmt('translateY', s.translateY ?? 0)}`,
    );
  }
  if (opts.hidden) out.set('display', 'none');
  return out;
}

const declText = (d: Decls) => [...d].map(([k, v]) => `${k}:${v};`).join('');

function diff(prev: Decls, next: Decls): Decls {
  const out: Decls = new Map();
  for (const [k, v] of next) if (prev.get(k) !== v) out.set(k, v);
  // Properties that disappear at a larger breakpoint must be reset.
  for (const k of prev.keys()) if (!next.has(k)) out.set(k, RESET[k] ?? 'initial');
  return out;
}

const RESET: Record<string, string> = {
  'flex-grow': '0',
  'flex-basis': 'auto',
  'min-width': 'auto',
  'min-height': 'auto',
  'align-self': 'auto',
  position: 'static',
  width: 'auto',
  height: 'auto',
};

export interface BreakpointWidths {
  md: number;
  lg: number;
}

/**
 * Full CSS rule text for one node: base rule plus container-query rules for md/lg changes.
 * `selector` is the node's class selector.
 */
export function nodeRules(
  selector: string,
  style: ResponsiveStyle,
  parents: ParentLayouts,
  opts: { absolute: boolean; isBox: boolean; hidden: boolean },
  bps: BreakpointWidths,
): string {
  const eff = cascade(style);
  const base = declarations(eff.base, parents.base, opts);
  const md = declarations(eff.md, parents.md, opts);
  const lg = declarations(eff.lg, parents.lg, opts);
  let css = base.size ? `${selector}{${declText(base)}}` : '';
  const mdDiff = diff(base, md);
  if (mdDiff.size)
    css += `@container ${FRAME_CONTAINER} (min-width:${bps.md}px){${selector}{${declText(mdDiff)}}}`;
  const lgDiff = diff(md, lg);
  if (lgDiff.size)
    css += `@container ${FRAME_CONTAINER} (min-width:${bps.lg}px){${selector}{${declText(lgDiff)}}}`;
  return css;
}

/** Element reset and frame container, scoped under `.cd-frame`. Low specificity via :where(). */
export function baseCss(): string {
  return [
    `.cd-frame{container-type:inline-size;container-name:${FRAME_CONTAINER};position:relative;-webkit-font-smoothing:antialiased;}`,
    `.cd-frame,.cd-frame *,.cd-frame *::before,.cd-frame *::after{box-sizing:border-box;}`,
    `.cd-frame :where(h1,h2,h3,h4,h5,h6,p,figure,blockquote,ul,ol,li){margin:0;}`,
    `.cd-frame :where(ul,ol){padding:0;list-style:none;}`,
    `.cd-frame :where(button){font:inherit;color:inherit;background:none;border:0;padding:0;margin:0;text-align:inherit;}`,
    `.cd-frame :where(img,svg){display:block;max-width:100%;}`,
    `.cd-frame :where(a){color:inherit;text-decoration:inherit;}`,
    `.cd-frame :where(img){height:auto;}`,
  ].join('\n');
}
