/**
 * Figma -> DesignDoc import (Story 8.3). One-shot and lossy, with a fidelity report.
 *
 * Auto-layout becomes flow (flex), non-auto-layout children become absolute, paints/strokes/
 * effects/typography become validated StyleProps, bound variables that match design-system tokens
 * become token refs, vectors become (validated) SVG nodes, and image fills become image nodes with
 * safe URLs. Output is a list of insertFrame ops, so it goes through the same validation as any edit.
 */
import {
  newId,
  safeImageSrc,
  STYLE_PROPS,
  svgMarkup,
  validateStyleValue,
  type DesignSystemSpec,
  type DocOp,
  type Frame,
  type Node,
  type StylePropName,
  type StyleProps,
} from '@crunch/doc-model';
import { rgbaToCss, parseCssColor, sameColor } from './color';
import type { FigmaNode, FigmaPaint } from './figma-node';
import { isVectorish } from './figma-node';
import type { ReportItem } from './plan';
import { Reporter } from './report';
import { toPx } from './units';
import { variableNameToTokenPath } from './variables';

export interface FigmaImportOptions {
  /** Figma node id -> SVG markup (from REST /images?format=svg or plugin exportAsync). */
  svgs?: Record<string, string>;
  /** Image fill ref -> https URL or base64 raster data URL. */
  images?: Record<string, string>;
  /** Figma variable id -> variable name (e.g. "color/primary"). */
  variables?: Record<string, string>;
  /** Design system used to match variables and literal values to tokens. */
  designSystem?: DesignSystemSpec;
  /** Map literal colors/spacing to tokens with the exact same value (default true). */
  matchValues?: boolean;
  /** Where the first imported frame goes on the canvas. */
  origin?: { x: number; y: number };
  /** Id generator (deterministic ids in tests). */
  newId?: (prefix: 'n' | 'f') => string;
}

export interface FigmaImportResult {
  frames: { frame: Frame; nodes: Node[] }[];
  report: ReportItem[];
  stats: { nodes: number; tokens: number; svgs: number; images: number };
}

type Bound = { type: 'VARIABLE_ALIAS'; id: string };

const IMAGE_LEAF_TYPES = new Set(['RECTANGLE', 'FRAME', 'ELLIPSE']);
const FRAME_GAP = 80;

class Importer {
  readonly report = new Reporter();
  readonly stats = { nodes: 0, tokens: 0, svgs: 0, images: 0 };
  private readonly id: (p: 'n' | 'f') => string;
  /** Literal -> token path per token type, for value matching. */
  private readonly colorTokens: { path: string; rgba: ReturnType<typeof parseCssColor> }[] = [];
  private readonly pxTokens = new Map<string, Map<number, string>>();

  constructor(private readonly opts: FigmaImportOptions) {
    this.id = opts.newId ?? ((p) => newId(p));
    const ds = opts.designSystem;
    if (ds && opts.matchValues !== false) {
      for (const [path, def] of Object.entries(ds.tokens)) {
        if (typeof def.value === 'object') continue;
        if (def.type === 'color' && typeof def.value === 'string') {
          const rgba = parseCssColor(def.value);
          if (rgba) this.colorTokens.push({ path, rgba });
        } else if (['dimension', 'radius', 'fontSize'].includes(def.type)) {
          const px = toPx(def.value);
          if (px === null) continue;
          if (!this.pxTokens.has(def.type)) this.pxTokens.set(def.type, new Map());
          const m = this.pxTokens.get(def.type)!;
          if (!m.has(px)) m.set(px, path);
        }
      }
    }
  }

  // ------------------------------------------------------------ tokens

  /** Token ref for a bound variable, if it names a design-system token usable for `prop`. */
  private tokenFor(
    prop: StylePropName,
    alias: Bound | Bound[] | undefined,
  ): { token: string } | null {
    const a = Array.isArray(alias) ? alias[0] : alias;
    if (!a) return null;
    const name = this.opts.variables?.[a.id];
    const path = name ? variableNameToTokenPath(name) : null;
    const def = path ? this.opts.designSystem?.tokens[path] : undefined;
    const kinds: readonly string[] =
      (STYLE_PROPS[prop] as { tokens?: readonly string[] }).tokens ?? [];
    if (path && def && kinds.includes(def.type)) {
      this.stats.tokens++;
      return { token: path };
    }
    if (name)
      this.report.info('Variable has no matching design-system token; used its value', {
        subject: name,
      });
    return null;
  }

