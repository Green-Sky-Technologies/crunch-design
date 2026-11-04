'use client';

/**
 * Edit-panel building blocks: titled sections with a Reset link, segmented controls, icon toggles,
 * the Figma-style 3×3 alignment grid, and linked/per-side groups (padding, radius, border).
 * Everything writes through the StyleEditor (style-editing.tsx), so every control is one undo step
 * and applies to every selected node at the panel's breakpoint.
 */
import type { StylePropName } from '@crunch/doc-model';
import { useState, type ReactNode } from 'react';
import { MIXED, useStyle } from './style-editing';
import { StyleField } from './style-field';

/** A StyleField bound to the current selection. */
export function Field({
  prop,
  label,
  computed,
  numberUnit,
  wide,
}: {
  prop: StylePropName;
  label?: string;
  computed?: number;
  numberUnit?: string;
  /** Span both columns of a FieldGrid. */
  wide?: boolean;
}) {
  const s = useStyle();
  const field = (
    <StyleField
      prop={prop}
      bp={s.bp}
      state={s.state(prop)}
      mixed={s.mixed(prop)}
      anySetHere={s.isSet(prop)}
      allSetHere={s.allSet(prop)}
      tokens={s.tokens(prop)}
      readOnly={s.readOnly}
      onApply={s.onApply}
      onPreview={s.onPreview}
      label={label}
      computed={computed}
      numberUnit={numberUnit}
    />
  );
  return wide ? <div className="col-span-2">{field}</div> : field;
}

/** Two-column grid; children that should span use `wide`. */
export function FieldGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-1.5">{children}</div>;
}

/** A titled property section; "Reset" appears when any of `props` is set at the breakpoint. */
export function Section({
  title,
  props,
  children,
  testId,
}: {
  title: string;
  props: readonly StylePropName[];
  children: ReactNode;
  testId?: string;
}) {
  const s = useStyle();
  const anySet = props.some((p) => s.isSet(p));
  return (
    <section
      className="space-y-1.5 border-b border-border px-3 py-2.5"
      aria-label={title}
      data-section={testId ?? title.toLowerCase()}
    >
      <div className="flex h-5 items-center justify-between">
        <h3 className="text-[11px] font-semibold tracking-wide text-muted uppercase">{title}</h3>
        {anySet && !s.readOnly && (
          <button
            type="button"
            className="text-[11px] text-accent hover:underline"
            aria-label={`Reset ${title}`}
            onClick={() => s.reset(props, `Reset ${title.toLowerCase()}`)}
          >
            Reset
          </button>
        )}
      </div>
      {children}
    </section>
  );
}

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  title?: string;
}

/** Radio-group segmented control. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
  className = '',
}: {
  label: string;
  value: T | null;
  options: readonly SegmentOption<T>[];
  onChange(v: T): void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={`flex h-7 items-stretch rounded-md bg-surface-2 p-0.5 text-[11px] ${className}`}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          aria-label={typeof o.label === 'string' ? undefined : (o.title ?? o.value)}
          title={o.title}
          disabled={disabled}
          className={`flex flex-1 items-center justify-center rounded px-1.5 ${
            value === o.value
              ? 'bg-surface font-medium text-text shadow-sm'
              : 'text-muted hover:text-text'
          } disabled:opacity-50`}
          onClick={() => value !== o.value && onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A small pressed/unpressed icon button. */
export function Toggle({
  label,
  pressed,
  onChange,
  disabled,
  children,
}: {
  label: string;
  pressed: boolean;
  onChange(next: boolean): void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      className={`flex h-7 min-w-7 items-center justify-center rounded-md px-1.5 text-xs ${
        pressed ? 'bg-accent/15 text-accent' : 'bg-surface-2 text-muted hover:text-text'
      } disabled:opacity-50`}
      onClick={() => onChange(!pressed)}
    >
      {children}
    </button>
  );
}

const ALIGN = ['flex-start', 'center', 'flex-end'] as const;
type Align = (typeof ALIGN)[number];

/**
 * Figma-style 3×3 alignment grid for a flex container: columns are horizontal, rows vertical.
 * For rows, horizontal is justify-content (main axis) and vertical align-items; columns swap them.
 */
