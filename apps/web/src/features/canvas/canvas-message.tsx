'use client';

/** A short canvas message (why an action was refused). Dismisses itself after a few seconds. */
import { useEffect } from 'react';
import { useCanvas, useCanvasStoreApi } from './canvas-store';

export function CanvasMessage() {
  const message = useCanvas((s) => s.message);
  const canvas = useCanvasStoreApi();
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => canvas.getState().setMessage(null), 4000);
    return () => clearTimeout(t);
  }, [message, canvas]);
  if (!message) return null;
  return (
    <div
      role="status"
      className="card px-3 py-1.5 text-xs shadow-sm"
      style={{
        position: 'absolute',
        top: 12,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 30,
      }}
    >
      {message}
    </div>
  );
}