  private matchColor(css: string): { token: string } | string {
    const rgba = parseCssColor(css);
    if (!rgba) return css;
    const hit = this.colorTokens.find((t) => t.rgba && sameColor(t.rgba, rgba));
    if (hit) {
      this.stats.tokens++;
      return { token: hit.path };
    }
    return css;
  }

  private matchPx(prop: StylePropName, px: number): { token: string } | number {
    const kinds: readonly string[] =
      (STYLE_PROPS[prop] as { tokens?: readonly string[] }).tokens ?? [];
    for (const k of kinds) {
      const hit = this.pxTokens.get(k)?.get(px);
      if (hit) {
        this.stats.tokens++;
        return { token: hit };
      }
    }
    return px;
  }

  // ------------------------------------------------------------ style helpers

  private set(style: StyleProps, prop: StylePropName, value: unknown, n: FigmaNode) {
    if (value === undefined || value === null) return;
    const r = validateStyleValue(prop, value);
    if (!r.success) {
      this.report.warn(`Value for ${prop} isn't valid in CrunchDesign; dropped`, {
        nodeId: n.id,
        nodeName: n.name,
        subject: prop,
      });
      return;
    }
    (style as Record<string, unknown>)[prop] = r.data;
  }

  /** px with token binding (bound variable first, then exact value match). */
  private setPx(
    style: StyleProps,
    prop: StylePropName,
    px: number | undefined,
    n: FigmaNode,
    boundKey?: string,
    match = true,
  ) {
    if (px === undefined || !Number.isFinite(px)) return;
    const bound = boundKey ? this.tokenFor(prop, n.boundVariables?.[boundKey]) : null;
    const v =
      bound ??
      (match && this.opts.matchValues !== false ? this.matchPx(prop, round(px)) : round(px));
    this.set(style, prop, v, n);
  }

  private paintColor(p: FigmaPaint): string | null {
    if (!p.color) return null;
    return rgbaToCss(
      { r: p.color.r, g: p.color.g, b: p.color.b, a: p.color.a ?? 1 },
      p.opacity ?? 1,
    );
  }

  private setColor(style: StyleProps, prop: StylePropName, p: FigmaPaint, n: FigmaNode) {
    const bound = this.tokenFor(prop, p.boundVariables?.color);
    if (bound) return this.set(style, prop, bound, n);
    const css = this.paintColor(p);
    if (!css) return;
    this.set(style, prop, this.opts.matchValues !== false ? this.matchColor(css) : css, n);
  }

  private gradient(p: FigmaPaint, n: FigmaNode): string | null {
    const stops = p.gradientStops ?? [];
    if (stops.length < 2) return null;
    const list = stops
      .map(
        (s) =>
          `${rgbaToCss({ ...s.color, a: s.color.a ?? 1 }, p.opacity ?? 1)} ${round(s.position * 100)}%`,
      )
      .join(', ');
    if (p.type === 'GRADIENT_RADIAL') return `radial-gradient(circle, ${list})`;
    if (p.type !== 'GRADIENT_LINEAR') {
      this.report.warn(`${p.type.toLowerCase().replace('_', ' ')} isn't supported; dropped`, {
        nodeId: n.id,
        nodeName: n.name,
        subject: 'fills',
      });
      return null;
    }
    const [a, b] = p.gradientHandlePositions ?? [];
    let deg = 180;
    if (a && b) {
      // CSS angles: 0deg points up, clockwise. Figma handles are in normalized node space (y down).
      deg = round((Math.atan2(b.x - a.x, -(b.y - a.y)) * 180) / Math.PI);
      if (deg < 0) deg += 360;
    }
    return `linear-gradient(${deg}deg, ${list})`;
  }

  private visibleFills(n: FigmaNode): FigmaPaint[] {
    return (n.fills ?? []).filter((f) => f.visible !== false && (f.opacity ?? 1) > 0);
  }

