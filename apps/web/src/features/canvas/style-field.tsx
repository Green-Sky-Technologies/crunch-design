'use client';

/**
 * One inspector row for a StyleProp: literal input (text, or a select for enums), token picker,
 * breakpoint provenance and reset. Text commits on Enter/blur (one op); arrow keys and scrubbing
 * the label apply live with a coalesce key, so one gesture is one undo step.
 */
import {
  formatStyleValue,
  isEnumProp,
  isNumericProp,
  nudge,
  parseStyleInput,
  propKeywords,
  type PropState,
  type TokenOption,
} from '@crunch/canvas';
import { isTokenRef, STYLE_PROPS, type Breakpoint, type StylePropName } from '@crunch/doc-model';
import { memo, useId, useState } from 'react';
import { startGesture } from './gesture';
import { TokenPicker } from './token-picker';

export interface ApplyMeta {
  coalesceKey?: string;
}

let gestureSeq = 0;

export const StyleField = memo(function StyleField({
  prop,
  state,
  mixed,
  bp,
  tokens,
  readOnly,
  onApply,
}: {
  prop: StylePropName;
  state: PropState;
  mixed: boolean;
  bp: Breakpoint;
  tokens: TokenOption[];
  readOnly: boolean;
  onApply(prop: StylePropName, value: unknown, meta?: ApplyMeta): boolean;
}) {
  const def = STYLE_PROPS[prop];
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const tokenValue = isTokenRef(state.value) ? state.value.token : undefined;
  const numeric = isNumericProp(prop);
  const resolvedToken = tokenValue ? tokens.find((t) => t.path === tokenValue) : undefined;
  const isColor = def.group === 'fill' || prop === 'color' || prop === 'borderColor';
  const swatch = isColor
    ? String(resolvedToken?.resolved ?? (typeof state.value === 'string' ? state.value : ''))
    : '';

  const commit = (raw: string) => {
    setDraft(null);
    const r = parseStyleInput(prop, raw);
    if (!r.ok) return setError(r.error);
    setError(null);
    if (r.value === null && !state.setHere) return; // nothing to unset here
    if (JSON.stringify(r.value) === JSON.stringify(state.value) && state.setHere) return;
    onApply(prop, r.value);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') e.currentTarget.blur();
    else if (e.key === 'Escape') {
      setDraft(null);
      setError(null);
      e.currentTarget.blur();
    } else if (numeric && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      const next = nudge(prop, state.value, (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1));
      if (next !== null) {
        setDraft(null);
        onApply(prop, next, { coalesceKey: `nudge:${prop}:${bp}` });
      }
    }
  };

  const onScrub = (e: React.PointerEvent) => {
    if (!numeric || readOnly || e.button !== 0) return;
    const start = state.value;
    const key = `scrub:${prop}:${++gestureSeq}`;
    startGesture(e, {
      onMove: (ev, dx) => {
        const next = nudge(prop, start, Math.round(dx / 2) * (ev.shiftKey ? 10 : 1));
        if (next !== null) onApply(prop, next, { coalesceKey: key });
      },
    });
  };

  const showValue = mixed ? '' : tokenValue ? '' : formatStyleValue(state.value);
  const keywords = propKeywords(prop);

  return (
    <div
      data-prop={prop}
      className="grid items-center gap-1 px-3 py-0.5 text-xs"
      style={{ gridTemplateColumns: '84px 1fr auto' }}
    >
      <label
        htmlFor={id}
        className={`truncate ${numeric && !readOnly ? 'cursor-ew-resize' : ''} ${
          state.setHere ? 'text-text' : 'text-muted'
        }`}
        title={`${def.label} (${prop})${numeric ? ' — drag to scrub' : ''}`}
        onPointerDown={onScrub}
      >
        {def.label}
      </label>
      <div className="relative flex min-w-0 items-center gap-1">
        {swatch && (
          <span
            aria-hidden
            style={{
              width: 12,
              height: 12,
              flex: 'none',
              borderRadius: 3,
              border: '1px solid rgba(0,0,0,.15)',
              background: swatch,
            }}
          />
        )}
        {tokenValue && !mixed ? (
          <button
            id={id}
            type="button"
            disabled={readOnly}
            className="min-w-0 flex-1 truncate rounded bg-accent/10 px-1.5 py-0.5 text-left text-accent"
            title={`Token ${tokenValue}${resolvedToken ? ` = ${resolvedToken.resolved}` : ''}`}
            onClick={() => setPicking(true)}
          >
            ◇ {tokenValue}
          </button>
        ) : isEnumProp(prop) ? (
          <select
            id={id}
            aria-label={def.label}
            disabled={readOnly}
            value={mixed ? '' : String(state.value ?? '')}
            onChange={(e) => onApply(prop, e.target.value === '' ? null : e.target.value)}
            className={`min-w-0 flex-1 rounded border border-transparent bg-transparent py-0.5 hover:border-border ${
              state.inherited ? 'text-muted' : ''
            }`}
          >
            <option value="">{mixed ? 'Mixed' : '—'}</option>
            {keywords.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        ) : (
          <>
            <input
              id={id}
              aria-label={def.label}
              aria-invalid={!!error}
              title={error ?? undefined}
              disabled={readOnly}
              list={keywords.length ? `${id}-kw` : undefined}
              placeholder={mixed ? 'Mixed' : '—'}
              value={draft ?? showValue}
              onChange={(e) => {
                setDraft(e.target.value);
                setError(null);
              }}
              onBlur={(e) => draft !== null && commit(e.target.value)}
              onKeyDown={onKeyDown}
              className={`min-w-0 flex-1 rounded border bg-transparent px-1 py-0.5 outline-none focus:border-accent ${
                error ? 'border-danger' : 'border-transparent hover:border-border'
              } ${state.inherited && draft === null ? 'text-muted' : ''}`}
            />
            {keywords.length > 0 && (
              <datalist id={`${id}-kw`}>
                {keywords.map((k) => (
                  <option key={k} value={k} />
                ))}
              </datalist>
            )}
          </>
        )}
        {tokens.length > 0 && !readOnly && (
          <button
            type="button"
            aria-label={`${def.label} token`}
            title="Use a token"
            className={`rounded px-1 hover:bg-surface-2 ${tokenValue ? 'text-accent' : 'text-muted'}`}
            onClick={() => setPicking((p) => !p)}
          >
            ◇
          </button>
        )}
        {picking && (
          <TokenPicker
            tokens={tokens}
            current={tokenValue}
            label={def.label}
            onClose={() => setPicking(false)}
            onPick={(path) => {
              setPicking(false);
              onApply(prop, { token: path });
            }}
          />
        )}
      </div>
      <div
        className="flex items-center gap-0.5"
        style={{ minWidth: 44, justifyContent: 'flex-end' }}
      >
        {state.setHere ? (
          <>
            <span
              className="rounded bg-accent/10 px-1 text-[10px] text-accent"
              title={`Set at ${bp}`}
            >
              {bp}
            </span>
            {!readOnly && (
              <button
                type="button"
                aria-label={`Reset ${def.label} at ${bp}`}
                title={`Reset at ${bp}${state.setAt.length > 1 ? ' (inherit)' : ''}`}
                className="rounded px-0.5 text-muted hover:text-text"
                onClick={() => onApply(prop, null)}
              >
                ×
              </button>
            )}
          </>
        ) : state.inherited ? (
          <span className="text-[10px] text-muted" title={`Inherited from ${state.from}`}>
            ↳ {state.from}
          </span>
        ) : null}
      </div>
    </div>
  );
});
