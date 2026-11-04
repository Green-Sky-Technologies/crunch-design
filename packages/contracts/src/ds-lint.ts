/**
 * Design-system lint contract (Story 4.6).
 * Producer: stream-design-system implements `lintDoc` in @crunch/ds-lint (stub until then).
 * Consumers: the agent's run_lint tool and self-correction loop, plus inspector warnings.
 * Must be deterministic and fast (it runs on every local edit, at zero tokens).
 */
import type { DesignDoc, DesignSystemSpec, DocOp } from '@crunch/doc-model';

export type LintSeverity = 'error' | 'warning' | 'info';

export type LintCode =
  | 'literal-should-be-token'
  | 'off-scale-spacing'
  | 'contrast'
  | 'unknown-token'
  | 'missing-alt'
  | 'missing-component'
  | 'font-not-in-system';

export interface LintIssue {
  code: LintCode;
  severity: LintSeverity;
  message: string;
  nodeId?: string;
  prop?: string;
  breakpoint?: 'base' | 'md' | 'lg';
  /** Optional automatic fix as ops (e.g. replace a literal with the nearest token). */
  fix?: DocOp[];
}

export interface LintOptions {
  /** Only check these nodes (and nothing else). */
  nodeIds?: string[];
  theme?: string;
}

export type LintDoc = (doc: DesignDoc, ds: DesignSystemSpec, opts?: LintOptions) => LintIssue[];
