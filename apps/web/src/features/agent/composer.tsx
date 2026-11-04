'use client';

import { useRef, useState, type ReactNode } from 'react';
import { agentApi, attachmentFromLink, type Attachment } from './api';

function attachmentLabel(a: Attachment) {
  if (a.type === 'figma') return `Figma frame ${a.nodeId}`;
  if (a.type === 'image') return `Image ${new URL(a.url).pathname.split('/').pop()}`;
  return new URL(a.url).host;
}

export function Composer({
  projectId,
  disabled,
  onSend,
  modelPicker,
}: {
  projectId: string;
  disabled: boolean;
  onSend: (prompt: string, attachments: Attachment[]) => Promise<void> | void;
  modelPicker?: ReactNode;
}) {
  const [prompt, setPrompt] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [link, setLink] = useState('');
  const [showLink, setShowLink] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const submit = async () => {
    const p = prompt.trim();
    if (!p || disabled) return;
    setPrompt('');
    const a = attachments;
    setAttachments([]);
    await onSend(p, a);
  };

  const addLink = () => {
    const a = attachmentFromLink(link);
    if (!a) return setNote('Paste an https link, an image URL or a Figma frame link.');
    setAttachments((xs) => [...xs, a].slice(0, 10));
    setLink('');
    setShowLink(false);
    setNote(null);
  };

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setNote('Uploading…');
    try {
      const { url } = await agentApi.uploadImage(projectId, file);
      setAttachments((xs) => [...xs, { type: 'image' as const, url }].slice(0, 10));
      setNote(null);
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'Upload failed');
    }
  };

  return (
    <form
      className="border-t border-border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {attachments.length > 0 && (
        <ul className="mb-2 flex flex-wrap gap-1">
          {attachments.map((a, i) => (
            <li
              key={i}
              className="flex items-center gap-1 rounded bg-surface-2 px-2 py-0.5 text-xs"
            >
              {attachmentLabel(a)}
              <button
                type="button"
                aria-label="Remove attachment"
                className="text-muted"
                onClick={() => setAttachments((xs) => xs.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <textarea
        className="input min-h-[72px] resize-none"
        placeholder="Ask the agent to change something…"
        value={prompt}
        aria-label="Message the agent"
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void submit();
          }
        }}
      />
      {showLink && (
        <div className="mt-2 flex gap-1">
          <input
            className="input py-1 text-xs"
            placeholder="https://… or a Figma frame link"
            value={link}
            onChange={(e) => setLink(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addLink();
              }
            }}
          />
          <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={addLink}>
            Add
          </button>
        </div>
      )}
      {note && <p className="mt-1 text-xs text-muted">{note}</p>}
      {/* Fits the 320px pane: buttons keep their size, the model picker shrinks and truncates. */}
      <div className="mt-2 flex min-w-0 items-center gap-1.5">
        <button
          type="button"
          className="btn-ghost shrink-0 px-2 py-1 text-xs"
          onClick={() => setShowLink((s) => !s)}
        >
          Link
        </button>
        <button
          type="button"
          className="btn-ghost shrink-0 px-2 py-1 text-xs"
          onClick={() => fileRef.current?.click()}
        >
          Image
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          className="hidden"
          onChange={(e) => {
            void upload(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
        <div className="flex min-w-0 flex-1 items-center justify-end gap-1.5">
          <div className="min-w-0 flex-1">{modelPicker}</div>
          <button
            type="submit"
            className="btn-primary shrink-0 px-3 py-1 text-xs"
            disabled={disabled || !prompt.trim()}
          >
            Send
          </button>
        </div>
      </div>
    </form>
  );
}
