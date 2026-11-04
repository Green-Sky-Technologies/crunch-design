/** Browser client for the agent API. Types mirror the server's MessageView (no server imports). */

export type MessageStatus = 'pending' | 'streaming' | 'complete' | 'error' | 'cancelled';

export interface ToolActivity {
  id: string;
  name: string;
  status: 'running' | 'done' | 'error';
}

export interface JobSuggestion {
  kind: 'generate' | 'redesign' | 'alternatives';
  prompt: string;
  frameIds?: string[];
  count?: number;
  reason: string;
}

export type Attachment =
  | { type: 'image'; url: string }
  | { type: 'url'; url: string }
  | { type: 'figma'; fileKey: string; nodeId: string };

export interface MessageView {
  id: string;
  conversationId: string;
  seq: number;
  role: 'user' | 'assistant' | 'system';
  status: MessageStatus;
  model: string | null;
  text: string;
  activity: ToolActivity[];
  touched: string[];
  txnIds: string[];
  jobSuggestion: JobSuggestion | null;
  context?: { selection?: string[]; frameId?: string | null; scopeNodeId?: string } | null;
  jobId: string | null;
  snapshotVersionId: string | null;
  attachments: Attachment[];
  error: string | null;
  createdAt: string;
}

export interface SendBody {
  projectId: string;
  conversationId?: string;
  prompt: string;
  model?: string;
  selection?: string[];
  frameId?: string | null;
  attachments?: Attachment[];
}

export interface SendResult {
  conversationId: string;
  userMessageId: string;
  messageId: string;
  needsRun: boolean;
  streamUrl: string;
}

export class AgentApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

async function json<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as { message?: string };
  if (!res.ok)
    throw new AgentApiError(body.message ?? `Request failed (${res.status})`, res.status);
  return body as T;
}

const post = (url: string, body?: unknown) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

export type JobStatus =
  'queued' | 'provisioning' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface JobView {
  id: string;
  kind: string;
  status: JobStatus;
  error: string | null;
  result: { summary?: string; frames?: { frameId: string; name: string }[] } | null;
  lastEventSeq: number;
}

export interface JobEvent {
  seq: number;
  type: 'status' | 'progress' | 'log' | 'tool' | 'frame' | 'result' | 'error';
  data: Record<string, unknown>;
  createdAt: string;
}

export interface StartJobBody {
  projectId: string;
  conversationId?: string;
  kind: JobSuggestion['kind'];
  prompt: string;
  frameIds?: string[];
  count?: number;
  model?: string;
}

export const agentApi = {
  chat: (projectId: string) =>
    fetch(`/api/agent/chat?projectId=${encodeURIComponent(projectId)}`).then((r) =>
      json<{ conversationId: string | null; messages: MessageView[] }>(r),
    ),
  send: (body: SendBody) => post('/api/agent/messages', body).then((r) => json<SendResult>(r)),
  cancel: (messageId: string) =>
    post(`/api/agent/messages/${messageId}/cancel`).then((r) => json<MessageView>(r)),
  startJob: (body: StartJobBody) =>
    post('/api/agent/jobs', body).then((r) => json<{ job: JobView; message: MessageView }>(r)),
  getJob: (jobId: string) => fetch(`/api/jobs/${jobId}`).then((r) => json<JobView>(r)),
  cancelJob: (jobId: string) => post(`/api/jobs/${jobId}/cancel`).then((r) => json<JobView>(r)),
  uploadImage: async (projectId: string, file: File) => {
    const form = new FormData();
    form.set('projectId', projectId);
    form.set('file', file);
    return json<{ url: string }>(
      await fetch('/api/agent/attachments', { method: 'POST', body: form }),
    );
  },
};

/**
 * Follow a message's SSE stream. Calls `onView` on each change and resolves when it's done.
 * EventSource reconnects on its own; the server sends the current state on every connect.
 */
export function followMessage(
  streamUrl: string,
  onView: (v: MessageView) => void,
): { done: Promise<void>; close: () => void } {
  if (typeof EventSource === 'undefined') return { done: Promise.resolve(), close: () => {} };
  const es = new EventSource(streamUrl);
  let resolve!: () => void;
  const done = new Promise<void>((r) => (resolve = r));
  es.addEventListener('message', (e) => onView(JSON.parse((e as MessageEvent<string>).data)));
  es.addEventListener('done', () => {
    es.close();
    resolve();
  });
  return {
    done,
    close: () => {
      es.close();
      resolve();
    },
  };
}

/**
 * Follow a job's event stream. The browser resends Last-Event-ID on reconnect, and the server
 * replays everything after it, so progress survives network blips and reloads.
 */
export function followJob(jobId: string, onEvent: (e: JobEvent) => void): () => void {
  if (typeof EventSource === 'undefined') return () => {};
  const es = new EventSource(`/api/jobs/${jobId}/events`);
  for (const type of ['status', 'progress', 'log', 'tool', 'frame', 'result', 'error'])
    es.addEventListener(type, (e) => onEvent(JSON.parse((e as MessageEvent<string>).data)));
  es.addEventListener('done', () => es.close());
  return () => es.close();
}

/** Parse a Figma frame link (figma.com/design|file/<key>/…?node-id=1-2). */
export function parseFigmaLink(url: string): { fileKey: string; nodeId: string } | null {
  const m = url.match(
    /figma\.com\/(?:design|file|proto)\/([A-Za-z0-9]{10,64})[^?]*\?(?:.*&)?node-id=([0-9]+[-:][0-9]+)/,
  );
  return m ? { fileKey: m[1]!, nodeId: m[2]!.replace('-', ':') } : null;
}

/** Turn pasted text into an attachment, or null if it isn't a usable link. */
export function attachmentFromLink(text: string): Attachment | null {
  const t = text.trim();
  const figma = parseFigmaLink(t);
  if (figma) return { type: 'figma', ...figma };
  try {
    const u = new URL(t);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (/\.(png|jpe?g|webp|gif)$/i.test(u.pathname) && u.protocol === 'https:')
      return { type: 'image', url: u.toString() };
    return { type: 'url', url: u.toString() };
  } catch {
    return null;
  }
}
