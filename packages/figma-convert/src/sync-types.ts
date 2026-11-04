/**
 * Shapes shared by the plugin and the server for token sync (Story 8.4). Dependency-free.
 */

export interface SnapshotColor {
  r: number;
  g: number;
  b: number;
  a?: number;
}
export type SnapshotValue =
  boolean | number | string | SnapshotColor | { type: 'VARIABLE_ALIAS'; id: string };

export interface SnapshotVariable {
  id: string;
  name: string;
  resolvedType: 'BOOLEAN' | 'COLOR' | 'FLOAT' | 'STRING' | string;
  /** modeId -> value */
  valuesByMode: Record<string, SnapshotValue>;
  description?: string;
  /** Token path from our plugin data, when this variable was pushed by CrunchDesign. */
  tokenPath?: string;
}

export interface SnapshotCollection {
  id: string;
  name: string;
  defaultModeId: string;
  modes: { modeId: string; name: string }[];
  /** Created/managed by CrunchDesign (plugin data marker). */
  managed?: boolean;
  variables: SnapshotVariable[];
}

/** Local variables of a Figma file, as read by the plugin. */
export interface VariablesSnapshot {
  collections: SnapshotCollection[];
}

export type DiffStatus = 'added' | 'removed' | 'changed' | 'conflict';

export interface TokenDiffEntry {
  /** `${theme ?? 'base'}:${path}` */
  key: string;
  path: string;
  /** null = base value; otherwise the theme (Figma mode) name. */
  theme: string | null;
  type: string;
  status: DiffStatus;
  /** Values in token-literal form (CSS strings, numbers, or { ref }). */
  ours?: unknown;
  theirs?: unknown;
  base?: unknown;
  /** Why it's a conflict, for the UI. */
  reason?: string;
}

export interface TokenDiff {
  direction: 'pull' | 'push';
  entries: TokenDiffEntry[];
  summary: Record<DiffStatus, number>;
  hasBase: boolean;
  collection: { id: string; name: string } | null;
}

export type Resolution = 'ours' | 'theirs';
