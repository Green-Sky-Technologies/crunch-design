'use client';

import { useState } from 'react';
import {
  formatTokenInput,
  IssueList,
  issuesAt,
  parseTokenInput,
  SectionTitle,
  type PanelProps,
} from './shared';

const THEME_NAME = /^[a-z][a-z0-9-]*$/;

/** Theme = partial token overrides (light/dark, Figma variable modes). */
export function ThemesPanel({ spec, update, issues, canEdit }: PanelProps) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const paths = Object.keys(spec.tokens).sort();

  const addTheme = (e: React.FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!THEME_NAME.test(n)) return setError('Lowercase letters, digits and hyphens, e.g. dark');
    if (spec.themes[n]) return setError(`${n} already exists`);
    update((d) => void (d.themes[n] = {}));
    setName('');
    setError(null);
  };

  return (
    <div className="space-y-8">
      <p className="text-sm text-muted">
        A theme overrides some token values. Frames and exports switch themes with{' '}
        <code>data-theme</code>.
      </p>
      {canEdit && (
        <form onSubmit={addTheme} className="card flex flex-wrap items-center gap-2 p-3">
          <input
            aria-label="New theme name"
            className="input w-48"
            placeholder="dark"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button className="btn-primary" type="submit">
            Add theme
          </button>
          {error && <p className="w-full text-xs text-danger">{error}</p>}
        </form>
      )}
      {Object.entries(spec.themes).map(([theme, overrides]) => {
        const unused = paths.filter((p) => !(p in overrides));
        return (
          <section key={theme}>
            <SectionTitle
              action={
                canEdit && (
                  <button
                    type="button"
                    className="btn-ghost text-xs"
                    onClick={() => update((d) => void delete d.themes[theme])}
                  >
                    Delete theme
                  </button>
                )
              }
            >
              {theme}
            </SectionTitle>
            <div className="card divide-y divide-border">
              {Object.entries(overrides).map(([path, value]) => {
                const def = spec.tokens[path];
                return (
                  <div
                    key={path}
                    className="grid grid-cols-1 gap-2 px-3 py-2 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_auto]"
                  >
                    <code className="pt-1.5 text-sm">{path}</code>
                    <div>
                      <input
                        aria-label={`${theme} ${path}`}
                        className="input font-mono"
                        value={
                          typeof value === 'object' ? `→ ${value.ref}` : formatTokenInput(value)
                        }
                        disabled={typeof value === 'object'}
                        onChange={(e) =>
                          update(
                            (d) =>
                              void (d.themes[theme]![path] = def
                                ? parseTokenInput(def.type, e.target.value)
                                : e.target.value),
                          )
                        }
                      />
                      <IssueList issues={issuesAt(issues, `themes.${theme}.${path}`)} />
                    </div>
                    {canEdit && (
                      <button
                        type="button"
                        className="btn-ghost text-xs"
                        onClick={() => update((d) => void delete d.themes[theme]![path])}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                );
              })}
              {canEdit && unused.length > 0 && (
                <div className="px-3 py-2">
                  <select
                    aria-label={`Override a token in ${theme}`}
                    className="input"
                    value=""
                    onChange={(e) => {
                      const p = e.target.value;
                      const def = spec.tokens[p];
                      if (!def) return;
                      update(
                        (d) =>
                          void (d.themes[theme]![p] =
                            typeof def.value === 'object' ? { ref: def.value.ref } : def.value),
                      );
                    }}
                  >
                    <option value="">Override a token…</option>
                    {unused.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
