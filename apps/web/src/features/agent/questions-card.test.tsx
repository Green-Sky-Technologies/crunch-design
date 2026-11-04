// @vitest-environment happy-dom
import { permissionsFor } from '@crunch/authz';
import { sampleLandingDoc, starterDesignSystem } from '@crunch/doc-model';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorProvider, type DocApi } from '../doc-store';
import type { MessageView, QuestionSet } from './api';
import { MessageItem } from './message-item';
import { draftAnswers, QuestionsCard } from './questions-card';
import { useAgentChat } from './use-agent-chat';

const set: QuestionSet = {
  intro: 'Two quick questions.',
  questions: [
    {
      id: 'audience',
      prompt: 'Who is it for?',
      kind: 'single',
      allowOther: true,
      options: [
        { id: 'devs', label: 'Developers' },
        { id: 'smb', label: 'Small businesses', description: 'Owners, not IT' },
      ],
    },
    {
      id: 'sections',
      prompt: 'Which sections?',
      kind: 'multi',
      allowOther: false,
      options: [
        { id: 'faq', label: 'FAQ' },
        { id: 'compare', label: 'Comparison table' },
      ],
    },
  ],
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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

class FakeEventSource {
  static all: FakeEventSource[] = [];
  listeners = new Map<string, ((e: MessageEvent) => void)[]>();
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
  close() {}
}

function Chat() {
  const chat = useAgentChat('00000000-0000-4000-8000-000000000001', true, true);
  return (
    <>
      {chat.messages.map((m) => (
        <MessageItem key={m.id} m={m} canRun onCancel={() => {}} onRetry={() => {}} />
      ))}
    </>
  );
}

function renderChat() {
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
        user: { id: 'u', role: 'editor' },
        permissions: permissionsFor('editor'),
        designSystem: { id: 'd', name: 'Starter', version: null, spec: starterDesignSystem() },
        agentAvailable: true,
      }}
    >
      <Chat />
    </EditorProvider>,
  );
}

describe('QuestionsCard', () => {
  it('renders single questions as a radiogroup and multi as checkboxes', () => {
    render(<QuestionsCard set={set} answers={null} canAnswer onSubmit={vi.fn()} />);
    const group = screen.getByRole('radiogroup', { name: /Who is it for/ });
    expect(group.querySelectorAll('input[type=radio]')).toHaveLength(3); // + Other
    expect(screen.getByRole('group', { name: /Which sections/ })).toBeTruthy();
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
    expect(screen.getByText('Two quick questions.')).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Small businesses/ })).toBeTruthy();
  });

  it('submits chosen options and Other text', async () => {
    const onSubmit = vi.fn(async () => {});
    render(<QuestionsCard set={set} answers={null} canAnswer onSubmit={onSubmit} />);
    const submit = screen.getByRole('button', { name: 'Submit' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.click(screen.getByRole('radio', { name: /Developers/ }));
    fireEvent.click(screen.getByRole('radio', { name: 'Other' }));
    // Picking Other on a single question replaces the option.
    expect((screen.getByRole('radio', { name: /Developers/ }) as HTMLInputElement).checked).toBe(
      false,
    );
    fireEvent.change(screen.getByRole('textbox', { name: /Other answer/ }), {
      target: { value: 'Designers' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'FAQ' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Comparison table' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'FAQ' }));
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith({
      answers: [
        { questionId: 'audience', optionIds: [], other: 'Designers' },
        { questionId: 'sections', optionIds: ['compare'] },
      ],
    });
  });

  it('skips with "Skip, just decide" and shows errors', async () => {
    const onSubmit = vi.fn(async () => {
      throw new Error('Those questions were already answered');
    });
    render(<QuestionsCard set={set} answers={null} canAnswer onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button', { name: 'Skip, just decide' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('already answered'),
    );
    expect(onSubmit).toHaveBeenCalledWith({ skip: true, answers: [] });
  });

  it('is read-only for members who cannot run the agent', () => {
    render(<QuestionsCard set={set} answers={null} canAnswer={false} onSubmit={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Submit' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Skip/ })).toBeNull();
    expect((screen.getByRole('radio', { name: /Developers/ }) as HTMLInputElement).disabled).toBe(
      true,
    );
    expect(screen.getByText(/Waiting for an editor/)).toBeTruthy();
  });

  it('collapses into a summary once answered', () => {
    const { rerender } = render(
      <QuestionsCard
        set={set}
        answers={{
          outcome: 'answered',
          answers: [{ questionId: 'sections', optionIds: ['faq', 'compare'] }],
        }}
        canAnswer
        onSubmit={vi.fn()}
      />,
    );
    const card = screen.getByTestId('questions-card');
    expect(card.dataset.state).toBe('answered');
    expect(screen.queryByRole('radio')).toBeNull();
    expect(card.textContent).toContain('FAQ, Comparison table');
    expect(card.textContent).toContain('No preference');
    rerender(
      <QuestionsCard
        set={set}
        answers={{ outcome: 'skipped', answers: [] }}
        canAnswer
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getByTestId('questions-card').textContent).toContain('the agent decides');
  });

  it('drafts leave out unanswered questions and Other where not allowed', () => {
    expect(
      draftAnswers(set, {
        audience: { optionIds: [], otherOn: true, other: '  ' },
        sections: { optionIds: ['faq'], otherOn: true, other: 'x' },
      }),
    ).toEqual([{ questionId: 'sections', optionIds: ['faq'] }]);
  });
});

describe('questions in the chat', () => {
  it('answers through the chat, follows the reply and the job it starts', async () => {
    FakeEventSource.all = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    const fetchMock = vi.fn(async (url: string) => {
      const body = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });
      if (url.startsWith('/api/agent/chat'))
        return body({
          conversationId: 'c1',
          messages: [
            view({ id: 'u1', role: 'user', seq: 1, text: 'Design a pricing page' }),
            view({ id: 'a1', seq: 2, text: 'A few questions first.', questions: set }),
          ],
        });
      if (url === '/api/agent/messages/a1/answer')
        return body({
          conversationId: 'c1',
          userMessageId: 'u3',
          messageId: 'a4',
          needsRun: true,
          streamUrl: '/api/agent/messages/a4/stream',
        });
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderChat();

    fireEvent.click(await screen.findByRole('checkbox', { name: 'FAQ' }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() =>
      expect(screen.getByTestId('questions-card').dataset.state).toBe('answered'),
    );
    const call = fetchMock.mock.calls.find((c) => c[0] === '/api/agent/messages/a1/answer')!;
    expect(JSON.parse((call as unknown as [string, RequestInit])[1].body as string)).toEqual({
      answers: [{ questionId: 'sections', optionIds: ['faq'] }],
    });
    // The answer message itself isn't shown as a bubble; the card summarizes it.
    expect(screen.queryByText(/Which sections\? FAQ/)).toBeNull();

    const reply = FakeEventSource.all.find((e) => e.url === '/api/agent/messages/a4/stream')!;
    act(() =>
      reply.emit(
        'message',
        view({ id: 'a4', seq: 4, text: 'Starting the page.', startedJobMessageId: 'a5' }),
      ),
    );
    expect(screen.getByText('Starting the page.')).toBeTruthy();
    expect(FakeEventSource.all.some((e) => e.url === '/api/agent/messages/a5/stream')).toBe(true);
  });
});
