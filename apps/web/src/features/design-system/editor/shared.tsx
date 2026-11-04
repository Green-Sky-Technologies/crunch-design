'use client';

import type { DesignSystemSpec, TokenType } from '@crunch/doc-model';
import type { SpecIssue } from '@/server/services/design-systems/spec';

export type Update = (fn: (draft: DesignSystemSpec) => void) => void;

export interface PanelProps {
  spec: DesignSystemSpec;
  update: Update;
  issues: SpecIssue[];
  canEdit: boolean;
}

export const TOKEN_TYPE_LABELS: Record<TokenType, string> = {
  color: 'Color',
  fontFamily: 'Font family',
  fontSize: 'Font size',
  fontWeight: 'Font weight',
  lineHeight: 'Line height',
  dimension: 'Spacing / dimension',
  radius: 'Radius',
  shadow: 'Shadow',
  number: 'Number',
};

const NUMERIC: ReadonlySet<TokenType> = new Set(['fontWeight', 'lineHeight', 'number']);

/** Text input → token value. Unitless types accept plain numbers; lengths keep their unit. */
export function parseTokenInput(type: TokenType, text: string): string | number {
  const t = text.trim();
  if (NUMERIC.has(type) && /^-?(?:\d+\.?\d*|\.\d+)$/.test(t)) return Number(t);
  return t;
}

export function formatTokenInput(value: string | number | { ref: string }): string {
  return typeof value === 'object' ? '' : String(value);
}

/** Issues whose path is `prefix` or below it. */
export function issuesAt(issues: SpecIssue[], prefix: string): SpecIssue[] {
  return issues.filter((i) => i.path === prefix || i.path.startsWith(`${prefix}.`));
}

export function IssueList({ issues }: { issues: SpecIssue[] }) {
  if (!issues.length) return null;
  return (
    <ul className="mt-1 space-y-0.5 text-xs text-danger">
      {issues.slice(0, 5).map((i, k) => (
        <li key={k}>{i.message}</li>
      ))}
    </ul>
  );
}

export function SectionTitle({
  children,
  action,
}: {
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">{children}</h2>
      {action}
    </div>
  );
}
