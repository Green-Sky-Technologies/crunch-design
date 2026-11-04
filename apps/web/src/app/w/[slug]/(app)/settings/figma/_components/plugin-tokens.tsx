'use client';

import { useState, useTransition } from 'react';
import { createPluginTokenAction, revokePluginTokenAction } from '@/server/actions/figma';
import type { PublicPluginToken } from '@/server/services/plugin-tokens';

interface Props {
  initial: PublicPluginToken[];
  currentUserId: string;
}

/** Create, list and revoke Figma plugin tokens. A new token is shown once, then only its hint. */
export function PluginTokens({ initial, currentUserId }: Props) {
  const [tokens, setTokens] = useState(initial);
  const [name, setName] = useState('Figma desktop');
  const [fresh, setFresh] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const create = () =>
    start(async () => {
      const res = await createPluginTokenAction(name);
      if (res.ok) {
        setTokens((t) => [res.data.record, ...t]);
        setFresh(res.data.token);
        setCopied(false);
        setError(null);
      } else setError(res.error);
    });

  const revoke = (id: string) =>
    start(async () => {
      const res = await revokePluginTokenAction(id);
      if (res.ok) {
        setTokens((t) => t.filter((x) => x.id !== id));
        setError(null);
      } else setError(res.error);
    });

  return (
    <div className="card p-5">
      <h2 className="font-medium">Plugin tokens</h2>
      <p className="mt-1 text-sm text-muted">
        Paste a token into the CrunchDesign Figma plugin. It acts as you, in this workspace only,
        with your current role. Tokens are stored hashed; copy a new one now, because it won&apos;t
        be shown again.
      </p>

      {fresh && (
        <div className="mt-4 rounded-md border border-accent/40 bg-surface-2 p-3">
          <p className="text-sm font-medium">New token (shown once)</p>
          <div className="mt-2 flex gap-2">
            <code className="min-w-0 flex-1 break-all rounded bg-surface px-2 py-1.5 font-mono text-xs">
              {fresh}
            </code>
            <button
              className="btn-ghost"
              onClick={() => {
                void navigator.clipboard?.writeText(fresh).then(() => setCopied(true));
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button className="btn-ghost" onClick={() => setFresh(null)}>
              Done
            </button>
          </div>
        </div>
      )}

      <form
        className="mt-4 flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          create();
        }}
      >
        <div className="flex-1">
          <label className="label" htmlFor="token-name">
            Token name
          </label>
          <input
            id="token-name"
            className="input"
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <button className="btn-primary" disabled={pending || !name.trim()}>
          {pending ? 'Working…' : 'Create token'}
        </button>
      </form>
      {error && <p className="mt-3 text-sm text-danger">{error}</p>}

      {tokens.length > 0 ? (
        <ul className="mt-5 divide-y divide-border border-t border-border">
          {tokens.map((t) => (
            <li key={t.id} className="flex items-center gap-3 py-3 text-sm">
              <div className="min-w-0 flex-1">
                <p className="font-medium">
                  {t.name}
                  {t.userId !== currentUserId && (
                    <span className="ml-2 text-xs font-normal text-muted">(another member)</span>
                  )}
                </p>
                <p className="font-mono text-xs text-muted">
                  {t.hint} · created {new Date(t.createdAt).toLocaleDateString()} ·{' '}
                  {t.lastUsedAt
                    ? `last used ${new Date(t.lastUsedAt).toLocaleString()}`
                    : 'never used'}
                </p>
              </div>
              <button className="btn-danger" disabled={pending} onClick={() => revoke(t.id)}>
                Revoke
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-5 text-sm text-muted">No active tokens.</p>
      )}
    </div>
  );
}
