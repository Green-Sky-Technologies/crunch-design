'use client';

import { TOKEN_TYPES, tokenPath, type TokenDef, type TokenType } from '@crunch/doc-model';
import { useState } from 'react';
import { compatibleTokenTypes } from '@/server/services/design-systems/spec';
import {
  formatTokenInput,
  IssueList,
  issuesAt,
  parseTokenInput,
  SectionTitle,
  TOKEN_TYPE_LABELS,
  type PanelProps,
} from './shared';

const HEX6 = /^#[0-9a-fA-F]{6}$/;

/** Placeholder hints for new tokens. */
const EXAMPLES: Record<TokenType, string> = {
  color: '#4f46e5',
  fontFamily: 'Inter, sans-serif',
  fontSize: '1rem',
  fontWeight: '600',
  lineHeight: '1.5',
  dimension: '1rem',
  radius: '0.5rem',
  shadow: '0 1px 2px rgba(0,0,0,0.1)',
  number: '0.5',
};

export function TokensPanel({ spec, update, issues, canEdit }: PanelProps) {
  const byType = new Map<TokenType, string[]>();
  for (const p of Object.keys(spec.tokens).sort()) {
    const t = spec.tokens[p]!.type;
    byType.set(t, [...(byType.get(t) ?? []), p]);
  }

  return (
    <div className="space-y-8">
      {canEdit && (
        <AddToken
          existing={spec.tokens}
          onAdd={(p, def) => update((d) => void (d.tokens[p] = def))}
        />
      )}
      {TOKEN_TYPES.filter((t) => byType.has(t)).map((type) => (
        <section key={type}>
          <SectionTitle>{TOKEN_TYPE_LABELS[type]}</SectionTitle>
          <div className="card divide-y divide-border">
            {byType.get(type)!.map((path) => (
              <TokenRow
                key={path}
                path={path}
                def={spec.tokens[path]!}
                aliasTargets={Object.keys(spec.tokens)
                  .filter((p) => p !== path && compatibleTokenTypes(type, spec.tokens[p]!.type))
                  .sort()}
                issues={issuesAt(issues, `tokens.${path}`)}
                canEdit={canEdit}
                onChange={(def) => update((d) => void (d.tokens[path] = def))}
                onDelete={() =>
                  update((d) => {
                    delete d.tokens[path];
                    for (const t of Object.values(d.themes)) delete t[path];
                  })
                }
              />
            ))}
          </div>
        </section>
      ))}
      {byType.size === 0 && <p className="text-sm text-muted">No tokens yet.</p>}
    </div>
  );
}

function TokenRow({
  path,
  def,
  aliasTargets,
  issues,
  canEdit,
  onChange,
  onDelete,
}: {
  path: string;
  def: TokenDef;
  aliasTargets: string[];
  issues: { path: string; message: string }[];
  canEdit: boolean;
  onChange: (def: TokenDef) => void;
  onDelete: () => void;
}) {
  const isAlias = typeof def.value === 'object';
  const literal = formatTokenInput(def.value);
  return (
    <div className="grid grid-cols-1 gap-2 px-3 py-2 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_auto] sm:items-start">
      <div className="pt-1.5">
        <code className="text-sm">{path}</code>
        {def.description && <p className="text-xs text-muted">{def.description}</p>}
      </div>
      <div>
        <div className="flex items-center gap-2">
          <select
            aria-label={`${path} source`}
            className="input w-28 shrink-0"
            value={isAlias ? 'alias' : 'value'}
            onChange={(e) =>
              onChange({
                ...def,
                value:
                  e.target.value === 'alias' && aliasTargets[0]
                    ? { ref: aliasTargets[0] }
                    : parseTokenInput(def.type, EXAMPLES[def.type]),
              })
            }
          >
            <option value="value">Value</option>
            <option value="alias" disabled={!aliasTargets.length}>
              Alias
            </option>
          </select>
          {isAlias ? (
            <select
              aria-label={`${path} alias target`}
              className="input"
              value={(def.value as { ref: string }).ref}
              onChange={(e) => onChange({ ...def, value: { ref: e.target.value } })}
            >
              {aliasTargets.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          ) : (
            <>
              {def.type === 'color' && (
                <input
                  type="color"
                  aria-label={`${path} color picker`}
                  className="h-9 w-10 shrink-0 cursor-pointer rounded border border-border bg-surface p-0.5"
                  value={HEX6.test(literal) ? literal : '#000000'}
                  disabled={!canEdit}
                  onChange={(e) => onChange({ ...def, value: e.target.value })}
                />
              )}
              <input
                aria-label={`${path} value`}
                className="input font-mono"
                value={literal}
                onChange={(e) =>
                  onChange({ ...def, value: parseTokenInput(def.type, e.target.value) })
                }
              />
            </>
          )}
        </div>
        <IssueList issues={issues} />
      </div>
      {canEdit && (
        <button
          type="button"
          className="btn-ghost text-xs"
          onClick={onDelete}
          aria-label={`Delete ${path}`}
        >
          Delete
        </button>
      )}
    </div>
  );
}

function AddToken({
  existing,
  onAdd,
}: {
  existing: Record<string, TokenDef>;
  onAdd: (path: string, def: TokenDef) => void;
}) {
  const [path, setPath] = useState('');
  const [type, setType] = useState<TokenType>('color');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const p = path.trim();
    if (!tokenPath.safeParse(p).success)
      return setError('Use a dotted path like color.brand or space.5');
    if (existing[p]) return setError(`${p} already exists`);
    if (!value.trim()) return setError('Enter a value');
    onAdd(p, { type, value: parseTokenInput(type, value) });
    setPath('');
    setValue('');
    setError(null);
  };

  return (
    <form onSubmit={submit} className="card p-3">
      <p className="mb-2 text-sm font-medium">Add token</p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_10rem_minmax(0,1fr)_auto]">
        <input
          aria-label="New token path"
          className="input font-mono"
          placeholder="color.brand"
          value={path}
          onChange={(e) => setPath(e.target.value)}
        />
        <select
          aria-label="New token type"
          className="input"
          value={type}
          onChange={(e) => setType(e.target.value as TokenType)}
        >
          {TOKEN_TYPES.map((t) => (
            <option key={t} value={t}>
              {TOKEN_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
        <input
          aria-label="New token value"
          className="input font-mono"
          placeholder={EXAMPLES[type]}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button type="submit" className="btn-primary">
          Add
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}
    </form>
  );
}
