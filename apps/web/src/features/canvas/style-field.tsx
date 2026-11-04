'use client';

/**
 * One property field (edit panel, Story 3.3): a compact rounded field with the label inside on the
 * left (drag it to scrub numeric values) and the value right-aligned with its unit. A small accent
 * dot marks a value set on this node at the current breakpoint; inherited values are muted.
 * Accepts a literal (text, or a select for enums) or a design-system token (◇ picker); colors get
 * a swatch that opens the native picker. Text commits on Enter/blur (one op); arrow keys (±1,
 * Shift ±10) and scrubbing apply live with a coalesce key, so one gesture is one undo step.
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

type FieldProps = {
  prop: StylePropName;
  state: PropState;
  mixed: boolean;
  /** Some selected node sets this prop at the breakpoint (reset applies). */
  anySetHere?: boolean;
  /** Every selected node sets it here (so "same value" really is a no-op). */
  allSetHere?: boolean;
  bp: Breakpoint;
  tokens: TokenOption[];
  readOnly: boolean;
  onApply(prop: StylePropName, value: unknown, meta?: ApplyMeta): boolean;
  /** Live preview on the canvas while scrubbing; null clears it. */
  onPreview?(prop: StylePropName, value: unknown): void;
  /** Shorter label than the prop's own (e.g. "W" in a two-column grid). */
  label?: string;
  /**
   * Computed size in px, shown as the placeholder when the value is a keyword (hug/fill/auto) or
   * unset, so Width/Height always show a number. Typing one sets a fixed size.
   */
  computed?: number;
  /** How to read a bare number typed into the field (e.g. letter-spacing in em). */
  numberUnit?: string;
};

/** Props whose bare numbers aren't px (no unit suffix shown). */
const UNITLESS = new Set<StylePropName>([
  'opacity',
  'lineHeight',
  'flexGrow',
  'flexShrink',
  'order',
  'zIndex',
  'scale',
  'aspectRatio',
  'fontWeight',
]);

/** The unit shown after a value, in muted text. */
export function unitFor(prop: StylePropName, value: unknown): string {
  if (typeof value !== 'number') return '';
  if (prop === 'rotate') return '°';
  return UNITLESS.has(prop) ? '' : 'px';
}

const KEYWORD_SIZES = new Set(['hug', 'fill', 'auto']);

/**
 * Inspector rows re-render only when their own prop's state changes (Story 3.10): the inspector
 * recomputes PropState objects on every doc edit, so compare their contents, not identity.
 */
function sameField(a: FieldProps, b: FieldProps): boolean {
  return (
    a.prop === b.prop &&
    a.bp === b.bp &&
    a.mixed === b.mixed &&
    a.anySetHere === b.anySetHere &&
    a.allSetHere === b.allSetHere &&
    a.readOnly === b.readOnly &&
    a.tokens === b.tokens &&
    a.onApply === b.onApply &&
    a.onPreview === b.onPreview &&
    a.label === b.label &&
    a.computed === b.computed &&
    a.numberUnit === b.numberUnit &&
    a.state.from === b.state.from &&
    a.state.setHere === b.state.setHere &&
    a.state.inherited === b.state.inherited &&
    a.state.setAt.join() === b.state.setAt.join() &&
    (a.state.value === b.state.value ||
      JSON.stringify(a.state.value) === JSON.stringify(b.state.value))
  );
}

