'use client';

/**
 * Chat state for the agent pane: loads the project's conversation, sends prompts, follows each
 * reply's SSE stream, and pulls the doc store when the agent commits, so edits show up live.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useDocStoreApi } from '../doc-store';
import {
  agentApi,
  followMessage,
  type Attachment,
  type MessageView,
  type QuestionAnswer,
  type SendBody,
  type SendResult,
} from './api';

const ACTIVE = new Set(['pending', 'streaming']);

export interface AnswerBody {
  skip?: boolean;
  answers: QuestionAnswer[];
  model?: string;
}

/**
 * Mounted chats, so a questions card can answer through the chat that shows it (and the chat
 * follows the reply) without threading a callback through the pane.
 */
const mounted = new Set<{ has(messageId: string): boolean; answer: AgentChat['answer'] }>();

/** Answer the questions on `messageId` through the chat that holds it. */
export async function answerQuestions(messageId: string, body: AnswerBody): Promise<void> {
  for (const c of mounted) if (c.has(messageId)) return c.answer(messageId, body);
  await agentApi.answer(messageId, body);
}

export interface AgentChat {
  messages: MessageView[];
  conversationId: string | null;
  loading: boolean;
  error: string | null;
  busy: boolean;
  send(
    prompt: string,
    opts?: {
      attachments?: Attachment[];
      model?: string;
      /** Override the current canvas selection (retry resends the original context). */
      selection?: string[];
      frameId?: string | null;
    },
  ): Promise<void>;
  /** Answer (or skip) the follow-up questions an assistant message asked; the agent continues. */
  answer(messageId: string, body: AnswerBody): Promise<void>;
  cancel(messageId: string): Promise<void>;
  retry(assistantMessageId: string): Promise<void>;
  /** Replace one message (e.g. after a job starts). */
  upsert(view: MessageView): void;
  /** Add a message and follow its stream (job messages). */
  track(view: MessageView): void;
  dismissError(): void;
}

/**
 * `load`: fetch the conversation at all (skipped when no model is connected).
 * `enabled`: the user can run the agent (follow running replies, send).
 */
