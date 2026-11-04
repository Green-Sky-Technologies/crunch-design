// @vitest-environment happy-dom
import { permissionsFor, type Role } from '@crunch/authz';
import { sampleLandingDoc, starterDesignSystem } from '@crunch/doc-model';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorProvider, type DocApi } from '../doc-store';
import { AgentPane } from './index';
import { attachmentFromLink, parseFigmaLink, type MessageView } from './api';

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

class FakeEventSource {
  static all: FakeEventSource[] = [];
  listeners = new Map<string, ((e: MessageEvent) => void)[]>();
  closed = false;
  constructor(public url: string) {
    FakeEventSource.all.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  emit(type: string, data: unknown) {
    for (const fn of this.listeners.get(type) ?? [])
      fn({ data: JSON.stringify(data) } as MessageEvent);
  }
  close() {
    this.closed = true;
  }
}

const view = (over: Partial<MessageView>): MessageView => ({
  id: 'm',
  conversationId: 'c1',
  seq: 1,
  role: 'assistant',
  status: 'complete',
  model: 'claude-sonnet-5-5',
  text: '',
  activity: [],
  touched: [],
  txnIds: [],
  jobSuggestion: null,
  jobId: null,
  snapshotVersionId: null,
  attachments: [],
  error: null,
  createdAt: new Date().toISOString(),
  ...over,
});

let fetchMock: ReturnType<typeof vi.fn>;
let initialMessages: MessageView[] = [];
let snapshotDoc: unknown = null;

beforeEach(() => {
  FakeEventSource.all = [];
  initialMessages = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const body = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });
    if (url.startsWith('/api/agent/chat'))
      return body({
        conversationId: initialMessages.length ? 'c1' : null,
        messages: initialMessages,
      });
    if (url === '/api/agent/messages' && init?.method === 'POST')
      return body({
        conversationId: 'c1',
        userMessageId: 'u2',
        messageId: 'a2',
        needsRun: true,
        streamUrl: '/api/agent/messages/a2/stream',
      });
    if (url === '/api/agent/settings')
      return body({
        models: [
          {
            id: 'claude-sonnet-5-5',
            label: 'Claude Sonnet 5.5',
            tier: 'interactive',
            relativeCost: 1,
            relativeCostLabel: '1×',
            allowed: true,
          },
          {
            id: 'claude-opus-5-5',
            label: 'Claude Opus 5.5',
            tier: 'generation',
            relativeCost: 2,
            relativeCostLabel: '2×',
            allowed: true,
          },
        ],
        defaults: {
          interactive: 'claude-sonnet-5-5',
          generation: 'claude-opus-5-5',
          utility: null,
        },
        overrides: {},
        allowedModels: null,
        canManage: false,
      });
    if (url.endsWith('/snapshot')) return body({ snapshotId: 's1', doc: snapshotDoc });
    if (url === '/api/agent/jobs')
      return body({
        job: { id: 'j1', status: 'queued' },
        message: view({ id: 'a9', seq: 9, status: 'streaming', jobId: 'j1' }),
      });
    if (url.endsWith('/cancel')) return body(view({ id: 'a2', seq: 2, status: 'cancelled' }));
    return new Response('{}', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderPane(role: Role = 'editor', agentAvailable = true) {
  const doc = sampleLandingDoc();
  const api: DocApi = {
    fetchDoc: async () => ({ version: 0, doc }),
    commit: async () => ({ ok: true, version: 1 }),
    since: async () => ({ version: 0, txns: [], reset: false }),
  };
  render(
    <EditorProvider
      api={api}
      pollMs={1_000_000}
      initial={{ version: 0, doc }}
      info={{
        project: { id: '00000000-0000-4000-8000-000000000001', name: 'P', description: null },
        workspace: { id: 'w', slug: 'ws', name: 'WS' },
        user: { id: 'u', role },
        permissions: permissionsFor(role),
        designSystem: { id: 'd', name: 'Starter', version: null, spec: starterDesignSystem() },
        agentAvailable,
      }}
    >
      <AgentPane />
    </EditorProvider>,
  );
}

describe('AgentPane', () => {
  it('sends a prompt, then streams the reply with tool activity', async () => {
    renderPane();
    const box = await screen.findByLabelText('Message the agent');
    const picker = (await screen.findByLabelText('Model')) as HTMLSelectElement;
    expect(picker.textContent).toContain('Opus 5.5 · 2× cost');
    fireEvent.change(picker, { target: { value: 'claude-opus-5-5' } });
    fireEvent.change(box, { target: { value: 'make the headline bigger' } });
    fireEvent.click(screen.getByText('Send'));
    await waitFor(() => expect(FakeEventSource.all).toHaveLength(1));
    const sent = JSON.parse(
      fetchMock.mock.calls.find((c) => c[0] === '/api/agent/messages')![1].body,
    );
    expect(sent).toMatchObject({ prompt: 'make the headline bigger', model: 'claude-opus-5-5' });
    expect(screen.getByText('make the headline bigger')).toBeTruthy();

    const es = FakeEventSource.all[0]!;
    expect(es.url).toBe('/api/agent/messages/a2/stream');
    act(() =>
      es.emit(
        'message',
        view({
          id: 'a2',
          seq: 2,
          status: 'streaming',
          text: 'Making it bigger',
          activity: [{ id: 't1', name: 'patch_nodes', status: 'running' }],
        }),
      ),
    );
    expect(screen.getByText('Making it bigger')).toBeTruthy();
    expect(screen.getByText('Editing')).toBeTruthy();
    expect(screen.getByText('Working…')).toBeTruthy();

    fireEvent.click(screen.getByText('Cancel'));
    await waitFor(() => expect(screen.getByText('Cancelled.')).toBeTruthy());
    fireEvent.click(screen.getByText('Retry'));
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter((c) => c[0] === '/api/agent/messages')).toHaveLength(2),
    );
  });

  it('resumes following a reply that was still running when the pane loaded', async () => {
    initialMessages = [
      view({ id: 'u1', role: 'user', seq: 1, text: 'hi' }),
      view({ id: 'a1', seq: 2, status: 'streaming', text: 'Part' }),
    ];
    renderPane();
    await waitFor(() => expect(FakeEventSource.all[0]?.url).toBe('/api/agent/messages/a1/stream'));
    act(() => FakeEventSource.all[0]!.emit('done', { status: 'complete' }));
    expect(FakeEventSource.all[0]!.closed).toBe(true);
  });

  it('shows job suggestions as cards', async () => {
    initialMessages = [
      view({ id: 'u1', role: 'user', seq: 1, text: 'Design a pricing page' }),
      view({
        id: 'a1',
        seq: 2,
        text: 'That needs new frames',
        jobSuggestion: { kind: 'generate', prompt: 'Design a pricing page', reason: 'x' },
      }),
    ];
    renderPane();
    expect(await screen.findByTestId('job-suggestion')).toBeTruthy();
    fireEvent.click(screen.getByText('Start background job'));
    expect(await screen.findByTestId('job-card')).toBeTruthy();
    const startBody = JSON.parse(
      fetchMock.mock.calls.find((c) => c[0] === '/api/agent/jobs')![1].body,
    );
    expect(startBody).toMatchObject({ kind: 'generate', prompt: 'Design a pricing page' });
    const jobStream = FakeEventSource.all.find((e) => e.url === '/api/jobs/j1/events')!;
    act(() => jobStream.emit('status', { seq: 2, type: 'status', data: { status: 'running' } }));
    act(() =>
      jobStream.emit('frame', { seq: 3, type: 'frame', data: { frameId: 'f_x', name: 'Pricing' } }),
    );
    expect(screen.getByText('Pricing')).toBeTruthy();
    expect(screen.getByTestId('job-card').dataset.status).toBe('running');
  });

  it('reverts an agent change through the doc store, undoably', async () => {
    const before = sampleLandingDoc();
    snapshotDoc = { ...before, frames: [], nodes: {} };
    vi.stubGlobal('confirm', () => true);
    initialMessages = [
      view({ id: 'u1', role: 'user', seq: 1, text: 'x' }),
      view({ id: 'a1', seq: 2, text: 'Done', txnIds: ['t1'], snapshotVersionId: 's1' }),
    ];
    renderPane();
    fireEvent.click(await screen.findByText('Revert agent change'));
    expect(await screen.findByText(/Reverted\./)).toBeTruthy();
    fireEvent.click(screen.getByText('Undo'));
    expect(await screen.findByText('Revert agent change')).toBeTruthy();
  });

  it('keeps the job card status and Cancel on unexpected events, and leaves the composer usable', async () => {
    initialMessages = [
      view({ id: 'u1', role: 'user', seq: 1, text: 'Design a pricing page' }),
      view({ id: 'a1', seq: 2, status: 'streaming', jobId: 'j1' }),
    ];
    renderPane();
    const card = await screen.findByTestId('job-card');
    const jobStream = FakeEventSource.all.find((e) => e.url === '/api/jobs/j1/events')!;
    act(() => jobStream.emit('status', { seq: 2, type: 'status', data: { status: 'running' } }));
    // An event without a valid status (e.g. an old sandbox's phase report) must not wipe it.
    act(() =>
      jobStream.emit('status', { seq: 3, type: 'status', data: { phase: 'agent_started' } }),
    );
    act(() =>
      jobStream.emit('progress', { seq: 4, type: 'progress', data: { phase: 'agent_started' } }),
    );
    expect(card.dataset.status).toBe('running');
    expect(screen.getByText('Cancel job')).toBeTruthy();
    // A running job doesn't block chatting.
    fireEvent.change(screen.getByLabelText('Message the agent'), { target: { value: 'tweak' } });
    expect((screen.getByText('Send') as HTMLButtonElement).disabled).toBe(false);
  });

  it('retry resends the original selection, frame and model', async () => {
    initialMessages = [
      view({
        id: 'u1',
        role: 'user',
        seq: 1,
        text: 'bigger',
        context: { selection: ['n_herotitle1'], frameId: 'f_desktop001' },
      }),
      view({ id: 'a1', seq: 2, status: 'error', error: 'boom', model: 'claude-opus-5-5' }),
    ];
    renderPane();
    fireEvent.click(await screen.findByText('Retry'));
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter((c) => c[0] === '/api/agent/messages')).toHaveLength(1),
    );
    const body = JSON.parse(
      fetchMock.mock.calls.find((c) => c[0] === '/api/agent/messages')![1].body,
    );
    expect(body).toMatchObject({
      prompt: 'bigger',
      selection: ['n_herotitle1'],
      frameId: 'f_desktop001',
      model: 'claude-opus-5-5',
    });
  });

  it('viewers get no composer', async () => {
    renderPane('viewer');
    expect(screen.getByText(/You have view access/)).toBeTruthy();
    expect(screen.queryByLabelText('Message the agent')).toBeNull();
  });
});

describe('attachment parsing', () => {
  it('recognizes Figma frame links, images and pages', () => {
    expect(
      parseFigmaLink('https://www.figma.com/design/AbCdEf1234567/Name?node-id=12-34&t=x'),
    ).toEqual({
      fileKey: 'AbCdEf1234567',
      nodeId: '12:34',
    });
    expect(attachmentFromLink('https://x.com/a.png')).toEqual({
      type: 'image',
      url: 'https://x.com/a.png',
    });
    expect(attachmentFromLink('https://example.com/pricing')).toEqual({
      type: 'url',
      url: 'https://example.com/pricing',
    });
    expect(attachmentFromLink('javascript:alert(1)')).toBeNull();
  });
});