export const StyleField = memo(function StyleField({
  prop,
  state,
  mixed,
  anySetHere = state.setHere,
  allSetHere = state.setHere,
  bp,
  tokens,
  readOnly,
  onApply,
  onPreview,
  label,
  computed,
  numberUnit,
}: FieldProps) {
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

  const keywordSize =
    computed !== undefined && (state.value == null || KEYWORD_SIZES.has(String(state.value)));
  /** Value nudges and scrubs start from: the computed size for hug/fill, 0 in the field's unit. */
  const numericBase =
    keywordSize && computed !== undefined
      ? Math.round(computed)
      : state.value == null && numberUnit
        ? `0${numberUnit}`
        : state.value;
  const step = numberUnit === 'em' ? 0.01 : 1;

  const commit = (raw: string) => {
    setDraft(null);
    const typed = raw.trim();
    const r = parseStyleInput(
      prop,
      numberUnit && /^-?(?:\d+\.?\d*|\.\d+)$/.test(typed) ? `${typed}${numberUnit}` : typed,
    );
    if (!r.ok) return setError(r.error);
    setError(null);
    // Compare against every selected node, not just the first (multi-selection).
    if (r.value === null && !anySetHere) return; // nothing to unset here
    if (!mixed && allSetHere && JSON.stringify(r.value) === JSON.stringify(state.value)) return;
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
      const next = nudge(
        prop,
        numericBase,
        (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1) * step,
      );
      if (next !== null) {
        setDraft(null);
        onApply(prop, next, { coalesceKey: `nudge:${prop}:${bp}` });
      }
    }
  };

  const onScrub = (e: React.PointerEvent) => {
    if (!numeric || readOnly || e.button !== 0) return;
    const start = numericBase;
    let last: unknown = null;
    startGesture(e, {
      onMove: (ev, dx) => {
        const next = nudge(prop, start, Math.round(dx / 2) * (ev.shiftKey ? 10 : 1) * step);
        if (next === null) return;
        last = next;
        setDraft(formatStyleValue(next));
        onPreview?.(prop, next);
      },
      onEnd: () => {
        onPreview?.(prop, null);
        setDraft(null);
        if (last !== null) onApply(prop, last); // one op per scrub
      },
      onCancel: () => {
        onPreview?.(prop, null);
        setDraft(null);
      },
    });
  };

  const showValue =
    mixed || tokenValue || keywordSize
      ? ''
      : numberUnit && typeof state.value === 'string' && state.value.endsWith(numberUnit)
        ? state.value.slice(0, -numberUnit.length)
        : formatStyleValue(state.value);
  const keywords = propKeywords(prop);
  const text = label ?? def.label;
  const unit =
    draft === null && !mixed && !tokenValue
      ? keywordSize
        ? 'px'
        : numberUnit && showValue !== formatStyleValue(state.value)
          ? numberUnit
          : unitFor(prop, state.value)
      : '';
  const hex = /^#[0-9a-f]{6}$/i.test(swatch)
    ? swatch
    : /^#[0-9a-f]{3}$/i.test(swatch)
      ? `#${[...swatch.slice(1)].map((c) => c + c).join('')}`
      : '#000000';
  const provenance = anySetHere
    ? `Set on this layer at ${bp}`
    : state.inherited
      ? `Inherited from ${state.from}`
      : 'Not set';

  return (
    <div
      data-prop={prop}
      title={`${def.label} (${prop}) · ${provenance}${numeric && !readOnly ? ' · drag the label to scrub' : ''}`}
      className={`group relative flex h-7 min-w-0 items-center gap-1 rounded-md border px-2 text-xs ${
        error ? 'border-danger' : 'border-transparent focus-within:border-accent'
      } bg-surface-2`}
    >
      <label
        htmlFor={id}
        className={`flex shrink-0 items-center gap-1 text-muted ${numeric && !readOnly ? 'cursor-ew-resize' : ''}`}
        onPointerDown={onScrub}
      >
        {anySetHere && (
          <span
            data-set-dot=""
            aria-label={`Set at ${bp}`}
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
          />
        )}
        {text}
      </label>
      <div className="flex min-w-0 flex-1 items-center justify-end gap-1">
        {isColor && (
          <label
            className={`relative shrink-0 ${readOnly || tokenValue ? '' : 'cursor-pointer'}`}
            title={readOnly ? undefined : 'Pick a color'}
            style={{
              width: 14,
              height: 14,
              borderRadius: 3,
              border: '1px solid rgba(0,0,0,.15)',
              background: swatch || 'transparent',
            }}
          >
            {!readOnly && !tokenValue && !mixed && (
              <input
                type="color"
                aria-label={`${text} picker`}
                value={hex}
                className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                onChange={(e) =>
                  onApply(prop, e.target.value, { coalesceKey: `picker:${prop}:${bp}` })
                }
              />
            )}
          </label>
        )}
        {tokenValue && !mixed ? (
          <button
            id={id}
            type="button"
            disabled={readOnly}
            className="min-w-0 truncate rounded bg-accent/10 px-1.5 text-right text-accent"
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
            className={`min-w-0 flex-1 cursor-pointer bg-transparent text-right outline-none ${
              state.inherited || state.value === undefined ? 'text-muted' : ''
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
              placeholder={mixed ? 'Mixed' : keywordSize ? String(Math.round(computed!)) : '—'}
              value={draft ?? showValue}
              onChange={(e) => {
                setDraft(e.target.value);
                setError(null);
              }}
              onBlur={(e) => draft !== null && commit(e.target.value)}
              onKeyDown={onKeyDown}
              className={`w-full min-w-0 flex-1 bg-transparent text-right tabular-nums outline-none placeholder:text-muted ${
                state.inherited && draft === null ? 'text-muted' : ''
              }`}
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
        {unit && <span className="shrink-0 text-muted">{unit}</span>}
        {tokens.length > 0 && !readOnly && (
          <button
            type="button"
            aria-label={`${def.label} token`}
            title="Use a token"
            className={`shrink-0 rounded px-0.5 ${
              tokenValue
                ? 'text-accent'
                : 'text-muted opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus:opacity-100'
            }`}
            onClick={() => setPicking((p) => !p)}
          >
            ◇
          </button>
        )}
        {anySetHere && !readOnly && (
          <button
            type="button"
            aria-label={`Reset ${def.label} at ${bp}`}
            title={`Reset at ${bp}${state.setAt.length > 1 ? ' (inherit)' : ''}`}
            className="shrink-0 rounded px-0.5 text-muted opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 hover:text-text focus:opacity-100"
            onClick={() => onApply(prop, null)}
          >
            ×
          </button>
        )}
      </div>
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
  );
}, sameField);
