/** CrunchDesign plugin API client (runs in the UI iframe, which has network access). */
import type { PushPlan, ReportItem } from '@crunch/figma-convert/plugin';
import type { Settings } from '../shared/messages';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface Me {
  userId: string;
  role: 'admin' | 'editor' | 'viewer';
  workspace: { id: string; name: string; slug: string };
}
export interface Project {
  id: string;
  name: string;
  updatedAt: string;
}
export interface FrameInfo {
  id: string;
  name: string;
  width: number;
  height: number | 'auto';
  nodeCount: number;
}

/**
 * The plugin token travels in every request, so the API must be https. Plain http is allowed
 * only for local development (localhost / loopback).
 */
export function normalizeBase(base: string): string {
  const b = base.trim().replace(/\/+$/, '');
  const m = /^(https?):\/\/([^\s/?#@]+)$/.exec(b);
  if (!m) throw new Error('API URL must look like https://host');
  const host = m[2]!.replace(/:\d+$/, '').toLowerCase();
  const local = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  if (m[1] === 'http' && !local) throw new Error('Use https (http is only allowed for localhost)');
  return b;
}

export class Api {
  constructor(private readonly settings: Settings) {}

  async request<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const res = await fetch(`${normalizeBase(this.settings.apiBase)}/api/figma/plugin${path}`, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${this.settings.token}`,
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // non-JSON error page
    }
    if (!res.ok) {
      const d = (data ?? {}) as { error?: string; message?: string };
      throw new ApiError(res.status, d.error ?? 'http_error', d.message ?? `HTTP ${res.status}`);
    }
    return data as T;
  }

  me() {
    return this.request<Me>('/me');
  }
  projects() {
    return this.request<{ projects: Project[] }>('/projects');
  }
  frames(projectId: string) {
    return this.request<{ projectId: string; version: number; frames: FrameInfo[] }>(
      `/projects/${encodeURIComponent(projectId)}/frames`,
    );
  }
  pushPlan(projectId: string, body: { frameIds?: string[]; width?: number; variables?: boolean }) {
    return this.request<PushPlan>(`/projects/${encodeURIComponent(projectId)}/push-plan`, {
      method: 'POST',
      body,
    });
  }
  importNodes(projectId: string, body: Record<string, unknown>) {
    return this.request<{
      version: number;
      frames: { id: string; name: string }[];
      report: ReportItem[];
      stats: { nodes: number; tokens: number; svgs: number; images: number };
    }>(`/projects/${encodeURIComponent(projectId)}/import`, { method: 'POST', body });
  }
  variables<T>(
    projectId: string,
    step: 'diff' | 'pull' | 'push-plan' | 'push-result',
    body: unknown,
  ) {
    return this.request<T>(`/projects/${encodeURIComponent(projectId)}/variables/${step}`, {
      method: 'POST',
      body,
    });
  }
  pushResult(
    projectId: string,
    body: {
      fileKey: string;
      fileName?: string;
      pageId?: string;
      docVersion: number;
      nodeMap: Record<string, string>;
      report: ReportItem[];
    },
  ) {
    return this.request<{ nodeCount: number; lastSyncedAt: string }>(
      `/projects/${encodeURIComponent(projectId)}/push-result`,
      { method: 'POST', body },
    );
  }
}
