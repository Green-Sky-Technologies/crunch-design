'use client';

/**
 * "Revert agent change" (Story 5.12): restore the auto snapshot taken before this message's
 * edits. It is applied through the doc store as one 'restore' transaction, so it's undoable
 * like any other edit (Undo here, or Cmd+Z).
 */
import { replaceDocOps, type DesignDoc } from '@crunch/doc-model';
import { useState } from 'react';
import { useDocStoreApi } from '../doc-store';

export function RevertButton({ messageId }: { messageId: string }) {
  const store = useDocStoreApi();
  const [state, setState] = useState<'idle' | 'working' | 'reverted' | 'error'>('idle');
  const [depth, setDepth] = useState(0);

  const revert = async () => {
    if (
      !window.confirm(
        'Revert this agent change? Edits made after it are reverted too. You can undo this.',
      )
    )
      return;
    setState('working');
    try {
      const res = await fetch(`/api/agent/messages/${messageId}/snapshot`);
      if (!res.ok) throw new Error();
      const { doc } = (await res.json()) as { doc: DesignDoc };
      const s = store.getState();
      const ok = s.apply(replaceDocOps(s.doc, doc), {
        source: 'restore',
        label: 'Revert agent change',
      });
      if (!ok) throw new Error();
      setDepth(store.getState().undoStack.length);
      setState('reverted');
    } catch {
      setState('error');
    }
  };

  const undo = () => {
    // Only undo if the revert is still the latest step.
    if (store.getState().undoStack.length === depth) store.getState().undo();
    setState('idle');
  };

  if (state === 'reverted')
    return (
      <span className="text-xs text-muted">
        Reverted.{' '}
        <button type="button" className="underline" onClick={undo}>
          Undo
        </button>
      </span>
    );
  return (
    <button
      type="button"
      className="text-xs text-muted underline"
      disabled={state === 'working'}
      onClick={() => void revert()}
    >
      {state === 'error' ? 'Revert failed, retry' : 'Revert agent change'}
    </button>
  );
}
