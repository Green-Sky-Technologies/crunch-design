'use client';

import type { SystemDiff } from '@/server/services/design-systems/diff';

const KIND_LABEL = { missing: 'Missing', changed: 'Changes', 'type-changed': 'Type changes' };

/** Human-readable summary of what a system switch or upgrade changes in one project. */
export function DiffView({ diff }: { diff: SystemDiff }) {
  if (diff.unchanged)
    return (
      <p className="text-sm text-ok">
        Nothing this project uses changes ({diff.usedTokens} tokens, {diff.usedComponents}{' '}
        components checked).
      </p>
    );
  const missing = diff.tokens.filter((t) => t.kind === 'missing').length;
  const missingComponents = diff.components.filter((c) => c.kind === 'missing').length;
  return (
    <div className="space-y-3 text-sm">
      <p>
        {diff.tokens.length} of {diff.usedTokens} tokens and {diff.components.length} of{' '}
        {diff.usedComponents} components this project uses will change.
        {missing + missingComponents > 0 && (
          <span className="text-danger">
            {' '}
            {missing} token{missing === 1 ? '' : 's'} and {missingComponents} component
            {missingComponents === 1 ? '' : 's'} are missing from the target.
          </span>
        )}
      </p>
      {diff.tokens.length > 0 && (
        <table className="w-full text-xs">
          <thead className="text-left text-muted">
            <tr>
              <th className="py-1 pr-2 font-medium">Token</th>
              <th className="py-1 pr-2 font-medium">Now</th>
              <th className="py-1 pr-2 font-medium">After</th>
              <th className="py-1 font-medium">Nodes</th>
            </tr>
          </thead>
          <tbody>
            {diff.tokens.map((t) => (
              <tr key={t.path} className="border-t border-border">
                <td className="py-1 pr-2 font-mono">{t.path}</td>
                <td className="py-1 pr-2 font-mono">
                  <Swatch value={t.from} />
                  {t.from}
                </td>
                <td className={`py-1 pr-2 font-mono ${t.kind === 'changed' ? '' : 'text-danger'}`}>
                  {t.to !== null && <Swatch value={t.to} />}
                  {t.to ?? KIND_LABEL[t.kind]}
                  {t.kind === 'type-changed' ? ' (type)' : ''}
                </td>
                <td className="py-1">{t.nodeCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {diff.components.length > 0 && (
        <ul className="space-y-1 text-xs">
          {diff.components.map((c) => (
            <li key={c.id}>
              <strong>{c.name}</strong> ({c.instanceCount} instance
              {c.instanceCount === 1 ? '' : 's'}):{' '}
              {c.kind === 'missing' ? (
                <span className="text-danger">missing, instances show a placeholder</span>
              ) : (
                'definition changes'
              )}
              {c.missingVariants.length > 0 && (
                <span className="text-danger">
                  {' '}
                  · unknown variants {c.missingVariants.join(', ')}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {diff.breakpoints && (
        <p className="text-xs">
          Breakpoints change: md {diff.breakpoints.from.md}→{diff.breakpoints.to.md}px, lg{' '}
          {diff.breakpoints.from.lg}→{diff.breakpoints.to.lg}px.
        </p>
      )}
      {diff.themesRemoved.length > 0 && (
        <p className="text-xs text-danger">Themes removed: {diff.themesRemoved.join(', ')}</p>
      )}
      {diff.overridesDropped.length > 0 && (
        <p className="text-xs text-danger">
          Project token overrides that won&apos;t apply: {diff.overridesDropped.join(', ')}
        </p>
      )}
    </div>
  );
}

function Swatch({ value }: { value: string }) {
  if (!/^(#|rgb|hsl|oklch|oklab|lab|lch)/i.test(value)) return null;
  return (
    <span
      className="mr-1 inline-block size-3 rounded-sm border border-border align-middle"
      style={{ background: value }}
    />
  );
}
