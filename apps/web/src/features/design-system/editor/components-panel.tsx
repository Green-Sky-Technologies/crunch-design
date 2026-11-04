'use client';

import { newId, type ComponentDef, type DesignSystemSpec } from '@crunch/doc-model';
import { FrameView } from '@crunch/renderer/react';
import { useState } from 'react';
import { buildComponentPreviewDoc } from '../preview-doc';
import { IssueList, issuesAt, SectionTitle, type PanelProps, type Update } from './shared';

const COMPONENT_ID = /^[a-zA-Z][\w-]{0,63}$/;
const PROP_NAME = /^[a-zA-Z]\w{0,63}$/;
/** A valid default for new image props (1×1 transparent PNG); image defaults must be safe URLs. */
export const PLACEHOLDER_IMAGE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

/** A new component: a box with one text label bound to a `label` prop. */
export function newComponent(id: string, name: string): ComponentDef {
  const root = newId('n');
  const text = newId('n');
  return {
    id,
    name,
    props: { label: { type: 'text', default: name } },
    variants: {},
    rootNodeId: root,
    nodes: {
      [root]: {
        id: root,
        type: 'box',
        tag: 'div',
        name,
        parentId: null,
        children: [text],
        positioning: 'flow',
        props: {},
        style: {
          base: {
            display: 'inline-flex',
            paddingTop: 8,
            paddingBottom: 8,
            paddingLeft: 12,
            paddingRight: 12,
            borderRadius: 6,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: '#d4d4d8',
          },
        },
      },
      [text]: {
        id: text,
        type: 'text',
        tag: 'span',
        name: 'Label',
        parentId: root,
        children: [],
        positioning: 'flow',
        bind: { text: 'label' },
        props: { text: name },
        style: {},
      },
    },
    variantStyles: [],
  };
}

export function ComponentsPanel({
  spec,
  update,
  issues,
  canEdit,
  theme,
  previewSpec,
}: PanelProps & { theme?: string; previewSpec: DesignSystemSpec }) {
  const ids = Object.keys(spec.components).sort((a, b) =>
    spec.components[a]!.name.localeCompare(spec.components[b]!.name),
  );
  const [selected, setSelected] = useState<string | null>(ids[0] ?? null);
  const [newName, setNewName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const current = selected && spec.components[selected] ? selected : (ids[0] ?? null);

  const add = (e: React.FormEvent) => {
    e.preventDefault();
    const name = newName.trim();
    const id = name.replace(/[^\w-]+/g, '').replace(/^[^a-zA-Z]+/, '');
    if (!name || !COMPONENT_ID.test(id)) return setError('Name must start with a letter');
    if (spec.components[id]) return setError(`${id} already exists`);
    update((d) => void (d.components[id] = newComponent(id, name)));
    setSelected(id);
    setNewName('');
    setError(null);
  };

  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-[12rem_minmax(0,1fr)]">
      <aside className="space-y-2">
        <ul className="card divide-y divide-border">
          {ids.map((id) => (
            <li key={id}>
              <button
                type="button"
                className={`w-full px-3 py-2 text-left text-sm ${id === current ? 'bg-surface-2 font-medium' : 'hover:bg-surface-2'}`}
                onClick={() => setSelected(id)}
              >
                {spec.components[id]!.name}
                {issuesAt(issues, `components.${id}`).length > 0 && (
                  <span className="ml-1 text-danger" title="Has errors">
                    •
                  </span>
                )}
              </button>
            </li>
          ))}
          {ids.length === 0 && <li className="px-3 py-2 text-sm text-muted">No components</li>}
        </ul>
        {canEdit && (
          <form onSubmit={add} className="space-y-2">
            <input
              aria-label="New component name"
              className="input"
              placeholder="Card"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <button type="submit" className="btn-ghost w-full">
              New component
            </button>
            {error && <p className="text-xs text-danger">{error}</p>}
          </form>
        )}
      </aside>
      {current ? (
        <ComponentEditor
          key={current}
          spec={spec}
          id={current}
          update={update}
          issues={issuesAt(issues, `components.${current}`)}
          canEdit={canEdit}
          theme={theme}
          previewSpec={previewSpec}
          onDeleted={() => setSelected(null)}
        />
      ) : (
        <p className="text-sm text-muted">Create a component to get started.</p>
      )}
    </div>
  );
}

