'use client';

/**
 * Comment composer with @mention autocomplete. Typing "@" plus a few letters lists workspace
 * members; picking one inserts "@Name" and records the user id. On submit, only mentions whose
 * "@Name" is still in the text are sent (the server re-validates membership).
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { commentsApi, memberLabel, type Member } from './api';

let membersCache: Promise<Member[]> | null = null;
export function loadMembers(): Promise<Member[]> {
  membersCache ??= commentsApi
    .members()
    .then((r) => r.members)
    .catch(() => {
      membersCache = null;
      return [];
    });
  return membersCache;
}

export function useMembers(): Member[] {
  const [members, setMembers] = useState<Member[]>([]);
  useEffect(() => {
    let live = true;
    void loadMembers().then((m) => live && setMembers(m));
    return () => {
      live = false;
    };
  }, []);
  return members;
}

/** The "@query" being typed at the caret, if any. */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const m = /(^|\s)@([\w.-]{0,30})$/.exec(before);
  if (!m) return null;
  return { start: caret - m[2]!.length - 1, query: m[2]!.toLowerCase() };
}

/** Mentions still present in the text. */
export function activeMentions(text: string, picked: Map<string, string>): string[] {
  return [...picked].filter(([, label]) => text.includes(`@${label}`)).map(([id]) => id);
}

export function MentionInput({
  placeholder,
  submitLabel,
  onSubmit,
  disabled,
  autoFocus,
  extra,
}: {
  placeholder: string;
  submitLabel: string;
  onSubmit: (body: string, mentions: string[]) => Promise<boolean>;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Extra controls rendered next to the submit button. */
  extra?: ReactNode;
}) {
  const members = useMembers();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState<{ start: number; query: string } | null>(null);
  const [active, setActive] = useState(0);
  const picked = useRef(new Map<string, string>());
  const ref = useRef<HTMLTextAreaElement>(null);
  const listId = useId();

  const matches = query
    ? members.filter((m) => memberLabel(m).toLowerCase().includes(query.query)).slice(0, 6)
    : [];

  const pick = (m: Member) => {
    if (!query) return;
    const label = memberLabel(m).replace(/\s+/g, ' ');
    const caret = ref.current?.selectionStart ?? text.length;
    const next = `${text.slice(0, query.start)}@${label} ${text.slice(caret)}`;
    picked.current.set(m.userId, label);
    setText(next);
    setQuery(null);
    requestAnimationFrame(() => {
      const pos = query.start + label.length + 2;
      ref.current?.setSelectionRange(pos, pos);
      ref.current?.focus();
    });
  };

  const submit = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    const ok = await onSubmit(body, activeMentions(body, picked.current));
    setBusy(false);
    if (ok) {
      setText('');
      picked.current.clear();
    }
  };

  return (
    <div className="relative">
      <textarea
        ref={ref}
        className="input min-h-16 resize-y"
        placeholder={placeholder}
        value={text}
        disabled={disabled || busy}
        autoFocus={autoFocus}
        aria-autocomplete="list"
        aria-controls={matches.length ? listId : undefined}
        onChange={(e) => {
          setText(e.target.value);
          setQuery(mentionQuery(e.target.value, e.target.selectionStart));
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (matches.length) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              const d = e.key === 'ArrowDown' ? 1 : -1;
              setActive((a) => (a + d + matches.length) % matches.length);
              return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault();
              pick(matches[active] ?? matches[0]!);
              return;
            }
            if (e.key === 'Escape') {
              setQuery(null);
              return;
            }
          }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit();
          }
        }}
      />
      {matches.length > 0 && (
        <ul
          id={listId}
          role="listbox"
          className="card absolute left-0 right-0 z-10 mt-1 max-h-48 overflow-auto py-1 text-sm shadow-lg"
        >
          {matches.map((m, i) => (
            <li
              key={m.userId}
              role="option"
              aria-selected={i === active}
              className={`cursor-pointer px-3 py-1.5 ${i === active ? 'bg-surface-2' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(m);
              }}
            >
              {memberLabel(m)}
              {m.email && m.name ? <span className="ml-2 text-muted">{m.email}</span> : null}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2 flex items-center gap-2">
        {extra}
        <button
          className="btn-primary ml-auto px-3 py-1"
          disabled={disabled || busy || !text.trim()}
          onClick={() => void submit()}
        >
          {busy ? 'Sending…' : submitLabel}
        </button>
      </div>
    </div>
  );
}
