'use client';

/** Token picker popover: design-system tokens filtered to the prop's token kinds. */
import type { TokenOption } from '@crunch/canvas';
import { useEffect, useRef, useState } from 'react';

export function TokenPicker({
  tokens,
  current,
  label,
  onPick,
  onClose,
}: {
  tokens: TokenOption[];
  current?: string;
  label: string;
  onPick(path: string): void;
  onClose(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState('');
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [onClose]);
  const shown = tokens.filter((t) => t.path.toLowerCase().includes(q.toLowerCase()));
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={`${label} tokens`}
      className="card shadow-lg"
      style={{ position: 'absolute', right: 0, top: '100%', zIndex: 20, width: 220, marginTop: 2 }}
    >
      <input
        autoFocus
        className="w-full border-b border-border bg-transparent px-2 py-1 text-xs outline-none"
        placeholder="Search tokens"
        aria-label="Search tokens"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
          if (e.key === 'Enter' && shown[0]) onPick(shown[0].path);
        }}
      />
      <ul role="listbox" aria-label="Tokens" style={{ maxHeight: 240, overflow: 'auto' }}>
        {shown.map((t) => (
          <li key={t.path} role="option" aria-selected={t.path === current}>
            <button
              type="button"
              className={`flex w-full items-center gap-2 px-2 py-1 text-left text-xs hover:bg-surface-2 ${
                t.path === current ? 'text-accent' : ''
              }`}
              onClick={() => onPick(t.path)}
            >
              {t.type === 'color' && (
                <span
                  aria-hidden
                  style={{
                    width: 12,
                    height: 12,
                    borderRadius: 3,
                    border: '1px solid rgba(0,0,0,.15)',
                    background: String(t.resolved ?? 'transparent'),
                  }}
                />
              )}
              <span className="flex-1 truncate">{t.path}</span>
              <span className="truncate text-muted" style={{ maxWidth: 80 }}>
                {t.resolved ?? '?'}
              </span>
            </button>
          </li>
        ))}
        {!shown.length && <li className="px-2 py-1 text-xs text-muted">No matching tokens</li>}
      </ul>
    </div>
  );
}
