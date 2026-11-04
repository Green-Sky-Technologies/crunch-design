'use client';

/**
 * Tweaks tab: the agent's sliders (Story 5.8, the slider tray from the agent feature) and the
 * project's design-token overrides, which re-theme every frame without touching nodes. Overrides
 * are setTokenOverride ops (one undo step each); values are validated by type at render time.
 */
import { resolveToken } from '@crunch/doc-model';
import { useState } from 'react';
import { useDocStore, useDocStoreApi, useEditor } from '../doc-store';
import { SliderTray } from '../agent/slider-tray';

function OverrideRow({ path, value }: { path: string; value: string | number }) {
  const docStore = useDocStoreApi();
  const readOnly = useDocStore((s) => s.readOnly);
  const { designSystem } = useEditor();
  const token = designSystem.spec.tokens[path];
  const set = (v: string | number | null, label: string) =>
    docStore
      .getState()
      .apply([{ op: 'setTokenOverride', path, value: v }], { source: 'inspector', label });
  const isColor = token?.type === 'color';
  const str = String(value);
  return (
    <li className="flex h-7 items-center gap-1.5 rounded-md bg-surface-2 px-2 text-xs">
      <span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={path}>
        {path}
      </span>
      {isColor && /^#[0-9a-f]{6}$/i.test(str) && (
        <input
          type="color"
          aria-label={`${path} color`}
          disabled={readOnly}
          value={str}
          className="h-4 w-4 cursor-pointer border-0 bg-transparent p-0"
          onChange={(e) => set(e.target.value, `Override ${path}`)}
        />
      )}
      <input
        key={str}
        aria-label={`${path} value`}
        disabled={readOnly}
        defaultValue={str}
        className="w-24 min-w-0 bg-transparent text-right outline-none"
        onBlur={(e) => {
          const raw = e.target.value.trim();
          if (!raw || raw === str) return;
          set(
            typeof value === 'number' && !Number.isNaN(Number(raw)) ? Number(raw) : raw,
            `Override ${path}`,
          );
        }}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      />
      {!readOnly && (
        <button
          type="button"
          aria-label={`Remove override ${path}`}
          className="text-muted hover:text-text"
          onClick={() => set(null, `Reset ${path}`)}
        >
          ×
        </button>
      )}
    </li>
  );
}

export function TweaksTab() {
  const overrides = useDocStore((s) => s.doc.tokenOverrides);
  const sliders = useDocStore((s) => s.doc.sliders.length);
  const readOnly = useDocStore((s) => s.readOnly);
  const docStore = useDocStoreApi();
  const { designSystem } = useEditor();
  const [adding, setAdding] = useState('');
  const tokens = Object.entries(designSystem.spec.tokens).filter(([p]) => !(p in overrides));
  /** New overrides start from the token's current (alias-resolved) value. */
  const current = (path: string): string | number | null => {
    try {
      return resolveToken(designSystem.spec.tokens, path);
    } catch {
      return null;
    }
  };
  return (
    <div data-testid="tweaks-tab" className="pb-3">
      <SliderTray />
      {!sliders && (
        <p className="px-3 pt-3 text-xs text-muted">
          No sliders yet. Ask the agent for one, e.g. “give me a density slider”.
        </p>
      )}
      <section className="space-y-1.5 px-3 pt-3" aria-label="Token overrides">
        <h3 className="text-[11px] font-semibold tracking-wide text-muted uppercase">
          Token overrides
        </h3>
        <ul className="space-y-1">
          {Object.entries(overrides).map(([p, v]) => (
            <OverrideRow key={p} path={p} value={v} />
          ))}
        </ul>
        {!Object.keys(overrides).length && (
          <p className="text-xs text-muted">
            Override a design-system token for this project only.
          </p>
        )}
        {!readOnly && (
          <select
            aria-label="Override a token"
            className="input py-1 text-xs"
            value={adding}
            onChange={(e) => {
              const path = e.target.value;
              setAdding('');
              const start = current(path);
              if (start === null) return;
              docStore.getState().apply(
                [
                  {
                    op: 'setTokenOverride',
                    path,
                    value: start,
                  },
                ],
                { source: 'inspector', label: `Override ${path}` },
              );
            }}
          >
            <option value="">+ Override a token…</option>
            {tokens.map(([p]) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        )}
      </section>
    </div>
  );
}
