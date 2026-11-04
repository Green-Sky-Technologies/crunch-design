/**
 * The push plan: a JSON description of the Figma nodes, components and variables a push should
 * produce. Built server-side from a DesignDoc (to-figma.ts), applied by the plugin main thread.
 *
 * This module has no runtime dependencies so the plugin can bundle it (see ./plugin.ts).
 * Values are already in Figma units: px numbers, 0..1 colors, degrees counter-clockwise.
 */

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Token path bound to a Figma variable (resolved to a variable id by the plugin). */
export type TokenPath = string;

export type PaintSpec =
  | { type: 'SOLID'; color: Rgba; bind?: TokenPath }
  | {
      type: 'GRADIENT_LINEAR' | 'GRADIENT_RADIAL';
      /** 2x3 affine transform in Figma's gradientTransform convention. */
      transform: [[number, number, number], [number, number, number]];
      stops: { position: number; color: Rgba }[];
    }
  | { type: 'IMAGE'; src: string; scaleMode: 'FILL' | 'FIT' | 'CROP' | 'TILE' };

export interface EffectSpec {
  type: 'DROP_SHADOW' | 'INNER_SHADOW' | 'LAYER_BLUR';
  color?: Rgba;
  offset?: { x: number; y: number };
  radius: number;
  spread?: number;
}

export type Sizing = 'FIXED' | 'HUG' | 'FILL';

/** Node fields a variable can be bound to (subset of Figma's VariableBindableNodeField + text fields). */
export type BindableField =
  | 'width'
  | 'height'
  | 'minWidth'
  | 'maxWidth'
  | 'minHeight'
  | 'maxHeight'
  | 'itemSpacing'
  | 'counterAxisSpacing'
  | 'paddingTop'
  | 'paddingRight'
  | 'paddingBottom'
  | 'paddingLeft'
  | 'topLeftRadius'
  | 'topRightRadius'
  | 'bottomLeftRadius'
  | 'bottomRightRadius'
  | 'strokeWeight'
  | 'opacity'
  | 'fontFamily'
  | 'fontSize'
  | 'fontWeight'
  | 'letterSpacing';

interface SpecBase {
  /** CrunchDesign NodeId, stored in plugin data under PLUGIN_DATA_KEY. */
  cdId: string;
  name: string;
  visible: boolean;
  opacity: number;
  /** Hash of this node's own properties (not children): unchanged nodes are skipped on re-push. */
  hash: string;
  /** Absolutely positioned inside its parent (layoutPositioning ABSOLUTE or a non-auto-layout parent). */
  absolute: { x: number; y: number } | null;
  sizing: { horizontal: Sizing; vertical: Sizing };
  /** Pixel size used for FIXED axes (and as the initial size otherwise). */
  width: number;
  height: number;
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
  /** Degrees, counter-clockwise (Figma convention). */
  rotation: number;
  effects: EffectSpec[];
  binds: Partial<Record<BindableField, TokenPath>>;
}

export interface FrameSpec extends SpecBase {
  kind: 'FRAME';
  layout: {
    mode: 'NONE' | 'HORIZONTAL' | 'VERTICAL';
    wrap: boolean;
    itemSpacing: number;
    counterAxisSpacing: number;
    padding: { top: number; right: number; bottom: number; left: number };
    primaryAlign: 'MIN' | 'CENTER' | 'MAX' | 'SPACE_BETWEEN';
    counterAlign: 'MIN' | 'CENTER' | 'MAX' | 'BASELINE';
  };
  fills: PaintSpec[];
  strokes: PaintSpec[];
  strokeWeights: { top: number; right: number; bottom: number; left: number };
  dashed: boolean;
  radii: { topLeft: number; topRight: number; bottomRight: number; bottomLeft: number };
  clipsContent: boolean;
  children: NodeSpec[];
}

export interface TextSpec extends SpecBase {
  kind: 'TEXT';
  characters: string;
  font: { family: string; style: string };
  fontSize: number;
  lineHeight: { unit: 'AUTO' } | { unit: 'PIXELS' | 'PERCENT'; value: number };
  letterSpacing: { unit: 'PIXELS' | 'PERCENT'; value: number };
  textAlign: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED';
  textCase: 'ORIGINAL' | 'UPPER' | 'LOWER' | 'TITLE';
  textDecoration: 'NONE' | 'UNDERLINE' | 'STRIKETHROUGH';
  autoResize: 'WIDTH_AND_HEIGHT' | 'HEIGHT' | 'NONE';
  fills: PaintSpec[];
}

export interface SvgSpec extends SpecBase {
  kind: 'SVG';
  svg: string;
}

export interface ImageSpec extends SpecBase {
  kind: 'IMAGE';
  fills: PaintSpec[];
  radii: FrameSpec['radii'];
}

export interface InstanceSpec extends SpecBase {
  kind: 'INSTANCE';
  /** Key of a ComponentSpec in the plan. */
  componentKey: string;
  /** Text overrides: component-definition node id -> characters. */
  textOverrides: Record<string, string>;
  /** Component-definition node ids to hide in this instance. */
  hidden: string[];
}

export type NodeSpec = FrameSpec | TextSpec | SvgSpec | ImageSpec | InstanceSpec;
export type NodeKind = NodeSpec['kind'];

/** A design-system component (one per variant combination used), pushed as a Figma component. */
export interface ComponentSpec {
  /** `${componentId}` or `${componentId}?axis=value&...` */
  key: string;
  componentId: string;
  variant: Record<string, string>;
  /** Figma name, e.g. "Button / variant=secondary". */
  name: string;
  root: FrameSpec | TextSpec | SvgSpec | ImageSpec;
}

export type VariableType = 'COLOR' | 'FLOAT' | 'STRING';
export type VariableValueSpec = Rgba | number | string | { alias: TokenPath };

export interface VariableSpec {
  /** Token path, stored in the variable's plugin data. */
  path: TokenPath;
  /** Figma variable name, e.g. "color/primary". */
  name: string;
  type: VariableType;
  /** Mode name -> value. Every mode in the collection has a value. */
  valuesByMode: Record<string, VariableValueSpec>;
  description?: string;
}

export interface VariablesSpec {
  collectionName: string;
  /** First mode is the default (base tokens); others are DesignSystemSpec themes. */
  modes: string[];
  variables: VariableSpec[];
}

export type Severity = 'info' | 'warning' | 'error';

export interface ReportItem {
  severity: Severity;
  /** CrunchDesign node id or Figma node id, when the item is about one node. */
  nodeId?: string;
  nodeName?: string;
  /** Style prop, token path, or feature name. */
  subject?: string;
  message: string;
  /** How many nodes this (deduplicated) item applies to. */
  count?: number;
}

export interface FramePlan {
  frameId: string;
  name: string;
  width: number;
  breakpoint: 'base' | 'md' | 'lg';
  canvas: { x: number; y: number };
  root: FrameSpec;
}

export interface PushPlan {
  version: 1;
  projectId: string;
  docVersion: number;
  frames: FramePlan[];
  components: ComponentSpec[];
  variables: VariablesSpec | null;
  report: ReportItem[];
}

/** Plugin-data keys (namespaced by the plugin itself; shared keys are not used). */
export const PLUGIN_DATA_KEY = 'cd:id';
export const PLUGIN_HASH_KEY = 'cd:hash';
export const PLUGIN_KIND_KEY = 'cd:kind';
export const PLUGIN_FRAME_KEY = 'cd:frame';
export const PLUGIN_COMPONENT_KEY = 'cd:component';
export const PLUGIN_TOKEN_KEY = 'cd:token';
export const PLUGIN_PROJECT_KEY = 'cd:project';