export function useAgentChat(projectId: string, load: boolean, enabled: boolean): AgentChat {
  const store = useDocStoreApi();
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [loading, setLoading] = useState(load);
  const [error, setError] = useState<string | null>(null);
  const followers = useRef(new Map<string, () => void>());
  /** Jobs a reply started on its own, already being followed. */
  const startedJobs = useRef(new Set<string>());
  const followRef = useRef<(messageId: string) => void>(() => {});

  const upsert = useCallback((view: MessageView) => {
    setMessages((prev) => {
      const i = prev.findIndex((m) => m.id === view.id);
      if (i < 0) return [...prev, view].sort((a, b) => a.seq - b.seq);
      const next = [...prev];
      next[i] = view;
      return next;
    });
  }, []);

  const follow = useCallback(
    (messageId: string) => {
      if (followers.current.has(messageId)) return;
      let seenTxns = 0;
      const f = followMessage(`/api/agent/messages/${messageId}/stream`, (view) => {
        upsert(view);
        // A reply to answered questions can start its generation job; show and follow it.
        const jobMessageId = view.startedJobMessageId;
        if (jobMessageId && !startedJobs.current.has(jobMessageId)) {
          startedJobs.current.add(jobMessageId);
          followRef.current(jobMessageId);
        }
        if (view.txnIds.length > seenTxns) {
          seenTxns = view.txnIds.length;
          void store
            .getState()
            .pull()
            .catch(() => {});
        }
      });
      followers.current.set(messageId, f.close);
      void f.done.then(() => {
        followers.current.delete(messageId);
        void store
          .getState()
          .pull()
          .catch(() => {});
      });
    },
    [store, upsert],
  );
  useEffect(() => {
    followRef.current = follow;
  }, [follow]);

  useEffect(() => {
    if (!load) return;
    let cancelled = false;
    agentApi
      .chat(projectId)
      .then((res) => {
        if (cancelled) return;
        setConversationId(res.conversationId);
        setMessages(res.messages);
        // Coming back to a running reply (closed tab, reload): keep following it.
        if (enabled) for (const m of res.messages) if (ACTIVE.has(m.status)) follow(m.id);
      })
      .catch(() => !cancelled && setError('Could not load the conversation.'))
      .finally(() => !cancelled && setLoading(false));
    const current = followers.current;
    return () => {
      cancelled = true;
      for (const close of current.values()) close();
      current.clear();
    };
  }, [projectId, load, enabled, follow]);

  const send = useCallback<AgentChat['send']>(
    async (prompt, opts = {}) => {
      setError(null);
      const { selection } = store.getState();
      const nodeIds = opts.selection ?? selection.nodeIds;
      const body: SendBody = {
        projectId,
        conversationId: conversationId ?? undefined,
        prompt,
        model: opts.model,
        selection: nodeIds.length ? nodeIds : undefined,
        frameId: opts.frameId !== undefined ? opts.frameId : selection.frameId,
        attachments: opts.attachments?.length ? opts.attachments : undefined,
      };
      try {
        const res = await agentApi.send(body);
        setConversationId(res.conversationId);
        const seqBase = messages.at(-1)?.seq ?? 0;
        const placeholder = placeholderFor(res);
        // Unanswered questions are superseded by the new message (the server records it).
        setMessages((prev) =>
          prev.map((m) =>
            m.questions && !m.answers
              ? { ...m, answers: { outcome: 'superseded', answers: [] } }
              : m,
          ),
        );
        upsert(
          placeholder({
            id: res.userMessageId,
            seq: seqBase + 1,
            text: prompt,
            attachments: opts.attachments ?? [],
          }),
        );
        upsert(
          placeholder({
            id: res.messageId,
            seq: seqBase + 2,
            role: 'assistant',
            status: res.needsRun ? 'pending' : 'complete',
          }),
        );
        follow(res.messageId);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not send the message.');
      }
    },
    [conversationId, follow, messages, projectId, store, upsert],
  );

  const answer = useCallback<AgentChat['answer']>(
    async (messageId, body) => {
      setError(null);
      // Errors propagate to the questions card, which shows them next to the form.
      const res = await agentApi.answer(messageId, body);
      const seqBase = messages.at(-1)?.seq ?? 0;
      const placeholder = placeholderFor(res);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId
            ? {
                ...m,
                answers: {
                  outcome: body.skip ? 'skipped' : 'answered',
                  answers: body.skip ? [] : body.answers,
                },
              }
            : m,
        ),
      );
      upsert(
        placeholder({
          id: res.userMessageId,
          seq: seqBase + 1,
          answersFor: messageId,
        }),
      );
      upsert(
        placeholder({ id: res.messageId, seq: seqBase + 2, role: 'assistant', status: 'pending' }),
      );
      follow(res.messageId);
    },
    [follow, messages, upsert],
  );

  // Register for answerQuestions() (the questions card).
  const messagesRef = useRef(messages);
  const answerRef = useRef(answer);
  useEffect(() => {
    messagesRef.current = messages;
    answerRef.current = answer;
  }, [messages, answer]);
  useEffect(() => {
    if (!enabled) return;
    const entry = {
      has: (id: string) => messagesRef.current.some((m) => m.id === id),
      answer: (id: string, body: AnswerBody) => answerRef.current(id, body),
    };
    mounted.add(entry);
    return () => {
      mounted.delete(entry);
    };
  }, [enabled]);

  const cancel = useCallback(
    async (messageId: string) => {
      try {
        upsert(await agentApi.cancel(messageId));
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not cancel.');
      }
    },
    [upsert],
  );

  const retry = useCallback(
    async (assistantMessageId: string) => {
      const i = messages.findIndex((m) => m.id === assistantMessageId);
      const user = messages
        .slice(0, i)
        .reverse()
        .find((m) => m.role === 'user');
      const failed = messages[i];
      if (user)
        await send(user.text, {
          attachments: user.attachments,
          model: failed?.model ?? undefined,
          selection: user.context?.selection ?? [],
          frameId: user.context?.frameId ?? null,
        });
    },
    [messages, send],
  );

  return {
    messages,
    conversationId,
    loading,
    error,
    // A background job doesn't block the composer: its card has its own progress and Cancel.
    busy: messages.some((m) => ACTIVE.has(m.status) && !m.jobId),
    send,
    answer,
    cancel,
    retry,
    upsert,
    track: (view: MessageView) => {
      upsert(view);
      setConversationId(view.conversationId);
      follow(view.id);
    },
    dismissError: () => setError(null),
  };
}

/** Optimistic message shown until the stream sends the real one. */
function placeholderFor(res: SendResult) {
  const now = new Date().toISOString();
  return (over: Partial<MessageView>): MessageView => ({
    id: '',
    conversationId: res.conversationId,
    seq: 0,
    role: 'user',
    status: 'complete',
    model: null,
    text: '',
    activity: [],
    touched: [],
    txnIds: [],
    jobSuggestion: null,
    jobId: null,
    snapshotVersionId: null,
    attachments: [],
    error: null,
    createdAt: now,
    ...over,
  });
}
