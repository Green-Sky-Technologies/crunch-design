'use client';

/** Admin form: default model per task tier and the workspace's allowed models (Story 5.9). */
import { useState } from 'react';
import type { AgentSettingsView } from '@/server/services/agent/model-settings';

const TIERS = [
  { key: 'interactive', label: 'Chat and quick edits', hint: 'Sonnet-class' },
  { key: 'generation', label: 'Generation, redesign and code export', hint: 'Opus-class' },
  { key: 'utility', label: 'Utilities (titles, summaries)', hint: 'Haiku-class' },
] as const;

export function ModelSettingsForm({ initial }: { initial: AgentSettingsView }) {
  const [settings, setSettings] = useState(initial);
  const [allowed, setAllowed] = useState<Set<string>>(
    () => new Set(initial.allowedModels ?? initial.models.map((m) => m.id)),
  );
  const [overrides, setOverrides] = useState<Record<string, string>>(
    () => ({ ...initial.overrides }) as Record<string, string>,
  );
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const all = settings.models.every((m) => allowed.has(m.id));

  const save = async () => {
    setSaving(true);
    setStatus(null);
    try {
      const res = await fetch('/api/agent/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          modelDefaults: Object.fromEntries(TIERS.map((t) => [t.key, overrides[t.key] || null])),
          allowedModels: all ? null : [...allowed],
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.message ?? 'Could not save');
      setSettings(body);
      setStatus('Saved.');
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="card mt-4 space-y-5 p-5"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="space-y-3">
        {TIERS.map((t) => (
          <label key={t.key} className="block text-sm">
            <span className="label">
              {t.label} <span className="font-normal text-muted">({t.hint})</span>
            </span>
            <select
              className="input"
              value={overrides[t.key] ?? ''}
              onChange={(e) => setOverrides((o) => ({ ...o, [t.key]: e.target.value }))}
            >
              <option value="">
                Built-in default (
                {settings.models.find((m) => m.id === settings.tierDefaults[t.key])?.label})
              </option>
              {settings.models
                .filter((m) => allowed.has(m.id))
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label} · {m.relativeCostLabel} cost
                  </option>
                ))}
            </select>
          </label>
        ))}
      </div>
      <fieldset>
        <legend className="label">Allowed models</legend>
        <p className="mb-2 text-xs text-muted">
          Members can pick any allowed model per prompt. Cost is relative to the default chat model.
        </p>
        <ul className="grid gap-1 sm:grid-cols-2">
          {settings.models.map((m) => (
            <li key={m.id}>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={allowed.has(m.id)}
                  onChange={(e) =>
                    setAllowed((s) => {
                      const next = new Set(s);
                      if (e.target.checked) next.add(m.id);
                      else if (next.size > 1) next.delete(m.id);
                      return next;
                    })
                  }
                />
                {m.label} <span className="text-xs text-muted">{m.relativeCostLabel}</span>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
      <div className="flex items-center gap-3">
        <button type="submit" className="btn-primary" disabled={saving}>
          {saving ? 'Saving…' : 'Save model settings'}
        </button>
        {status && <p className="text-sm text-muted">{status}</p>}
      </div>
    </form>
  );
}
