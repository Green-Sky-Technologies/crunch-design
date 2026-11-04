'use client';

/**
 * Per-prompt model picker (Story 5.9). "Default" uses the workspace default for the task
 * (Sonnet-class for chat, Opus-class for jobs). Each option shows its cost relative to the
 * interactive default, so a 2× or 0.05× choice is visible before sending.
 */
import { useEffect, useState } from 'react';

export interface ModelOption {
  id: string;
  label: string;
  tier: string;
  relativeCost: number;
  relativeCostLabel: string;
  allowed: boolean;
}

export interface AgentSettings {
  models: ModelOption[];
  defaults: Record<'generation' | 'interactive' | 'utility', string | null>;
  overrides: Partial<Record<'generation' | 'interactive' | 'utility', string>>;
  allowedModels: string[] | null;
  canManage: boolean;
}

export function useAgentSettings(enabled: boolean): AgentSettings | null {
  const [settings, setSettings] = useState<AgentSettings | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetch('/api/agent/settings')
      .then((r) => (r.ok ? (r.json() as Promise<AgentSettings>) : null))
      .then((s) => !cancelled && setSettings(s))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return settings;
}

const short = (label: string) => label.replace(/^Claude /, '');

export function ModelPicker({
  settings,
  value,
  onChange,
}: {
  settings: AgentSettings | null;
  value: string;
  onChange: (model: string) => void;
}) {
  if (!settings) return null;
  const def = settings.models.find((m) => m.id === settings.defaults.interactive);
  const options = settings.models.filter((m) => m.allowed);
  return (
    <select
      className="w-full min-w-0 truncate rounded-md border border-border bg-surface px-1.5 py-1 text-xs"
      aria-label="Model"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      title="Estimated cost is relative to the default chat model"
    >
      <option value="">
        Default{def ? ` · ${short(def.label)} (${def.relativeCostLabel})` : ''}
      </option>
      {options.map((m) => (
        <option key={m.id} value={m.id}>
          {short(m.label)} · {m.relativeCostLabel} cost
        </option>
      ))}
    </select>
  );
}
