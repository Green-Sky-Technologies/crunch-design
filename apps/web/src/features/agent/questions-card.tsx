'use client';

/**
 * Follow-up questions form (the agent's ask_questions tool). Multiple choice, single or multi
 * select, with an optional "Other" text answer. Submitting continues the conversation;
 * "Skip, just decide" lets the agent use its judgement. Once answered it collapses into a
 * read-only summary. Members who can't run the agent see it read-only.
 */
import { useId, useState } from 'react';
import type { QuestionAnswer, QuestionAnswers, QuestionSet } from './api';

type Question = QuestionSet['questions'][number];

interface Draft {
  optionIds: string[];
  otherOn: boolean;
  other: string;
}

const empty: Draft = { optionIds: [], otherOn: false, other: '' };

export interface QuestionsSubmit {
  skip?: boolean;
  answers: QuestionAnswer[];
}

/** Draft state → the API's answers (unanswered questions are left out). */
export function draftAnswers(set: QuestionSet, drafts: Record<string, Draft>): QuestionAnswer[] {
  const out: QuestionAnswer[] = [];
  for (const q of set.questions) {
    const d = drafts[q.id];
    if (!d) continue;
    const other = q.allowOther && d.otherOn ? d.other.trim() : '';
    if (!d.optionIds.length && !other) continue;
    out.push(
      other
        ? { questionId: q.id, optionIds: d.optionIds, other }
        : { questionId: q.id, optionIds: d.optionIds },
    );
  }
  return out;
}

const pill =
  'inline-flex cursor-pointer items-center gap-1 rounded-full border border-border bg-surface px-2.5 py-1 text-xs transition-colors select-none hover:bg-surface-2 ' +
  'has-checked:border-accent has-checked:bg-accent has-checked:text-accent-ink ' +
  'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--focus)]/50 ' +
  'has-disabled:cursor-not-allowed has-disabled:opacity-60';

function QuestionField({
  q,
  index,
  draft,
  disabled,
  onChange,
}: {
  q: Question;
  index: number;
  draft: Draft;
  disabled: boolean;
  onChange: (d: Draft) => void;
}) {
  const uid = useId();
  const labelId = `${uid}-label`;
  const name = `${uid}-q`;
  const single = q.kind === 'single';
  const type = single ? 'radio' : 'checkbox';

  const toggle = (optionId: string, checked: boolean) => {
    if (single) onChange({ ...draft, optionIds: checked ? [optionId] : [], otherOn: false });
    else
      onChange({
        ...draft,
        optionIds: checked
          ? [...draft.optionIds, optionId]
          : draft.optionIds.filter((o) => o !== optionId),
      });
  };

  return (
    <div className="space-y-1.5">
      <p id={labelId} className="text-xs font-medium text-text">
        <span className="text-muted">{index + 1}.</span> {q.prompt}
        {!single && <span className="ml-1 font-normal text-muted">(pick any)</span>}
      </p>
      <div
        role={single ? 'radiogroup' : 'group'}
        aria-labelledby={labelId}
        className="flex flex-wrap gap-1.5"
      >
        {q.options.map((o) => (
          <label key={o.id} className={pill} title={o.description}>
            <input
              type={type}
              name={name}
              value={o.id}
              className="sr-only"
              disabled={disabled}
              checked={draft.optionIds.includes(o.id)}
              onChange={(e) => toggle(o.id, e.target.checked)}
              aria-describedby={o.description ? `${uid}-${o.id}-desc` : undefined}
            />
            {o.label}
            {o.description && (
              <span id={`${uid}-${o.id}-desc`} className="sr-only">
                {o.description}
              </span>
            )}
          </label>
        ))}
        {q.allowOther && (
          <label className={pill}>
            <input
              type={type}
              name={name}
              value="__other"
              className="sr-only"
              disabled={disabled}
              checked={draft.otherOn}
              onChange={(e) =>
                onChange(
                  single
                    ? { ...draft, optionIds: [], otherOn: e.target.checked }
                    : { ...draft, otherOn: e.target.checked },
                )
              }
            />
            Other
          </label>
        )}
      </div>
      {q.allowOther && draft.otherOn && (
        <input
          className="input py-1 text-xs"
          aria-label={`Other answer: ${q.prompt}`}
          placeholder="Describe it…"
          maxLength={1000}
          disabled={disabled}
          autoFocus
          value={draft.other}
          onChange={(e) => onChange({ ...draft, other: e.target.value })}
        />
      )}
    </div>
  );
}

