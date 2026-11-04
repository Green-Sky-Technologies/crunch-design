/**
 * Plugin-safe entry: no runtime dependencies (no zod, no doc-model), so the Figma plugin can
 * bundle it. Only types plus dependency-free helpers.
 */
export * from './plan';
export * from './reconcile';
