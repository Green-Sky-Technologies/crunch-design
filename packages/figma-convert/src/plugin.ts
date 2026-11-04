/**
 * Plugin-safe entry: no runtime dependencies (no zod, no doc-model), so the Figma plugin can
 * bundle it. Only types plus dependency-free helpers.
 */
export * from './plan';
export * from './reconcile';
export * from './serialize';
export * from './sync-types';
export * from './modes';
export * from './variable-values';
export type { FigmaNode, FigmaPaint } from './figma-node';
