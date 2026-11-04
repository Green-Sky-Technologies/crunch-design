'use client';

/**
 * Chat state for the agent pane: loads the project's conversation, sends prompts, follows each
 * reply's SSE stream, and pulls the doc store when the agent commits, so edits show up live.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useDocStoreApi } from '../doc-store';
import { agentApi, followMessage, type Attachment, type MessageView, type SendBody } from './api';

const ACTIVE = new Set(['pending', 'streaming']);

export interface AgentChat {
  messages: MessageView[];
  conversationId: string | null;
  loading: boolean;
  error: string | null;
  busy: boolean;
  send(prompt: string, opts?: { attachments?: Attachment[]; model?: string }): Promise<void>;
  cancel(messageId: string): Promise<void>;
  retry(assistantMessageId: string): Promise<void>;
  /** Replace one message (e.g. after a job starts). */
  upsert(view: MessageView): void;
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
      const body: SendBody = {
        projectId,
        conversationId: conversationId ?? undefined,
        prompt,
        model: opts.model,
        selection: selection.nodeIds.length ? selection.nodeIds : undefined,
        frameId: selection.frameId,
        attachments: opts.attachments?.length ? opts.attachments : undefined,
      };
      try {
        const res = await agentApi.send(body);
        setConversationId(res.conversationId);
        const now = new Date().toISOString();
        const seqBase = messages.at(-1)?.seq ?? 0;
        const placeholder = (over: Partial<MessageView>): MessageView => ({
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
      if (user) await send(user.text, { attachments: user.attachments });
    },
    [messages, send],
  );

  return {
    messages,
    conversationId,
    loading,
    error,
    busy: messages.some((m) => ACTIVE.has(m.status)),
    send,
    cancel,
    retry,
    upsert,
    dismissError: () => setError(null),
  };
}
