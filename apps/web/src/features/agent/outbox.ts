'use client';

/**
 * Messages other parts of the editor hand to the agent chat ("Send to agent" from a canvas
 * comment). The agent pane drains the queue into the conversation that's already open, so a
 * comment and a typed message take the same path (the interactive Messages API turn), with the
 * element passed as the turn's selection context.
 */
import { create } from 'zustand';

export interface OutboxItem {
  id: string;
  text: string;
  frameId: string;
  nodeId: string;
  /** Human-readable reference to the element, e.g. `Heading “Start with Maya”`. */
  label: string;
}

interface OutboxState {
  queue: OutboxItem[];
  push(item: Omit<OutboxItem, 'id'>): void;
  take(): OutboxItem | undefined;
}

let seq = 0;

export const useAgentOutbox = create<OutboxState>()((set, get) => ({
  queue: [],
  push: (item) => set((s) => ({ queue: [...s.queue, { ...item, id: `ob${++seq}` }] })),
  take: () => {
    const [first, ...rest] = get().queue;
    if (first) set({ queue: rest });
    return first;
  },
}));

/** The chat text for an outbox item: the element reference, then the user's words. */
export function outboxPrompt(item: Pick<OutboxItem, 'label' | 'text'>): string {
  return `On ${item.label}:\n${item.text}`;
}
