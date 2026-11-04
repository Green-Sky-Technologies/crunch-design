/** Browser client for the collaboration APIs (comments, notifications). JSON dates are strings. */
import type { CommentAnchor, CommentView, ThreadView } from '@/server/services/comments';

type Jsonify<T> = T extends Date
  ? string
  : T extends (infer U)[]
    ? Jsonify<U>[]
    : T extends object
      ? { [K in keyof T]: Jsonify<T[K]> }
      : T;

export type Thread = Jsonify<ThreadView>;
export type Comment = Jsonify<CommentView>;
export type Anchor = CommentAnchor;

export interface Member {
  userId: string;
  name: string | null;
  email: string | null;
  imageUrl: string | null;
}

export interface Notification {
  id: string;
  kind: string;
  projectId: string | null;
  data: { threadId?: string; commentId?: string; by?: string; excerpt?: string };
  readAt: string | null;
  createdAt: string;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly fieldErrors?: Record<string, string[]>,
  ) {
    super(message);
  }
}

export async function request<T>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(url, {
    cache: 'no-store',
    ...rest,
    headers:
      json !== undefined ? { 'content-type': 'application/json', ...rest.headers } : rest.headers,
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    let fieldErrors: Record<string, string[]> | undefined;
    try {
      const b = (await res.json()) as { message?: string; fieldErrors?: Record<string, string[]> };
      if (b.message) msg = b.message;
      fieldErrors = b.fieldErrors;
    } catch {
      // non-JSON error body
    }
    throw new ApiError(res.status, msg, fieldErrors);
  }
  return (await res.json()) as T;
}

export const commentsApi = {
  list: (projectId: string) =>
    request<{ threads: Thread[] }>(`/api/comments?projectId=${encodeURIComponent(projectId)}`),
  create: (input: {
    projectId: string;
    anchor: Anchor;
    body: string;
    mentions: string[];
    kind?: 'discussion' | 'agent_request';
    fallback?: { x: number; y: number };
  }) => request<{ thread: Thread }>('/api/comments', { method: 'POST', json: input }),
  reply: (threadId: string, input: { body: string; mentions: string[] }) =>
    request<{ thread: Thread }>(`/api/comments/${threadId}/replies`, {
      method: 'POST',
      json: input,
    }),
  setStatus: (threadId: string, status: 'open' | 'resolved') =>
    request<{ thread: Thread }>(`/api/comments/${threadId}`, {
      method: 'PATCH',
      json: { status },
    }),
  setFallback: (threadId: string, fallback: { x: number; y: number }) =>
    request<{ ok: true }>(`/api/comments/${threadId}`, { method: 'PATCH', json: { fallback } }),
  linkConversation: (threadId: string, agentConversationId: string) =>
    request<{ thread: Thread }>(`/api/comments/${threadId}`, {
      method: 'PATCH',
      json: { agentConversationId },
    }),
  members: () => request<{ members: Member[] }>('/api/comments/members'),
  notifications: () => request<{ notifications: Notification[] }>('/api/comments/notifications'),
  markRead: (target: string[] | 'all') =>
    request<{ updated: number }>('/api/comments/notifications', {
      method: 'POST',
      json: target === 'all' ? { all: true } : { ids: target },
    }),
};

export function memberLabel(m: Pick<Member, 'name' | 'email' | 'userId'> | undefined): string {
  if (!m) return 'Member';
  return m.name || m.email || 'Member';
}
