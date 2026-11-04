/**
 * Messages between the plugin UI iframe (network, rendering) and the main thread (Figma
 * document access). The UI talks to the CrunchDesign API; the main thread never does.
 */
import type { FigmaNode, PushPlan, ReportItem } from '@crunch/figma-convert/plugin';

export interface SelectionPayload {
  nodes: FigmaNode[];
  svgs: Record<string, string>;
  images: Record<string, string>;
  variables: Record<string, string>;
  /** Things that couldn't be exported (shown in the report). */
  skipped: string[];
}

export interface Settings {
  apiBase: string;
  token: string;
}

export interface FileInfo {
  /** Figma file key when available (private plugins), else a stable plugin-generated id. */
  fileKey: string;
  fileName: string;
  pageId: string;
}

export interface PushDone {
  file: FileInfo;
  nodeMap: Record<string, string>;
  report: ReportItem[];
  created: number;
  updated: number;
  unchanged: number;
  removed: number;
}

/** UI -> main thread. */
export type ToMain =
  | { type: 'load-settings' }
  | { type: 'save-settings'; settings: Settings }
  | { type: 'clear-settings' }
  | { type: 'notify'; message: string; error?: boolean }
  | { type: 'resize'; height: number }
  | { type: 'push'; plan: PushPlan }
  | { type: 'read-selection' }
  | { type: 'close' };

/** Main thread -> UI. */
export type ToUi =
  | { type: 'settings'; settings: Settings | null; file: FileInfo }
  | { type: 'progress'; message: string }
  | { type: 'push-done'; result: PushDone }
  | { type: 'selection'; payload: SelectionPayload; file: FileInfo }
  | { type: 'error'; message: string };

export const DEFAULT_API_BASE = 'http://localhost:3000';
