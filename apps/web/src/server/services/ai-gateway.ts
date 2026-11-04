/**
 * Deployment-wide Vercel AI Gateway (SERVER-ONLY). When enabled, every workspace without its own
 * working credential reaches Claude through the gateway, billed to the Vercel team that hosts
 * this deployment.
 *
 * Env:
 *  - CRUNCH_AI_GATEWAY: `on` forces it on, `off` turns it off. Unset (or `auto`): on when running
 *    on Vercel (`VERCEL`) or when AI_GATEWAY_API_KEY is set.
 *  - AI_GATEWAY_API_KEY: used if set; otherwise the Vercel OIDC token (VERCEL_OIDC_TOKEN locally,
 *    via `vercel env pull`), fetched before every request because it expires.
 *
 * The token is only ever sent to the gateway from the server. It never reaches a sandbox (they
 * call the LLM proxy with a job token) or the browser.
 */
import 'server-only';
import { getVercelOidcToken } from '@vercel/oidc';
import { buildGatewayClient, type ClaudeClient } from '@crunch/providers';

type Env = Record<string, string | undefined>;

export interface DeploymentGatewayConfig {
  enabled: boolean;
  /** How requests authenticate when enabled. */
  auth: 'api_key' | 'oidc';
}

/** Whether the deployment gateway is on, from env only. Cheap; call it per request. */
export function deploymentGatewayConfig(env: Env = process.env): DeploymentGatewayConfig {
  const mode = env.CRUNCH_AI_GATEWAY?.trim().toLowerCase();
  const apiKey = Boolean(env.AI_GATEWAY_API_KEY?.trim());
  const enabled =
    mode === 'off' || mode === 'false' || mode === '0'
      ? false
      : mode === 'on' || mode === 'true' || mode === '1'
        ? true
        : Boolean(env.VERCEL) || apiKey;
  return { enabled, auth: apiKey ? 'api_key' : 'oidc' };
}

export interface GatewayClientDeps {
  env?: Env;
  /** Override for tests; defaults to @vercel/oidc. */
  oidcToken?: () => Promise<string>;
}

/** SERVER-ONLY: a client on the deployment gateway, or null when it's off. */
export function loadDeploymentGatewayClient(deps: GatewayClientDeps = {}): ClaudeClient | null {
  const env = deps.env ?? process.env;
  const cfg = deploymentGatewayConfig(env);
  if (!cfg.enabled) return null;
  const apiKey = env.AI_GATEWAY_API_KEY?.trim();
  if (apiKey) return buildGatewayClient(apiKey);
  const oidc = deps.oidcToken ?? (() => getVercelOidcToken());
  return buildGatewayClient(async () => {
    try {
      return await oidc();
    } catch {
      // The underlying error can include token details; keep the message generic.
      throw new Error(
        'AI Gateway is on but has no credentials: set AI_GATEWAY_API_KEY or run on Vercel (locally: `vercel env pull` for VERCEL_OIDC_TOKEN)',
      );
    }
  });
}
