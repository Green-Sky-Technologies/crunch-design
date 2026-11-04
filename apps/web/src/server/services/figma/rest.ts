/**
 * Minimal Figma REST client for imports (Story 8.3). Read-only: Figma's REST API can't create nodes.
 *
 * SSRF: the only user-supplied input is a figma.com URL, which is parsed down to a file key and
 * node ids; requests go to api.figma.com only. Asset URLs returned by Figma (SVG renders) are
 * fetched only over https from Figma/S3 hosts, with size caps. `fetch` is injectable for tests.
 */
import { ValidationError } from '../types';

export type FigmaFetch = (url: string, init?: RequestInit) => Promise<Response>;

const API = 'https://api.figma.com';
const MAX_JSON_BYTES = 20 * 1024 * 1024;
const MAX_SVG_BYTES = 200 * 1024;
const TIMEOUT_MS = 20_000;

export interface FigmaUrl {
  fileKey: string;
  nodeIds: string[];
}

/** Parse a Figma file/design/frame URL. Node ids use "1-2" in URLs and "1:2" in the API. */
export function parseFigmaUrl(input: string): FigmaUrl {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new ValidationError('Paste a figma.com file or frame link', { url: ['Invalid URL'] });
  }
  if (url.protocol !== 'https:' || !/^(?:www\.)?figma\.com$/.test(url.hostname)) {
    throw new ValidationError('Only figma.com links are supported', { url: ['Not a Figma link'] });
  }
  const m = /^\/(?:file|design|proto|board)\/([A-Za-z0-9]{10,64})(?:\/|$)/.exec(url.pathname);
  if (!m) throw new ValidationError('Link must point to a Figma file', { url: ['No file key'] });
  const raw = url.searchParams.get('node-id');
  const nodeIds = raw
    ? raw
        .split(',')
        .map((s) => s.trim().replace('-', ':'))
        .filter((s) => /^\d+:\d+$/.test(s))
        .slice(0, 20)
    : [];
  return { fileKey: m[1]!, nodeIds };
}

export function isAllowedAssetUrl(u: string): boolean {
  try {
    const url = new URL(u);
    if (url.protocol !== 'https:') return false;
    const h = url.hostname;
    return h === 'figma.com' || h.endsWith('.figma.com') || h.endsWith('.amazonaws.com');
  } catch {
    return false;
  }
}

async function readCapped(res: Response, max: number): Promise<string> {
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > max) throw new ValidationError('Figma response is too large');
  const text = await res.text();
  if (text.length > max) throw new ValidationError('Figma response is too large');
  return text;
}

export class FigmaRest {
  constructor(
    private readonly token: string,
    private readonly fetcher: FigmaFetch = (u, i) => fetch(u, i),
  ) {}

  private async get<T>(path: string, opts: { allow403?: boolean } = {}): Promise<T | null> {
    const res = await this.fetcher(`${API}${path}`, {
      headers: { 'X-Figma-Token': this.token },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'error',
    });
    if (res.status === 403 && opts.allow403) return null;
    if (res.status === 403 || res.status === 401)
      throw new ValidationError('Figma rejected the token, or it has no access to this file');
    if (res.status === 404) throw new ValidationError('Figma file or node not found');
    if (res.status === 429)
      throw new ValidationError('Figma rate limit reached; try again shortly');
    if (!res.ok) throw new ValidationError(`Figma API error (${res.status})`);
    return JSON.parse(await readCapped(res, MAX_JSON_BYTES)) as T;
  }

  async me(): Promise<{ handle?: string; email?: string }> {
    return (await this.get<{ handle?: string; email?: string }>('/v1/me'))!;
  }

  async nodes(fileKey: string, ids: string[]): Promise<{ name: string; documents: unknown[] }> {
    const q = encodeURIComponent(ids.join(','));
    const r = (await this.get<{
      name: string;
      nodes: Record<string, { document?: unknown } | null>;
    }>(`/v1/files/${fileKey}/nodes?ids=${q}`))!;
    const documents = ids.map((id) => r.nodes?.[id]?.document).filter((d) => d !== undefined);
    return { name: r.name, documents };
  }

  /** Top-level frames of the file's first page (when the link has no node id). */
  async topFrameIds(fileKey: string, max = 10): Promise<{ name: string; ids: string[] }> {
    const r = (await this.get<{
      name: string;
      document: { children?: { children?: { id: string; type: string }[] }[] };
    }>(`/v1/files/${fileKey}?depth=2`))!;
    const page = r.document?.children?.[0];
    const ids = (page?.children ?? [])
      .filter((n) => ['FRAME', 'COMPONENT', 'COMPONENT_SET', 'SECTION'].includes(n.type))
      .map((n) => n.id)
      .slice(0, max);
    return { name: r.name, ids };
  }

  /** SVG markup for vector nodes, via Figma's render endpoint. Missing renders are skipped. */
  async svgs(fileKey: string, ids: string[]): Promise<Record<string, string>> {
    if (!ids.length) return {};
    const out: Record<string, string> = {};
    for (let i = 0; i < ids.length; i += 50) {
      const batch = ids.slice(i, i + 50);
      const r = await this.get<{ images: Record<string, string | null> }>(
        `/v1/images/${fileKey}?ids=${encodeURIComponent(batch.join(','))}&format=svg&svg_include_id=false`,
      );
      const entries = Object.entries(r?.images ?? {}).filter(
        (e): e is [string, string] => typeof e[1] === 'string' && isAllowedAssetUrl(e[1]),
      );
      await Promise.all(
        entries.map(async ([id, url]) => {
          try {
            const res = await this.fetcher(url, {
              signal: AbortSignal.timeout(TIMEOUT_MS),
              redirect: 'error',
            });
            if (res.ok) out[id] = await readCapped(res, MAX_SVG_BYTES);
          } catch {
            // skipped; the importer reports the missing vector
          }
        }),
      );
    }
    return out;
  }

  /** Image fill ref -> (temporary) https URL. */
  async imageFills(fileKey: string): Promise<Record<string, string>> {
    const r = await this.get<{ meta?: { images?: Record<string, string> } }>(
      `/v1/files/${fileKey}/images`,
    );
    const out: Record<string, string> = {};
    for (const [ref, url] of Object.entries(r?.meta?.images ?? {}))
      if (typeof url === 'string' && /^https:\/\//.test(url)) out[ref] = url;
    return out;
  }

  /** Local variables (Enterprise plans only); null when not available. */
  async variableNames(fileKey: string): Promise<Record<string, string> | null> {
    const r = await this.get<{ meta?: { variables?: Record<string, { name?: string }> } }>(
      `/v1/files/${fileKey}/variables/local`,
      { allow403: true },
    );
    if (!r) return null;
    const out: Record<string, string> = {};
    for (const [id, v] of Object.entries(r.meta?.variables ?? {})) if (v?.name) out[id] = v.name;
    return out;
  }
}
