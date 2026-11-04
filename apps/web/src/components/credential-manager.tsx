'use client';

import type { Provider, PublicCredential } from '@crunch/providers';
import { useState, useTransition } from 'react';
import {
  deleteCredentialAction,
  saveCredentialAction,
  testCredentialAction,
} from '@/server/actions/credentials';

const OPTIONS: { id: Provider; label: string; blurb: string }[] = [
  { id: 'anthropic', label: 'Anthropic API', blurb: 'An API key from the Claude Console.' },
  { id: 'bedrock', label: 'Amazon Bedrock', blurb: 'Claude in your AWS account.' },
  { id: 'vertex', label: 'Google Vertex AI', blurb: 'Claude in your Google Cloud project.' },
  { id: 'foundry', label: 'Microsoft Foundry', blurb: 'Claude in your Azure Foundry resource.' },
  { id: 'gateway', label: 'Vercel AI Gateway', blurb: 'An AI Gateway key from your Vercel team.' },
];

interface Props {
  /** The deployment's Vercel AI Gateway serves workspaces without a working key of their own. */
  deploymentGateway: boolean;
  initial: PublicCredential | null;
  externalId: string;
  awsPrincipalArn: string | null;
}

export function CredentialManager({
  deploymentGateway,
  initial,
  externalId,
  awsPrincipalArn,
}: Props) {
  const [cred, setCred] = useState(initial);
  const [editing, setEditing] = useState(!initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const runAction = (fn: () => ReturnType<typeof testCredentialAction>) =>
    start(async () => {
      const res = await fn();
      if (res.ok) {
        setCred(res.data);
        setError(null);
      } else setError(res.error);
    });

  const form = (
    <CredentialForm
      externalId={externalId}
      awsPrincipalArn={awsPrincipalArn}
      onCancel={cred ? () => setEditing(false) : undefined}
      onSaved={(c) => {
        setCred(c);
        setEditing(false);
      }}
    />
  );

  const card = cred && (
    <div className="card p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="font-medium">{cred.providerLabel}</p>
          <p className="font-mono text-sm text-muted">{cred.hint}</p>
        </div>
        <StatusBadge status={cred.status} />
      </div>
      {Object.keys(cred.details).length > 0 && (
        <dl className="mt-4 grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm">
          {Object.entries(cred.details).map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted">{k}</dt>
              <dd className="break-all font-mono">{v}</dd>
            </div>
          ))}
        </dl>
      )}
      {cred.status === 'error' && cred.lastError && (
        <p className="mt-4 rounded-md bg-surface-2 p-3 text-sm text-danger">{cred.lastError}</p>
      )}
      {cred.lastTestedAt && (
        <p className="mt-3 text-xs text-muted">
          Last tested {new Date(cred.lastTestedAt).toLocaleString()}
        </p>
      )}
      {error && <p className="mt-3 text-sm text-danger">{error}</p>}
      <div className="mt-5 flex gap-2">
        <button
          className="btn-ghost"
          disabled={pending}
          onClick={() => runAction(testCredentialAction)}
        >
          {pending ? 'Testing…' : 'Test connection'}
        </button>
        <button className="btn-ghost" disabled={pending} onClick={() => setEditing(true)}>
          Replace
        </button>
        <button
          className="btn-danger ml-auto"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const res = await deleteCredentialAction();
              if (res.ok) {
                setCred(null);
                setEditing(true);
              } else setError(res.error);
            })
          }
        >
          Remove
        </button>
      </div>
    </div>
  );

  const own = cred && !editing ? card : form;
  if (!deploymentGateway) return own;

  // Deployment gateway on: it leads; a workspace key is optional and takes over once it works.
  const ownKeyInUse = cred?.status === 'ok';
  return (
    <div className="grid gap-6">
      <GatewayCard active={!ownKeyInUse} />
      {cred ? (
        <section>
          <h2 className="mb-1 font-medium">Your own key</h2>
          <p className="mb-3 text-sm text-muted">
            {ownKeyInUse
              ? 'In use instead of the gateway. Remove it to fall back to the gateway.'
              : 'Not in use until it passes a test. The gateway is used meanwhile.'}
          </p>
          {own}
        </section>
      ) : (
        <details>
          <summary className="cursor-pointer text-sm font-medium text-muted hover:text-text">
            Use your own key instead
          </summary>
          <p className="mb-3 mt-2 text-sm text-muted">
            Bill usage to your own provider account or Vercel team. A key that passes its test
            replaces the gateway for this workspace.
          </p>
          {own}
        </details>
      )}
    </div>
  );
}