export function AlignGrid() {
  const s = useStyle();
  const dir = s.value('flexDirection');
  const column = dir === 'column' || dir === 'column-reverse';
  const justify = s.value('justifyContent');
  const align = s.value('alignItems');
  const norm = (v: unknown): Align | null =>
    v === undefined || v === 'normal' || v === 'stretch'
      ? 'flex-start'
      : ALIGN.includes(v as Align)
        ? (v as Align)
        : null;
  const h = column ? norm(align) : norm(justify);
  const v = column ? norm(justify) : norm(align);
  const set = (hx: Align, vy: Align) =>
    s.applyMany(
      column
        ? [
            ['alignItems', hx],
            ['justifyContent', vy],
          ]
        : [
            ['justifyContent', hx],
            ['alignItems', vy],
          ],
      'Align children',
    );
  const NAMES = ['top', 'middle', 'bottom'];
  const HN = ['left', 'center', 'right'];
  return (
    <div
      role="grid"
      aria-label="Alignment"
      className="grid h-[58px] w-[58px] shrink-0 grid-cols-3 grid-rows-3 gap-0.5 rounded-md bg-surface-2 p-1"
    >
      {ALIGN.map((vy, r) =>
        ALIGN.map((hx, c) => {
          const on = justify !== MIXED && align !== MIXED && h === hx && v === vy;
          return (
            <button
              key={`${r}${c}`}
              type="button"
              role="gridcell"
              aria-label={`Align ${NAMES[r]} ${HN[c]}`}
              aria-selected={on}
              disabled={s.readOnly}
              className="flex items-center justify-center rounded hover:bg-surface"
              onClick={() => set(hx, vy)}
            >
              <span
                className={`block rounded-full ${on ? 'h-2 w-2 bg-accent' : 'h-1 w-1 bg-muted/60'}`}
              />
            </button>
          );
        }),
      )}
    </div>
  );
}

/**
 * One value for all sides, or one field per side. Linked edits write every side's prop. It
 * starts unlinked when the sides differ.
 */
export function LinkedSides({
  label,
  props,
  sideLabels,
  linkedLabel,
}: {
  label: string;
  /** Per-side props, in order (top, right, bottom, left or TL, TR, BR, BL). */
  props: readonly StylePropName[];
  sideLabels: readonly string[];
  /** A single prop that means "all sides" (borderRadius, borderWidth), else every side is set. */
  linkedLabel?: string;
}) {
  const s = useStyle();
  const values = props.map((p) => JSON.stringify(s.value(p) ?? null));
  const same = values.every((v) => v === values[0]) && s.value(props[0]!) !== MIXED;
  const [linked, setLinked] = useState(same);
  const first = props[0]!;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        {linked ? (
          <div className="min-w-0 flex-1">
            <LinkedField props={props} label={linkedLabel ?? label} first={first} />
          </div>
        ) : (
          <span className="flex-1 text-[11px] text-muted">{label}</span>
        )}
        <Toggle
          label={linked ? `Edit ${label.toLowerCase()} per side` : `Link ${label.toLowerCase()}`}
          pressed={!linked}
          onChange={(perSide) => setLinked(!perSide)}
        >
          {linked ? '⊡' : '⊞'}
        </Toggle>
      </div>
      {!linked && (
        <FieldGrid>
          {props.map((p, i) => (
            <Field key={p} prop={p} label={sideLabels[i]} />
          ))}
        </FieldGrid>
      )}
    </div>
  );
}

/** A field that shows the first side's value and writes all sides. */
function LinkedField({
  props,
  label,
  first,
}: {
  props: readonly StylePropName[];
  label: string;
  first: StylePropName;
}) {
  const s = useStyle();
  const anySet = props.some((p) => s.isSet(p));
  const allSet = props.every((p) => s.allSet(p));
  const mixed = props.some((p) => s.mixed(p));
  return (
    <StyleField
      prop={first}
      bp={s.bp}
      state={s.state(first)}
      mixed={mixed}
      anySetHere={anySet}
      allSetHere={allSet}
      tokens={s.tokens(first)}
      readOnly={s.readOnly}
      label={label}
      onApply={(_p: StylePropName, value: unknown, meta?: { coalesceKey?: string }) =>
        s.applyMany(
          props.map((p) => [p, value]),
          `${value === null ? 'Reset' : 'Set'} ${label.toLowerCase()}`,
          meta?.coalesceKey,
        )
      }
      onPreview={(_p: StylePropName, value: unknown) => s.onPreview(first, value)}
    />
  );
}