  private boxStyle(n: FigmaNode, style: StyleProps, isText: boolean) {
    const at = { nodeId: n.id, nodeName: n.name };
    // fills (Figma lists bottom -> top)
    const fills = this.visibleFills(n).filter((f) => f.type !== 'IMAGE');
    if (!isText && fills.length) {
      const solids = fills.filter((f) => f.type === 'SOLID');
      const grads = fills.filter((f) => f.type.startsWith('GRADIENT'));
      const topSolid = solids[solids.length - 1];
      if (topSolid) this.setColor(style, 'backgroundColor', topSolid, n);
      if (solids.length > 1)
        this.report.warn('Only the top solid fill was kept', { ...at, subject: 'fills' });
      const topGrad = grads[grads.length - 1];
      if (topGrad) {
        const g = this.gradient(topGrad, n);
        if (g) this.set(style, 'backgroundImage', g, n);
        if (grads.length > 1)
          this.report.warn('Only the top gradient fill was kept', { ...at, subject: 'fills' });
      }
      for (const f of fills) {
        if (f.type !== 'SOLID' && !f.type.startsWith('GRADIENT'))
          this.report.warn(`${f.type} fills aren't supported; dropped`, {
            ...at,
            subject: 'fills',
          });
      }
    }
    // strokes
    const strokes = (n.strokes ?? []).filter((s) => s.visible !== false && s.type === 'SOLID');
    const stroke = strokes[strokes.length - 1];
    if (stroke) {
      if (isText)
        this.report.warn('Text strokes are not supported; dropped', { ...at, subject: 'strokes' });
      else {
        this.setColor(style, 'borderColor', stroke, n);
        this.set(style, 'borderStyle', n.strokeDashes?.length ? 'dashed' : 'solid', n);
        const w = n.individualStrokeWeights;
        if (w && !(w.top === w.right && w.top === w.bottom && w.top === w.left)) {
          this.set(style, 'borderTopWidth', round(w.top), n);
          this.set(style, 'borderRightWidth', round(w.right), n);
          this.set(style, 'borderBottomWidth', round(w.bottom), n);
          this.set(style, 'borderLeftWidth', round(w.left), n);
        } else
          this.setPx(style, 'borderWidth', w?.top ?? n.strokeWeight ?? 1, n, 'strokeWeight', false);
        if (n.strokeAlign && n.strokeAlign !== 'INSIDE')
          this.report.info(
            `${n.strokeAlign.toLowerCase()} strokes are imported as inside borders`,
            { ...at, subject: 'strokeAlign' },
          );
      }
    }
    // radius
    if (!isText) {
      const rr = n.rectangleCornerRadii;
      if (rr && !(rr[0] === rr[1] && rr[0] === rr[2] && rr[0] === rr[3])) {
        this.setPx(style, 'borderTopLeftRadius', rr[0], n, 'topLeftRadius');
        this.setPx(style, 'borderTopRightRadius', rr[1], n, 'topRightRadius');
        this.setPx(style, 'borderBottomRightRadius', rr[2], n, 'bottomRightRadius');
        this.setPx(style, 'borderBottomLeftRadius', rr[3], n, 'bottomLeftRadius');
      } else {
        const r = rr?.[0] ?? n.cornerRadius;
        if (r) this.setPx(style, 'borderRadius', r, n, 'topLeftRadius');
      }
      if (n.type === 'ELLIPSE') this.set(style, 'borderRadius', '9999px', n);
      if (n.clipsContent) this.set(style, 'overflow', 'hidden', n);
    }
    // effects
    const shadows: string[] = [];
    for (const e of (n.effects ?? []).filter((x) => x.visible !== false)) {
      if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
        const c = e.color ? rgbaToCss({ ...e.color, a: e.color.a ?? 1 }) : '#00000040';
        const o = e.offset ?? { x: 0, y: 0 };
        shadows.push(
          `${e.type === 'INNER_SHADOW' ? 'inset ' : ''}${round(o.x)}px ${round(o.y)}px ${round(e.radius ?? 0)}px ${round(e.spread ?? 0)}px ${c}`,
        );
      } else if (e.type === 'LAYER_BLUR') this.set(style, 'blur', round(e.radius ?? 0), n);
      else
        this.report.warn(`${e.type.toLowerCase().replace(/_/g, ' ')} isn't supported; dropped`, {
          ...at,
          subject: 'effects',
        });
    }
    if (shadows.length) {
      if (isText)
        this.report.warn('Text shadows are not supported; dropped', { ...at, subject: 'effects' });
      else this.set(style, 'boxShadow', shadows.join(', '), n);
    }
    if (n.opacity !== undefined && n.opacity < 1)
      this.set(style, 'opacity', round(n.opacity, 3), n);
    // REST `rotation` is in radians, counter-clockwise; CSS rotate is degrees, clockwise.
    if (n.rotation) this.set(style, 'rotate', round((-n.rotation * 180) / Math.PI), n);
  }

  private layout(n: FigmaNode, style: StyleProps) {
    const mode = n.layoutMode ?? 'NONE';
    if (mode === 'HORIZONTAL' || mode === 'VERTICAL' || mode === 'GRID') {
      if (mode === 'GRID')
        this.report.warn('Grid auto-layout imported as a wrapping row', {
          nodeId: n.id,
          nodeName: n.name,
          subject: 'layoutMode',
        });
      this.set(style, 'display', 'flex', n);
      this.set(style, 'flexDirection', mode === 'VERTICAL' ? 'column' : 'row', n);
      const wrap = n.layoutWrap === 'WRAP' || mode === 'GRID';
      if (wrap) {
        this.set(style, 'flexWrap', 'wrap', n);
        this.setPx(style, 'columnGap', n.itemSpacing, n, 'itemSpacing');
        this.setPx(style, 'rowGap', n.counterAxisSpacing ?? n.itemSpacing, n, 'counterAxisSpacing');
      } else if (n.itemSpacing && n.primaryAxisAlignItems !== 'SPACE_BETWEEN') {
        this.setPx(style, 'gap', n.itemSpacing, n, 'itemSpacing');
      }
      const jc: Record<string, string> = {
        MIN: 'flex-start',
        CENTER: 'center',
        MAX: 'flex-end',
        SPACE_BETWEEN: 'space-between',
        SPACE_EVENLY: 'space-evenly',
        SPACE_AROUND: 'space-around',
      };
      const ai: Record<string, string> = {
        MIN: 'flex-start',
        CENTER: 'center',
        MAX: 'flex-end',
        BASELINE: 'baseline',
      };
      this.set(style, 'justifyContent', jc[n.primaryAxisAlignItems ?? 'MIN'], n);
      this.set(style, 'alignItems', ai[n.counterAxisAlignItems ?? 'MIN'], n);
      this.setPx(style, 'paddingTop', n.paddingTop || undefined, n, 'paddingTop');
      this.setPx(style, 'paddingRight', n.paddingRight || undefined, n, 'paddingRight');
      this.setPx(style, 'paddingBottom', n.paddingBottom || undefined, n, 'paddingBottom');
      this.setPx(style, 'paddingLeft', n.paddingLeft || undefined, n, 'paddingLeft');
      return true;
    }
    return false;
  }

  private typography(n: FigmaNode, style: StyleProps) {
    const s = n.style ?? {};
    const at = { nodeId: n.id, nodeName: n.name };
    if (s.fontFamily) {
      const bound = this.tokenFor('fontFamily', n.boundVariables?.fontFamily);
      this.set(style, 'fontFamily', bound ?? s.fontFamily, n);
    }
    if (s.fontSize) this.setPx(style, 'fontSize', s.fontSize, n, 'fontSize');
    if (s.fontWeight) {
      const bound = this.tokenFor('fontWeight', n.boundVariables?.fontWeight);
      this.set(
        style,
        'fontWeight',
        bound ?? Math.min(900, Math.max(100, Math.round(s.fontWeight / 100) * 100)),
        n,
      );
    }
    if (s.italic) this.set(style, 'fontStyle', 'italic', n);
    if (s.lineHeightUnit === 'FONT_SIZE_%' && s.lineHeightPercentFontSize)
      this.set(style, 'lineHeight', round(s.lineHeightPercentFontSize / 100, 3), n);
    else if (s.lineHeightUnit === 'PIXELS' && s.lineHeightPx)
      this.set(style, 'lineHeight', `${round(s.lineHeightPx)}px`, n);
    if (s.letterSpacing) this.set(style, 'letterSpacing', `${round(s.letterSpacing)}px`, n);
    const ta: Record<string, string> = {
      LEFT: 'left',
      CENTER: 'center',
      RIGHT: 'right',
      JUSTIFIED: 'justify',
    };
    if (s.textAlignHorizontal && s.textAlignHorizontal !== 'LEFT')
      this.set(style, 'textAlign', ta[s.textAlignHorizontal], n);
    const tc: Record<string, string> = {
      UPPER: 'uppercase',
      LOWER: 'lowercase',
      TITLE: 'capitalize',
    };
    if (s.textCase && tc[s.textCase]) this.set(style, 'textTransform', tc[s.textCase], n);
    else if (s.textCase && s.textCase !== 'ORIGINAL')
      this.report.info(`Text case ${s.textCase} isn't supported`, { ...at, subject: 'textCase' });
    const td: Record<string, string> = { UNDERLINE: 'underline', STRIKETHROUGH: 'line-through' };
    if (s.textDecoration && td[s.textDecoration])
      this.set(style, 'textDecoration', td[s.textDecoration], n);
    if (s.textAutoResize === 'WIDTH_AND_HEIGHT') this.set(style, 'whiteSpace', 'nowrap', n);
    const fill = this.visibleFills(n)
      .filter((f) => f.type === 'SOLID')
      .pop();
    if (fill) this.setColor(style, 'color', fill, n);
    if (n.styleOverrideTable && Object.keys(n.styleOverrideTable).length)
      this.report.warn('Mixed text styles were flattened to the base style', {
        ...at,
        subject: 'styleOverrideTable',
      });
  }

  /** Width/height for a node given its parent. */
  private sizing(n: FigmaNode, style: StyleProps, parent: FigmaNode | null, isText: boolean) {
    const bb = n.absoluteBoundingBox;
    const parentAuto =
      !!parent && ['HORIZONTAL', 'VERTICAL', 'GRID'].includes(parent.layoutMode ?? 'NONE');
    const absolute = !!parent && (!parentAuto || n.layoutPositioning === 'ABSOLUTE');
    const ownAuto = ['HORIZONTAL', 'VERTICAL', 'GRID'].includes(n.layoutMode ?? 'NONE');
    const axis = (dim: 'width' | 'height'): unknown => {
      const explicit = dim === 'width' ? n.layoutSizingHorizontal : n.layoutSizingVertical;
      let mode = explicit;
      if (!mode) {
        // Older REST payloads: derive from layoutGrow / layoutAlign / axis sizing modes.
        const parentMain = parent?.layoutMode === 'HORIZONTAL' ? 'width' : 'height';
        if (parentAuto && !absolute && parentMain === dim && n.layoutGrow) mode = 'FILL';
        else if (parentAuto && !absolute && parentMain !== dim && n.layoutAlign === 'STRETCH')
          mode = 'FILL';
        else if (ownAuto) {
          const main = n.layoutMode === 'HORIZONTAL' ? 'width' : 'height';
          const sizing = main === dim ? n.primaryAxisSizingMode : n.counterAxisSizingMode;
          mode = sizing === 'FIXED' ? 'FIXED' : 'HUG';
        } else if (isText) {
          const ar = n.style?.textAutoResize;
          mode =
            ar === 'WIDTH_AND_HEIGHT' || (ar === 'HEIGHT' && dim === 'height') ? 'HUG' : 'FIXED';
        } else mode = 'FIXED';
      }
      if (mode === 'FILL' && (!parentAuto || absolute)) mode = 'FIXED';
      if (mode === 'FILL') return 'fill';
      if (mode === 'HUG') return isText ? undefined : 'hug';
      const px = bb ? round(dim === 'width' ? bb.width : bb.height) : undefined;
      return px;
    };
    const w = axis('width');
    const h = axis('height');
    if (typeof w === 'number') this.setPx(style, 'width', w, n, 'width', false);
    else this.set(style, 'width', w, n);
    if (typeof h === 'number') this.setPx(style, 'height', h, n, 'height', false);
    else this.set(style, 'height', h, n);
    for (const k of ['minWidth', 'maxWidth', 'minHeight', 'maxHeight'] as const) {
      const v = n[k];
      if (typeof v === 'number') this.setPx(style, k, v, n, k, false);
    }
    if (absolute && parent?.absoluteBoundingBox && bb) {
      this.set(style, 'left', round(bb.x - parent.absoluteBoundingBox.x), n);
      this.set(style, 'top', round(bb.y - parent.absoluteBoundingBox.y), n);
    }
    return absolute;
  }

  // ------------------------------------------------------------ nodes

  convert(
    n: FigmaNode,
    parent: FigmaNode | null,
    parentId: string | null,
    out: Node[],
  ): Node | null {
    this.stats.nodes++;
    const at = { nodeId: n.id, nodeName: n.name };
    const id = this.id('n');
    const style: StyleProps = {};
    const base = {
      id,
      name: n.name.slice(0, 120) || undefined,
      parentId,
      children: [] as string[],
      positioning: 'flow' as 'flow' | 'absolute',
      ...(n.visible === false ? { hidden: true } : {}),
    };
    const isRoot = parent === null;

    // vectors -> svg
    if (!isRoot && isVectorish(n)) {
      const svg = this.opts.svgs?.[n.id];
      const ok = svg ? svgMarkup.safeParse(svg) : null;
      if (ok?.success) {
        if (this.sizing(n, style, parent, false)) base.positioning = 'absolute';
        this.boxStyleLimited(n, style);
        this.stats.svgs++;
        return this.push(out, {
          ...base,
          type: 'svg',
          props: { svg: ok.data },
          style: { base: style },
        } as Node);
      }
      this.report.warn(
        svg
          ? 'Vector SVG failed validation; replaced by an empty box'
          : 'Vector not exported as SVG; replaced by an empty box',
        { ...at, subject: 'vector' },
      );
      if (this.sizing(n, style, parent, false)) base.positioning = 'absolute';
      return this.push(out, {
        ...base,
        type: 'box',
        tag: 'div',
        props: {},
        style: { base: style },
      } as Node);
    }

    // text
    if (n.type === 'TEXT') {
      this.typography(n, style);
      this.boxStyle(n, style, true);
      if (this.sizing(n, style, parent, true)) base.positioning = 'absolute';
      const size = n.style?.fontSize ?? 16;
      const tag = size >= 32 ? 'h1' : size >= 24 ? 'h2' : size >= 20 ? 'h3' : 'p';
      return this.push(out, {
        ...base,
        type: 'text',
        tag,
        props: { text: (n.characters ?? '').slice(0, 20_000) },
        style: { base: style },
      } as Node);
    }

    // image leaves
    const img = this.visibleFills(n)
      .filter((f) => f.type === 'IMAGE')
      .pop();
    if (!isRoot && img && IMAGE_LEAF_TYPES.has(n.type) && !n.children?.length) {
      const src = img.imageRef ? this.opts.images?.[img.imageRef] : undefined;
      const safe = src ? safeImageSrc.safeParse(src) : null;
      if (this.sizing(n, style, parent, false)) base.positioning = 'absolute';
      this.boxStyleLimited(n, style);
      const fit: Record<string, string> = {
        FILL: 'cover',
        FIT: 'contain',
        CROP: 'cover',
        TILE: 'cover',
        STRETCH: 'fill',
      };
      this.set(style, 'objectFit', fit[img.scaleMode ?? 'FILL'] ?? 'cover', n);
      if (safe?.success) {
        this.stats.images++;
        return this.push(out, {
          ...base,
          type: 'image',
          props: { src: safe.data, alt: n.name.slice(0, 500) },
          style: { base: style },
        } as Node);
      }
      this.report.warn('Image could not be resolved to a safe URL; replaced by a box', {
        ...at,
        subject: 'image',
      });
      return this.push(out, {
        ...base,
        type: 'box',
        tag: 'div',
        props: {},
        style: { base: style },
      } as Node);
    }
    if (img)
      this.report.warn('Background images on containers are not supported; dropped', {
        ...at,
        subject: 'fills',
      });

    // boxes
    const auto = this.layout(n, style);
    if (!auto && n.children?.length) {
      // Children are absolutely positioned inside a fixed-size box.
      this.set(style, 'display', 'block', n);
    }
    this.boxStyle(n, style, false);
    if (isRoot) {
      this.set(style, 'width', 'fill', n);
      const hug =
        auto &&
        (n.layoutSizingVertical === 'HUG' ||
          (!n.layoutSizingVertical &&
            (n.layoutMode === 'VERTICAL' ? n.primaryAxisSizingMode : n.counterAxisSizingMode) !==
              'FIXED'));
      if (!hug) this.set(style, 'height', 'fill', n);
    } else if (this.sizing(n, style, parent, false)) base.positioning = 'absolute';
    if (n.type === 'INSTANCE' || n.type === 'COMPONENT')
      this.report.info('Components and instances are imported as plain layers', {
        ...at,
        subject: n.type,
      });
    if (n.type === 'ELLIPSE') this.report.info('Ellipse imported as a rounded box', at);

    const node = this.push(out, {
      ...base,
      type: 'box',
      tag: isRoot ? 'main' : 'div',
      props: {},
      style: { base: style },
    } as Node);
    for (const c of n.children ?? []) {
      const child = this.convert(c, n, id, out);
      if (child) node.children.push(child.id);
    }
    return node;
  }

  /** Effects/opacity/radius for leaves (svg, image) without fills/strokes. */
  private boxStyleLimited(n: FigmaNode, style: StyleProps) {
    const copy: FigmaNode = { ...n, fills: [], strokes: [] };
    this.boxStyle(copy, style, false);
    delete style.overflow;
  }

  private push(out: Node[], node: Node): Node {
    out.push(node);
    return node;
  }
}