function GatewayCard({ active }: { active: boolean }) {
  return (
    <div className="card p-5">
      <div className="flex items-start justify-between gap-4">
        <p className="font-medium">Vercel AI Gateway</p>
        <span
          className={`rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium ${active ? 'text-ok' : 'text-muted'}`}
        >
          ● {active ? 'In use' : 'Standby'}
        </span>
      </div>
      <p className="mt-2 text-sm">
        Models are provided by this deployment&apos;s Vercel AI Gateway. No setup needed.
      </p>
      <p className="mt-1 text-sm text-muted">
        Usage is billed to the Vercel team that hosts this deployment.
      </p>
    </div>
  );
}

function StatusBadge({ status }: { status: PublicCredential['status'] }) {
  const map = {
    ok: ['Connected', 'text-ok'],
    error: ['Failing', 'text-danger'],
    untested: ['Not tested', 'text-muted'],
  } as const;
  const [label, color] = map[status];
  return (
    <span className={`rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium ${color}`}>
      ● {label}
    </span>
  );
}

function CredentialForm({
  externalId,
  awsPrincipalArn,
  onCancel,
  onSaved,
}: {
  externalId: string;
  awsPrincipalArn: string | null;
  onCancel?: () => void;
  onSaved: (c: PublicCredential) => void;
}) {
  const [provider, setProvider] = useState<Provider>('anthropic');
  const [authMode, setAuthMode] = useState<'assume_role' | 'access_keys'>('assume_role');
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [result, setResult] = useState<PublicCredential | null>(null);
  const [pending, start] = useTransition();

  const submit = (form: FormData) => {
    const input: Record<string, unknown> = { provider };
    for (const [k, v] of form.entries()) if (typeof v === 'string') input[k] = v;
    if (provider === 'bedrock') input.authMode = authMode;
    start(async () => {
      const res = await saveCredentialAction(input);
      if (res.ok) {
        setErrors({});
        setFormError(null);
        if (res.data.status === 'ok') onSaved(res.data);
        else setResult(res.data); // saved, but the test failed: stay on the form and show why
      } else {
        setErrors(res.fieldErrors ?? {});
        setFormError(res.error);
      }
    });
  };

  const err = (k: string) =>
    errors[k]?.[0] && <p className="mt-1 text-sm text-danger">{errors[k]![0]}</p>;
  const trustPolicy = JSON.stringify(
    {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: { AWS: awsPrincipalArn ?? '<CrunchDesign AWS principal ARN>' },
          Action: 'sts:AssumeRole',
          Condition: { StringEquals: { 'sts:ExternalId': externalId } },
        },
      ],
    },
    null,
    2,
  );

  return (
    <form action={submit} className="card p-5">
      <fieldset>
        <legend className="label">Provider</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {OPTIONS.map((o) => (
            <label
              key={o.id}
              className={`cursor-pointer rounded-md border p-3 text-sm ${provider === o.id ? 'border-accent ring-2 ring-accent/20' : 'border-border'}`}
            >
              <input
                type="radio"
                name="_provider"
                className="sr-only"
                checked={provider === o.id}
                onChange={() => setProvider(o.id)}
              />
              <span className="font-medium">{o.label}</span>
              <span className="block text-muted">{o.blurb}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="mt-5 grid gap-4" key={provider}>
        {(provider === 'anthropic' || provider === 'gateway') && (
          <div>
            <label className="label" htmlFor="apiKey">
              API key
            </label>
            <input
              id="apiKey"
              name="apiKey"
              type="password"
              autoComplete="off"
              className="input font-mono"
              placeholder={provider === 'gateway' ? 'vck_…' : 'sk-ant-…'}
              required
            />
            {err('apiKey')}
          </div>
        )}

        {provider === 'bedrock' && (
          <>
            <div>
              <label className="label" htmlFor="region">
                AWS region
              </label>
              <input
                id="region"
                name="region"
                className="input font-mono"
                placeholder="us-east-1"
                required
              />
              {err('region')}
            </div>
            <div className="flex gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  checked={authMode === 'assume_role'}
                  onChange={() => setAuthMode('assume_role')}
                />
                Assume an IAM role <span className="text-muted">(recommended)</span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  checked={authMode === 'access_keys'}
                  onChange={() => setAuthMode('access_keys')}
                />
                Access keys
              </label>
            </div>
            {authMode === 'assume_role' ? (
              <>
                <div>
                  <label className="label" htmlFor="roleArn">
                    Role ARN
                  </label>
                  <input
                    id="roleArn"
                    name="roleArn"
                    className="input font-mono"
                    placeholder="arn:aws:iam::123456789012:role/CrunchDesignBedrock"
                    required
                  />
                  {err('roleArn')}
                </div>
                <div className="rounded-md bg-surface-2 p-3 text-sm">
                  <p className="mb-2">
                    Give the role <code className="font-mono">bedrock:InvokeModel*</code>{' '}
                    permissions and this trust policy. The external ID is unique to your workspace.
                  </p>
                  <pre className="overflow-x-auto rounded bg-surface p-3 font-mono text-xs">
                    {trustPolicy}
                  </pre>
                </div>
              </>
            ) : (
              <>
                <div>
                  <label className="label" htmlFor="accessKeyId">
                    Access key ID
                  </label>
                  <input id="accessKeyId" name="accessKeyId" className="input font-mono" required />
                  {err('accessKeyId')}
                </div>
                <div>
                  <label className="label" htmlFor="secretAccessKey">
                    Secret access key
                  </label>
                  <input
                    id="secretAccessKey"
                    name="secretAccessKey"
                    type="password"
                    autoComplete="off"
                    className="input font-mono"
                    required
                  />
                  {err('secretAccessKey')}
                </div>
              </>
            )}
          </>
        )}

        {provider === 'vertex' && (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor="projectId">
                  GCP project ID
                </label>
                <input id="projectId" name="projectId" className="input font-mono" required />
                {err('projectId')}
              </div>
              <div>
                <label className="label" htmlFor="region">
                  Region
                </label>
                <input
                  id="region"
                  name="region"
                  className="input font-mono"
                  defaultValue="global"
                  required
                />
                {err('region')}
              </div>
            </div>
            <div>
              <label className="label" htmlFor="serviceAccountJson">
                Service account key (JSON)
              </label>
              <textarea
                id="serviceAccountJson"
                name="serviceAccountJson"
                className="input min-h-32 font-mono text-xs"
                placeholder='{"type": "service_account", …}'
                required
              />
              {err('serviceAccountJson')}
            </div>
          </>
        )}

        {provider === 'foundry' && (
          <>
            <div>
              <label className="label" htmlFor="resource">
                Foundry resource name
              </label>
              <input id="resource" name="resource" className="input font-mono" required />
              {err('resource')}
            </div>
            <div>
              <label className="label" htmlFor="apiKey">
                API key
              </label>
              <input
                id="apiKey"
                name="apiKey"
                type="password"
                autoComplete="off"
                className="input font-mono"
                required
              />
              {err('apiKey')}
            </div>
          </>
        )}
      </div>

      {formError && <p className="mt-4 text-sm text-danger">{formError}</p>}
      {result && result.status === 'error' && (
        <p className="mt-4 rounded-md bg-surface-2 p-3 text-sm text-danger">
          Saved, but the connection test failed: {result.lastError}
        </p>
      )}
      <div className="mt-6 flex justify-end gap-2">
        {onCancel && (
          <button type="button" className="btn-ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button type="submit" className="btn-primary" disabled={pending}>
          {pending ? 'Saving & testing…' : 'Save and test'}
        </button>
      </div>
    </form>
  );
}