function ComponentEditor({
  spec,
  id,
  update,
  issues,
  canEdit,
  theme,
  previewSpec,
  onDeleted,
}: {
  spec: DesignSystemSpec;
  previewSpec: DesignSystemSpec;
  id: string;
  update: Update;
  issues: { path: string; message: string }[];
  canEdit: boolean;
  theme?: string;
  onDeleted: () => void;
}) {
  const c = spec.components[id]!;
  const edit = (fn: (c: ComponentDef) => void) => update((d) => fn(d.components[id]!));
  const [variant, setVariant] = useState<Record<string, string>>({});
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [structure, setStructure] = useState(() =>
    JSON.stringify(
      { rootNodeId: c.rootNodeId, nodes: c.nodes, variantStyles: c.variantStyles },
      null,
      2,
    ),
  );
  const [structureError, setStructureError] = useState<string | null>(null);
  const [newProp, setNewProp] = useState('');
  const [newAxis, setNewAxis] = useState('');

  const effectiveVariant = Object.fromEntries(
    Object.entries(c.variants).map(([axis, v]) => [
      axis,
      variant[axis] && v.options.includes(variant[axis]!) ? variant[axis]! : v.default,
    ]),
  );
  const background = spec.tokens['color.background'] ? { token: 'color.background' } : '#ffffff';
  const doc = buildComponentPreviewDoc(id, effectiveVariant, values, background);

  const applyStructure = () => {
    try {
      const parsed = JSON.parse(structure) as Partial<ComponentDef>;
      if (!parsed || typeof parsed !== 'object' || typeof parsed.rootNodeId !== 'string')
        throw new Error('Expected { rootNodeId, nodes, variantStyles }');
      edit((d) => {
        d.rootNodeId = parsed.rootNodeId!;
        d.nodes = (parsed.nodes ?? {}) as ComponentDef['nodes'];
        d.variantStyles = (parsed.variantStyles ?? []) as ComponentDef['variantStyles'];
      });
      setStructureError(null);
    } catch (e) {
      setStructureError(e instanceof Error ? e.message : 'Invalid JSON');
    }
  };

  return (
    <div className="space-y-6">
      <section className="card overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 border-b border-border bg-surface-2 px-3 py-2">
          {Object.entries(c.variants).map(([axis, v]) => (
            <label key={axis} className="flex items-center gap-1 text-xs">
              {axis}
              <select
                className="input w-auto py-1"
                value={effectiveVariant[axis]}
                onChange={(e) => setVariant({ ...variant, [axis]: e.target.value })}
              >
                {v.options.map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </select>
            </label>
          ))}
          {Object.entries(c.props).map(([name, p]) =>
            p.type === 'boolean' ? (
              <label key={name} className="flex items-center gap-1 text-xs">
                <input
                  type="checkbox"
                  checked={(values[name] as boolean | undefined) ?? p.default}
                  onChange={(e) => setValues({ ...values, [name]: e.target.checked })}
                />
                {name}
              </label>
            ) : (
              <label key={name} className="flex items-center gap-1 text-xs">
                {name}
                <input
                  className="input w-36 py-1"
                  value={(values[name] as string | undefined) ?? p.default}
                  onChange={(e) => setValues({ ...values, [name]: e.target.value })}
                />
              </label>
            ),
          )}
        </div>
        <div className="overflow-x-auto">
          <FrameView doc={doc} ds={previewSpec} frameId={doc.frames[0]!.id} theme={theme} />
        </div>
      </section>

      <fieldset disabled={!canEdit} className="space-y-6">
        <section className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="label">Name</span>
            <input
              className="input"
              value={c.name}
              onChange={(e) => edit((d) => void (d.name = e.target.value))}
            />
          </label>
          <label className="block">
            <span className="label">Id</span>
            <input className="input font-mono" value={c.id} disabled />
          </label>
          <label className="block sm:col-span-2">
            <span className="label">Description</span>
            <input
              className="input"
              value={c.description ?? ''}
              onChange={(e) => edit((d) => void (d.description = e.target.value || undefined))}
            />
          </label>
        </section>

        <section>
          <SectionTitle>Props</SectionTitle>
          <div className="card divide-y divide-border">
            {Object.entries(c.props).map(([name, p]) => (
              <div
                key={name}
                className="grid grid-cols-[8rem_7rem_minmax(0,1fr)_auto] items-center gap-2 px-3 py-2"
              >
                <code className="text-sm">{name}</code>
                <select
                  className="input"
                  aria-label={`${name} type`}
                  value={p.type}
                  onChange={(e) =>
                    edit((d) => {
                      const t = e.target.value as 'text' | 'boolean' | 'image';
                      d.props[name] =
                        t === 'boolean'
                          ? { type: t, default: true }
                          : t === 'image'
                            ? { type: t, default: PLACEHOLDER_IMAGE }
                            : { type: t, default: '' };
                    })
                  }
                >
                  <option value="text">text</option>
                  <option value="boolean">boolean</option>
                  <option value="image">image</option>
                </select>
                {p.type === 'boolean' ? (
                  <input
                    type="checkbox"
                    aria-label={`${name} default`}
                    checked={p.default}
                    onChange={(e) =>
                      edit((d) => void (d.props[name] = { ...p, default: e.target.checked }))
                    }
                  />
                ) : (
                  <input
                    className="input"
                    aria-label={`${name} default`}
                    value={p.default}
                    onChange={(e) =>
                      edit((d) => void (d.props[name] = { ...p, default: e.target.value }))
                    }
                  />
                )}
                <button
                  type="button"
                  className="btn-ghost text-xs"
                  onClick={() => edit((d) => void delete d.props[name])}
                >
                  Remove
                </button>
              </div>
            ))}
            <div className="flex gap-2 px-3 py-2">
              <input
                aria-label="New prop name"
                className="input"
                placeholder="title"
                value={newProp}
                onChange={(e) => setNewProp(e.target.value)}
              />
              <button
                type="button"
                className="btn-ghost"
                disabled={!PROP_NAME.test(newProp) || !!c.props[newProp]}
                onClick={() => {
                  edit((d) => void (d.props[newProp] = { type: 'text', default: '' }));
                  setNewProp('');
                }}
              >
                Add prop
              </button>
            </div>
          </div>
        </section>

        <section>
          <SectionTitle>Variants</SectionTitle>
          <div className="card divide-y divide-border">
            {Object.entries(c.variants).map(([axis, v]) => (
              <div
                key={axis}
                className="grid grid-cols-[8rem_minmax(0,1fr)_8rem_auto] items-center gap-2 px-3 py-2"
              >
                <code className="text-sm">{axis}</code>
                <input
                  className="input"
                  aria-label={`${axis} options`}
                  defaultValue={v.options.join(', ')}
                  onBlur={(e) =>
                    edit((d) => {
                      const options = e.target.value
                        .split(',')
                        .map((o) => o.trim())
                        .filter(Boolean);
                      d.variants[axis] = {
                        options,
                        default: options.includes(v.default) ? v.default : (options[0] ?? ''),
                      };
                    })
                  }
                />
                <select
                  className="input"
                  aria-label={`${axis} default`}
                  value={v.default}
                  onChange={(e) =>
                    edit((d) => void (d.variants[axis] = { ...v, default: e.target.value }))
                  }
                >
                  {v.options.map((o) => (
                    <option key={o}>{o}</option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn-ghost text-xs"
                  onClick={() =>
                    edit((d) => {
                      delete d.variants[axis];
                      d.variantStyles = d.variantStyles.filter((vs) => !(axis in vs.when));
                    })
                  }
                >
                  Remove
                </button>
              </div>
            ))}
            <div className="flex gap-2 px-3 py-2">
              <input
                aria-label="New variant axis"
                className="input"
                placeholder="size"
                value={newAxis}
                onChange={(e) => setNewAxis(e.target.value)}
              />
              <button
                type="button"
                className="btn-ghost"
                disabled={!PROP_NAME.test(newAxis) || !!c.variants[newAxis]}
                onClick={() => {
                  edit(
                    (d) =>
                      void (d.variants[newAxis] = { options: ['default'], default: 'default' }),
                  );
                  setNewAxis('');
                }}
              >
                Add variant axis
              </button>
            </div>
          </div>
        </section>

        <section>
          <SectionTitle
            action={
              <button type="button" className="btn-ghost text-xs" onClick={applyStructure}>
                Apply structure
              </button>
            }
          >
            Structure (nodes and variant styles)
          </SectionTitle>
          <p className="mb-2 text-xs text-muted">
            The component&apos;s DesignDoc subtree. Style values may be literals or{' '}
            <code>{'{"token": "color.primary"}'}</code> references. Use the canvas to build complex
            components visually.
          </p>
          <textarea
            aria-label="Component structure JSON"
            className="input min-h-72 font-mono text-xs"
            spellCheck={false}
            value={structure}
            onChange={(e) => setStructure(e.target.value)}
          />
          {structureError && <p className="mt-1 text-xs text-danger">{structureError}</p>}
        </section>

        <IssueList issues={issues} />

        <button
          type="button"
          className="btn-danger"
          onClick={() => {
            update((d) => void delete d.components[id]);
            onDeleted();
          }}
        >
          Delete component
        </button>
      </fieldset>
    </div>
  );
}