const round = (n: number, p = 2) => Math.round(n * 10 ** p) / 10 ** p;

/** Convert selected Figma nodes (each becomes a frame) into DesignDoc frames. */
export function figmaToDoc(roots: FigmaNode[], opts: FigmaImportOptions = {}): FigmaImportResult {
  const imp = new Importer(opts);
  const frames: FigmaImportResult['frames'] = [];
  let x = opts.origin?.x ?? 0;
  const y = opts.origin?.y ?? 0;
  for (const r of roots) {
    const bb = r.absoluteBoundingBox;
    const rawW = Math.round(bb?.width ?? 1280);
    const width = Math.min(4096, Math.max(160, rawW));
    if (width !== rawW)
      imp.report.warn(`Frame width ${rawW}px clamped to ${width}px`, {
        nodeId: r.id,
        nodeName: r.name,
      });
    const nodes: Node[] = [];
    const root = imp.convert(r, null, null, nodes);
    if (!root) continue;
    const auto = ['HORIZONTAL', 'VERTICAL'].includes(r.layoutMode ?? 'NONE');
    const hugH =
      auto &&
      (r.layoutSizingVertical === 'HUG' ||
        (!r.layoutSizingVertical &&
          (r.layoutMode === 'VERTICAL' ? r.primaryAxisSizingMode : r.counterAxisSizingMode) !==
            'FIXED'));
    const height = hugH
      ? ('auto' as const)
      : Math.min(32_768, Math.max(80, Math.round(bb?.height ?? 800)));
    frames.push({
      frame: {
        id: opts.newId ? opts.newId('f') : newId('f'),
        name: (r.name || 'Imported frame').slice(0, 120),
        rootNodeId: root.id,
        canvas: { x, y },
        width,
        height,
        previewBreakpoints: [],
      },
      nodes,
    });
    x += width + FRAME_GAP;
  }
  if (imp.stats.tokens)
    imp.report.info(`${imp.stats.tokens} values matched design-system tokens`, {
      subject: 'tokens',
    });
  return { frames, report: imp.report.list(), stats: imp.stats };
}

/** insertFrame ops for an import, appended after the doc's existing frames. */
export function importOps(result: FigmaImportResult, existingFrames: number): DocOp[] {
  return result.frames.map((f, i) => ({
    op: 'insertFrame' as const,
    index: existingFrames + i,
    frame: f.frame,
    nodes: f.nodes,
  }));
}

/** Variable name -> token path, only where the DS has a compatible token (for reports/UI). */
export function matchVariablesToTokens(
  variables: Record<string, string>,
  ds: DesignSystemSpec,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, name] of Object.entries(variables)) {
    const path = variableNameToTokenPath(name);
    if (path && ds.tokens[path]) out[id] = path;
  }
  return out;
}