function Summary({ set, answers }: { set: QuestionSet; answers: QuestionAnswers }) {
  if (answers.outcome !== 'answered')
    return (
      <p className="text-muted">
        {answers.outcome === 'skipped'
          ? 'Skipped: the agent decides.'
          : 'Not answered: a new message was sent instead.'}
      </p>
    );
  const byId = new Map(answers.answers.map((a) => [a.questionId, a]));
  return (
    <dl className="space-y-1">
      {set.questions.map((q) => {
        const a = byId.get(q.id);
        const labels = q.options.filter((o) => a?.optionIds.includes(o.id)).map((o) => o.label);
        if (a?.other) labels.push(a.other);
        return (
          <div key={q.id}>
            <dt className="text-muted">{q.prompt}</dt>
            <dd className="font-medium">{labels.length ? labels.join(', ') : 'No preference'}</dd>
          </div>
        );
      })}
    </dl>
  );
}

export function QuestionsCard({
  set,
  answers,
  canAnswer,
  onSubmit,
}: {
  set: QuestionSet;
  answers: QuestionAnswers | null;
  /** Editors and admins (agent:run); others see the questions read-only. */
  canAnswer: boolean;
  onSubmit: (body: QuestionsSubmit) => Promise<void>;
}) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [sending, setSending] = useState<'submit' | 'skip' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();

  if (answers)
    return (
      <section
        className="card mt-2 bg-surface-2/40 p-3 text-xs"
        aria-labelledby={titleId}
        data-testid="questions-card"
        data-state={answers.outcome}
      >
        <p id={titleId} className="mb-1.5 font-medium">
          {answers.outcome === 'answered' ? 'Your answers' : 'Questions'}
        </p>
        <Summary set={set} answers={answers} />
      </section>
    );

  const readOnly = !canAnswer;
  const answered = draftAnswers(set, drafts);
  const submit = async (skip: boolean) => {
    setSending(skip ? 'skip' : 'submit');
    setError(null);
    try {
      await onSubmit(skip ? { skip: true, answers: [] } : { answers: answered });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send your answers.');
    } finally {
      setSending(null);
    }
  };

  return (
    <form
      className="card mt-2 space-y-3 p-3 text-xs"
      aria-labelledby={titleId}
      data-testid="questions-card"
      data-state="open"
      onSubmit={(e) => {
        e.preventDefault();
        if (answered.length && !sending) void submit(false);
      }}
    >
      <p id={titleId} className="font-medium">
        A few questions first
      </p>
      {set.intro && <p className="-mt-2 text-muted">{set.intro}</p>}
      {set.questions.map((q, i) => (
        <QuestionField
          key={q.id}
          q={q}
          index={i}
          draft={drafts[q.id] ?? empty}
          disabled={readOnly || sending !== null}
          onChange={(d) => setDrafts((prev) => ({ ...prev, [q.id]: d }))}
        />
      ))}
      {error && (
        <p className="text-danger" role="alert">
          {error}
        </p>
      )}
      {readOnly ? (
        <p className="text-muted">Waiting for an editor to answer.</p>
      ) : (
        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            className="btn-ghost px-2 py-1 text-xs"
            disabled={sending !== null}
            onClick={() => void submit(true)}
          >
            {sending === 'skip' ? 'Skipping…' : 'Skip, just decide'}
          </button>
          <button
            type="submit"
            className="btn-primary px-2 py-1 text-xs"
            disabled={sending !== null || answered.length === 0}
          >
            {sending === 'submit' ? 'Sending…' : 'Submit'}
          </button>
        </div>
      )}
    </form>
  );
}
