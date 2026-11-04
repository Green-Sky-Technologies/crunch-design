/**
 * Interactive agent (Stories 5.4, 5.6): conversations, messages, running a turn, and the
 * per-message SSE stream.
 *
 * A turn runs after the POST responds (route handlers use `after()`), and writes its progress to
 * agent_messages as it streams. The SSE endpoint polls that row, so a reconnect, a second tab or
 * another function instance all see the same state, and closing the tab doesn't stop the run.
 * Cancel flips the row's status; the running turn notices and aborts its model call.
 */
import { assertCan } from '@crunch/authz';
import {
  AnswerError,
  answerQuestionsInput,
  answersSummary,
  buildPrefix,
  buildTurnContext,
  detectJobRequest,
  encodeSse,
  formatAnswersForModel,
  ModelNotAllowedError,
  prefixCacheTtl,
  resolveModel,
  runAgentTurn,
  SSE_KEEPALIVE,
  validateAnswers,
  type Anthropic,
  type JobSuggestion,
  type PendingQuestions,
  type QuestionAnswers,
  type QuestionSet,
  type ToolActivity,
  type TurnUpdate,
} from '@crunch/agent';
import {
  agentConversations,
  agentMessages,
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  sql,
  type AgentMessageRow,
  type Db,
} from '@crunch/db';
import { z } from 'zod';
import { getDoc, LockedError } from './design-docs';
import { resolveProjectDesignSystem } from './project-design-system';
import { getProject } from './projects';
import { getModelSettings } from './agent/model-settings';
import { snapshotBeforeAgentEdit } from './agent/snapshots';
import { settleStaleMessages } from './agent/stale';
import { createDbToolHost } from './agent/tool-host';
import { ProviderError, streamModel, type LlmProxyDeps } from './llm-proxy';
import { NotFoundError, ValidationError, type Actor } from './types';

// ---------------------------------------------------------------------------------------------
// Stored shapes (agent_messages.content)
// ---------------------------------------------------------------------------------------------

export interface TurnContextRef {
  selection?: string[];
  frameId?: string | null;
  scopeNodeId?: string;
}

/** User message: what they typed, and the exact API turn sent (context + prompt). */
export interface StoredUserContent {
  v: 1;
  prompt: string;
  context: TurnContextRef;
  turns: Anthropic.MessageParam[];
  /** Set when this message answers the questions asked by that assistant message. */
  answersFor?: string;
}

/** Assistant message: API turns (text, tool use, tool results), plus UI state while streaming. */
export interface StoredAssistantContent {
  v: 1;
  turns: Anthropic.MessageParam[];
  partial?: Anthropic.ContentBlockParam[] | null;
  activity?: ToolActivity[];
  touched?: string[];
  jobSuggestion?: JobSuggestion | null;
  stopReason?: string | null;
  /** The turn ended on ask_questions; the tool_result is pending until `answers` is set. */
  questions?: PendingQuestions | null;
  answers?: QuestionAnswers | null;
  /** The job this reply started on its own (a new design after answered questions). */
  startedJob?: { jobId: string; messageId: string } | null;
}

export type Attachment =
  | { type: 'image'; url: string }
  | { type: 'url'; url: string }
  | { type: 'figma'; fileKey: string; nodeId: string };

export const attachmentSchema: z.ZodType<Attachment> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('image'), url: z.url({ protocol: /^https$/ }).max(2048) }).strict(),
  z.object({ type: z.literal('url'), url: z.url({ protocol: /^https?$/ }).max(2048) }).strict(),
  z
    .object({ type: z.literal('figma'), fileKey: z.string().max(64), nodeId: z.string().max(64) })
    .strict(),
]);

export interface MessageView {
  id: string;
  conversationId: string;
  seq: number;
  role: 'user' | 'assistant' | 'system';
  status: AgentMessageRow['status'];
  model: string | null;
  /** User prompt, or the assistant's text so far. */
  text: string;
  activity: ToolActivity[];
  touched: string[];
  txnIds: string[];
  jobSuggestion: JobSuggestion | null;
  /** Follow-up questions this reply asked, and what the user did with them. */
  questions: QuestionSet | null;
  answers: QuestionAnswers | null;
  /** User messages: the assistant message whose questions this message answers. */
  answersFor: string | null;
  /** The job message this reply started automatically (the client follows it). */
  startedJobMessageId: string | null;
  /** User messages: the selection/frame the prompt was sent with (retry reuses it). */
  context: TurnContextRef | null;
  jobId: string | null;
  snapshotVersionId: string | null;
  attachments: Attachment[];
  error: string | null;
  createdAt: string;
}

const TERMINAL = new Set<AgentMessageRow['status']>(['complete', 'error', 'cancelled']);

function blocksText(blocks: (string | Anthropic.ContentBlockParam)[]): string[] {
  return blocks.map((b) => (typeof b === 'string' ? b : b.type === 'text' ? b.text : ''));
}

export function toMessageView(row: AgentMessageRow): MessageView {
  const base = {
    id: row.id,
    conversationId: row.conversationId,
    seq: row.seq,
    role: row.role,
    status: row.status,
    model: row.model,
    txnIds: row.txnIds,
    jobId: row.jobId,
    snapshotVersionId: row.snapshotVersionId,
    attachments: (row.attachments ?? []) as Attachment[],
    error: row.error,
    createdAt: row.createdAt.toISOString(),
  };
  if (row.role === 'user') {
    const c = row.content as StoredUserContent;
    return {
      ...base,
      text: c.prompt ?? '',
      activity: [],
      touched: [],
      jobSuggestion: null,
      questions: null,
      answers: null,
      answersFor: c.answersFor ?? null,
      startedJobMessageId: null,
      context: c.context ?? null,
    };
  }
  const c = (row.content ?? { v: 1, turns: [] }) as StoredAssistantContent;
  const texts = (c.turns ?? [])
    .filter((t) => t.role === 'assistant')
    .flatMap((t) => blocksText(typeof t.content === 'string' ? [t.content] : t.content));
  if (c.partial) texts.push(...blocksText(c.partial));
  return {
    ...base,
    text: texts.filter(Boolean).join('\n\n'),
    activity: c.activity ?? [],
    touched: c.touched ?? [],
    jobSuggestion: c.startedJob ? null : (c.jobSuggestion ?? null),
    questions: c.questions?.set ?? null,
    answers: c.answers ?? null,
    answersFor: null,
    startedJobMessageId: c.startedJob?.messageId ?? null,
    context: null,
  };
}

// ---------------------------------------------------------------------------------------------
// Conversations and messages
// ---------------------------------------------------------------------------------------------

async function loadConversation(db: Db, actor: Actor, conversationId: string) {
  if (!z.uuid().safeParse(conversationId).success)
    throw new NotFoundError('Conversation not found');
  const [conv] = await db
    .select()
    .from(agentConversations)
    .where(
      and(
        eq(agentConversations.id, conversationId),
        eq(agentConversations.workspaceId, actor.workspace.id),
      ),
    )
    .limit(1);
  if (!conv) throw new NotFoundError('Conversation not found');
  return conv;
}

export async function loadMessage(db: Db, actor: Actor, messageId: string) {
  if (!z.uuid().safeParse(messageId).success) throw new NotFoundError('Message not found');
  const [row] = await db
    .select()
    .from(agentMessages)
    .where(and(eq(agentMessages.id, messageId), eq(agentMessages.workspaceId, actor.workspace.id)))
    .limit(1);
  if (!row) throw new NotFoundError('Message not found');
  return row;
}

/** The project's main chat (unscoped), with its messages. */
/** Interactive turns stop themselves after this (the messages route allows 300s). */
export const TURN_DEADLINE_MS = 270_000;
const TIMEOUT_ERROR = 'The reply took too long and was stopped.';
export { settleStaleMessages, STALE_TURN_MS } from './agent/stale';

export async function getProjectChat(
  db: Db,
  actor: Actor,
  projectId: string,
): Promise<{ conversationId: string | null; messages: MessageView[] }> {
  assertCan(actor.role, 'project:read');
  await getProject(db, actor, projectId);
  const [conv] = await db
    .select()
    .from(agentConversations)
    .where(
      and(
        eq(agentConversations.projectId, projectId),
        eq(agentConversations.workspaceId, actor.workspace.id),
        isNull(agentConversations.commentThreadId),
        sql`${agentConversations.scope} is null`,
      ),
    )
    .orderBy(desc(agentConversations.updatedAt))
    .limit(1);
  if (!conv) return { conversationId: null, messages: [] };
  await settleStaleMessages(db, { conversationId: conv.id });
  return { conversationId: conv.id, messages: await listMessages(db, actor, conv.id) };
}

export async function listMessages(
  db: Db,
  actor: Actor,
  conversationId: string,
): Promise<MessageView[]> {
  assertCan(actor.role, 'project:read');
  await loadConversation(db, actor, conversationId);
  const rows = await db
    .select()
    .from(agentMessages)
    .where(eq(agentMessages.conversationId, conversationId))
    .orderBy(asc(agentMessages.seq));
  return rows.map(toMessageView);
}

export const sendMessageInput = z
  .object({
    projectId: z.uuid(),
    conversationId: z.uuid().optional(),
    prompt: z.string().trim().min(1).max(8000),
    model: z.string().max(100).optional(),
    selection: z.array(z.string().max(64)).max(50).optional(),
    frameId: z.string().max(64).nullish(),
    attachments: z.array(attachmentSchema).max(10).optional(),
  })
  .strict();
export type SendMessageInput = z.infer<typeof sendMessageInput>;

export interface SentMessage {
  conversationId: string;
  userMessageId: string;
  messageId: string;
  /** False when the reply was produced without a model call (job offer). */
  needsRun: boolean;
}

/**
 * The persisted user turn: attachments + prompt, never the document. The current document
 * context is attached only to the newest user message when the turn runs (SPEC §2.3), so
 * history doesn't replay a full <document> per past turn.
 */
function userTurnFor(prompt: string, attachments: Attachment[]): Anthropic.MessageParam {
  const content: Anthropic.ContentBlockParam[] = [];
  for (const a of attachments) {
    if (a.type === 'image') content.push({ type: 'image', source: { type: 'url', url: a.url } });
    else if (a.type === 'url')
      content.push({ type: 'text', text: `Attached web page (reference): ${a.url}` });
    else
      content.push({
        type: 'text',
        text: `Attached Figma frame: file ${a.fileKey}, node ${a.nodeId}`,
      });
  }
  content.push({ type: 'text', text: prompt });
  return { role: 'user', content };
}

/**
 * Append a user message and a pending assistant reply. The caller runs the reply with
 * `runAssistantMessage` (after the response) unless `needsRun` is false.
 */
export async function sendMessage(
  db: Db,
  actor: Actor,
  raw: unknown,
  opts: {
    scope?: TurnContextRef & { scopeNodeId: string; frameId: string; allowWider: boolean };
    commentThreadId?: string;
  } = {},
): Promise<SentMessage> {
  assertCan(actor.role, 'agent:run');
  const parsed = sendMessageInput.safeParse(raw);
  if (!parsed.success)
    throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid message');
  const input = parsed.data;
  await getProject(db, actor, input.projectId);

  let model: string;
  try {
    model = resolveModel(
      await getModelSettings(db, actor.workspace.id),
      'interactive',
      input.model,
    );
  } catch (e) {
    if (e instanceof ModelNotAllowedError) throw new ValidationError(e.message);
    throw e;
  }

  const contextRef: TurnContextRef = opts.scope
    ? { scopeNodeId: opts.scope.scopeNodeId, frameId: opts.scope.frameId }
    : { selection: input.selection, frameId: input.frameId ?? null };
  const attachments = input.attachments ?? [];
  const userTurn = userTurnFor(input.prompt, attachments);

  return db.transaction(async (tx) => {
    let conversationId = input.conversationId;
    if (conversationId) {
      const [conv] = await tx
        .select()
        .from(agentConversations)
        .where(
          and(
            eq(agentConversations.id, conversationId),
            eq(agentConversations.workspaceId, actor.workspace.id),
            eq(agentConversations.projectId, input.projectId),
          ),
        )
        .for('update')
        .limit(1);
      if (!conv) throw new NotFoundError('Conversation not found');
    } else {
      const [conv] = await tx
        .insert(agentConversations)
        .values({
          workspaceId: actor.workspace.id,
          projectId: input.projectId,
          title: input.prompt.slice(0, 80),
          scope: opts.scope
            ? {
                nodeId: opts.scope.scopeNodeId,
                frameId: opts.scope.frameId,
                allowWider: opts.scope.allowWider,
              }
            : null,
          commentThreadId: opts.commentThreadId ?? null,
          createdBy: actor.userId,
        })
        .returning();
      conversationId = conv!.id;
    }
    const [{ max }] = (await tx
      .select({ max: sql<number>`coalesce(max(${agentMessages.seq}), 0)::int` })
      .from(agentMessages)
      .where(eq(agentMessages.conversationId, conversationId))) as [{ max: number }];

    // Questions left unanswered get their tool_result now, so the history stays valid.
    const superseded = await supersedePendingQuestions(tx, conversationId, actor);
    const userContent: StoredUserContent = {
      v: 1,
      prompt: input.prompt,
      context: contextRef,
      turns: [
        superseded
          ? {
              role: 'user',
              content: [...superseded, ...(userTurn.content as Anthropic.ContentBlockParam[])],
            }
          : userTurn,
      ],
    };
    const [user] = await tx
      .insert(agentMessages)
      .values({
        conversationId,
        workspaceId: actor.workspace.id,
        seq: max + 1,
        role: 'user',
        content: userContent,
        attachments,
        status: 'complete',
        createdBy: actor.userId,
      })
      .returning();

    // New designs always go to the model first: it asks follow-up questions before a job.
    const assistant = await insertPendingReply(tx, actor, conversationId, max + 2, model);
    return {
      conversationId,
      userMessageId: user!.id,
      messageId: assistant.id,
      needsRun: true,
    };
  });
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

async function insertPendingReply(
  tx: Tx,
  actor: Actor,
  conversationId: string,
  seq: number,
  model: string,
) {
  const content: StoredAssistantContent = { v: 1, turns: [] };
  const [assistant] = await tx
    .insert(agentMessages)
    .values({
      conversationId,
      workspaceId: actor.workspace.id,
      seq,
      role: 'assistant',
      content,
      status: 'pending',
      model,
      createdBy: actor.userId,
    })
    .returning();
  await tx
    .update(agentConversations)
    .set({ updatedAt: new Date() })
    .where(eq(agentConversations.id, conversationId));
  return assistant!;
}

/** Tool results that answer a question set (plus the sibling results held with it). */
function questionResults(
  q: PendingQuestions,
  answers: QuestionAnswers,
): Anthropic.ToolResultBlockParam[] {
  return [
    ...q.results,
    {
      type: 'tool_result',
      tool_use_id: q.toolUseId,
      content: formatAnswersForModel(q.set, answers),
    },
  ];
}

/**
 * Mark the conversation's unanswered question set (if any) as superseded by a new message and
 * return the tool results the new user turn must start with.
 */
async function supersedePendingQuestions(
  tx: Tx,
  conversationId: string,
  actor: Actor,
): Promise<Anthropic.ToolResultBlockParam[] | null> {
  const [row] = await tx
    .select()
    .from(agentMessages)
    .where(
      and(
        eq(agentMessages.conversationId, conversationId),
        eq(agentMessages.role, 'assistant'),
        eq(agentMessages.status, 'complete'),
        sql`jsonb_typeof(${agentMessages.content}->'questions') = 'object'`,
        sql`coalesce(jsonb_typeof(${agentMessages.content}->'answers'), 'null') = 'null'`,
      ),
    )
    .orderBy(desc(agentMessages.seq))
    .limit(1)
    .for('update');
  if (!row) return null;
  const content = row.content as StoredAssistantContent;
  const answers: QuestionAnswers = {
    outcome: 'superseded',
    answers: [],
    answeredBy: actor.userId,
    answeredAt: new Date().toISOString(),
  };
  await tx
    .update(agentMessages)
    .set({ content: { ...content, answers } satisfies StoredAssistantContent })
    .where(eq(agentMessages.id, row.id));
  return questionResults(content.questions!, answers);
}

/**
 * Answer (or skip) the follow-up questions an assistant message asked. Appends the answers as a
 * user message whose API turn is the pending tool_result, and a pending reply that continues
 * the conversation; the caller runs it with `runAssistantMessage`.
 */
export async function answerQuestions(
  db: Db,
  actor: Actor,
  messageId: string,
  raw: unknown,
): Promise<SentMessage> {
  assertCan(actor.role, 'agent:run');
  const parsed = answerQuestionsInput.safeParse(raw);
  if (!parsed.success)
    throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid answers');
  const input = parsed.data;
  const asked = await loadMessage(db, actor, messageId);
  const conv = await loadConversation(db, actor, asked.conversationId);
  await getProject(db, actor, conv.projectId);
  // Continue on the model that asked, unless one is picked (or it's no longer allowed).
  const settings = await getModelSettings(db, actor.workspace.id);
  let model: string;
  try {
    model = resolveModel(settings, 'interactive', input.model ?? asked.model ?? undefined);
  } catch (e) {
    if (!(e instanceof ModelNotAllowedError)) throw e;
    if (input.model) throw new ValidationError(e.message);
    model = resolveModel(settings, 'interactive');
  }

  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(agentMessages)
      .where(
        and(eq(agentMessages.id, messageId), eq(agentMessages.workspaceId, actor.workspace.id)),
      )
      .for('update')
      .limit(1);
    const content = row?.content as StoredAssistantContent | undefined;
    if (!row || row.role !== 'assistant' || !content?.questions)
      throw new NotFoundError('Those questions were not found');
    if (row.status !== 'complete' || content.answers)
      throw new ValidationError('Those questions were already answered');
    const q = content.questions;
    let normalized: QuestionAnswers['answers'] = [];
    if (!input.skip) {
      try {
        normalized = validateAnswers(q.set, input.answers);
      } catch (e) {
        if (e instanceof AnswerError) throw new ValidationError(e.message);
        throw e;
      }
      if (!normalized.length) throw new ValidationError('Answer a question, or skip');
    }
    const answers: QuestionAnswers = {
      outcome: input.skip ? 'skipped' : 'answered',
      answers: normalized,
      answeredBy: actor.userId,
      answeredAt: new Date().toISOString(),
    };
    await tx
      .update(agentMessages)
      .set({ content: { ...content, answers } satisfies StoredAssistantContent })
      .where(eq(agentMessages.id, row.id));

    const [{ max }] = (await tx
      .select({ max: sql<number>`coalesce(max(${agentMessages.seq}), 0)::int` })
      .from(agentMessages)
      .where(eq(agentMessages.conversationId, conv.id))) as [{ max: number }];
    // The answers apply to the same selection/frame as the request that prompted them.
    const [asking] = await tx
      .select()
      .from(agentMessages)
      .where(
        and(
          eq(agentMessages.conversationId, conv.id),
          eq(agentMessages.role, 'user'),
          sql`${agentMessages.seq} < ${row.seq}`,
        ),
      )
      .orderBy(desc(agentMessages.seq))
      .limit(1);
    const userContent: StoredUserContent = {
      v: 1,
      prompt: answersSummary(q.set, answers),
      context: (asking?.content as StoredUserContent | undefined)?.context ?? {},
      turns: [{ role: 'user', content: questionResults(q, answers) }],
      answersFor: row.id,
    };
    const [user] = await tx
      .insert(agentMessages)
      .values({
        conversationId: conv.id,
        workspaceId: actor.workspace.id,
        seq: max + 1,
        role: 'user',
        content: userContent,
        status: 'complete',
        createdBy: actor.userId,
      })
      .returning();
    const assistant = await insertPendingReply(tx, actor, conv.id, max + 2, model);
    return {
      conversationId: conv.id,
      userMessageId: user!.id,
      messageId: assistant.id,
      needsRun: true,
    };
  });
}

/** Earlier complete turns of a conversation, for the model. Failed and cancelled replies are skipped. */
/** Upper bound on replayed history (JSON characters, ~4 chars/token). */
export const MAX_HISTORY_CHARS = 200_000;

const isDocBlock = (b: unknown) =>
  typeof b === 'object' &&
  b !== null &&
  (b as { type?: string }).type === 'text' &&
  ((b as { text?: string }).text ?? '').startsWith('<document>');

/** Older rows stored the document inside the user turn; history never replays it. */
function withoutDocument(turn: Anthropic.MessageParam): Anthropic.MessageParam {
  if (typeof turn.content === 'string') return turn;
  return { ...turn, content: turn.content.filter((b) => !isDocBlock(b)) } as Anthropic.MessageParam;
}

/**
 * Keep the most recent exchanges within MAX_HISTORY_CHARS. The cut only moves when the window
 * overflows, and then jumps to half the budget, so between jumps the history prefix stays the
 * same from request to request (prompt-cache friendly).
 */
export function windowHistory(
  exchanges: Anthropic.MessageParam[][],
  maxChars = MAX_HISTORY_CHARS,
): Anthropic.MessageParam[] {
  const sizes = exchanges.map((e) => JSON.stringify(e).length);
  // Replays how the window evolves turn by turn, so the result for N exchanges only differs
  // from N-1 at the moment of an overflow.
  let cut = 0;
  let acc = 0;
  for (let i = 0; i < sizes.length; i++) {
    acc += sizes[i]!;
    if (acc > maxChars) while (acc > maxChars / 2 && cut < i) acc -= sizes[cut++]!;
  }
  return exchanges.slice(cut).flat();
}

/** The ask_questions call a user turn answers: the id of its last leading tool_result. */
function answeredToolUseId(turn: Anthropic.MessageParam | undefined): string | null {
  if (!turn || typeof turn.content === 'string') return null;
  let id: string | null = null;
  for (const b of turn.content) {
    if (b.type !== 'tool_result') break;
    id = b.tool_use_id;
  }
  return id;
}

/** Earlier complete turns of a conversation, for the model. Failed and cancelled replies are skipped. */
async function historyBefore(
  db: Db,
  conversationId: string,
  seq: number,
  /** The current turn answers this ask_questions call; it must directly follow it. */
  answering: string | null = null,
) {
  const rows = await db
    .select()
    .from(agentMessages)
    .where(
      and(eq(agentMessages.conversationId, conversationId), sql`${agentMessages.seq} < ${seq}`),
    )
    .orderBy(asc(agentMessages.seq));
  // One exchange = a user message and its (complete) reply; cuts happen between exchanges.
  // Answers to follow-up questions stay in the asking exchange, right after the tool_use, so
  // a cut never separates a tool_result from its call.
  const exchanges: Anthropic.MessageParam[][] = [];
  // Keyed by the ask_questions tool_use id.
  const askedAt = new Map<string, { exchange: number; at: number }>();
  for (const r of rows) {
    if (r.role === 'user') {
      const turns = (r.content as StoredUserContent).turns.map(withoutDocument);
      const pos = askedAt.get(answeredToolUseId(turns[0]) ?? '');
      if (pos) {
        exchanges[pos.exchange]!.splice(pos.at, 0, ...turns);
        askedAt.clear();
        continue;
      }
      exchanges.push(turns);
    } else if (r.role === 'assistant' && r.status === 'complete' && exchanges.length) {
      const c = r.content as StoredAssistantContent;
      exchanges.at(-1)!.push(...(c.turns ?? []));
      if (c.questions)
        askedAt.set(c.questions.toolUseId, {
          exchange: exchanges.length - 1,
          at: exchanges.at(-1)!.length,
        });
    }
  }
  const pos = answering ? askedAt.get(answering) : undefined;
  // Anything after the call (a job's summary) would separate the tool_result from it.
  if (pos) exchanges[pos.exchange]!.length = pos.at;
  return windowHistory(exchanges);
}

export interface RunDeps {
  proxy?: LlmProxyDeps;
  /** Min interval between progress writes (ms). */
  flushMs?: number;
  /** How often to check for cancellation while the model is thinking (ms). */
  cancelPollMs?: number;
  /** Hard limit for the turn, below the route's maxDuration (300s). */
  deadlineMs?: number;
  /** Runs before the message's first transaction. Defaults to the auto snapshot (Story 5.12). */
  beforeFirstCommit?: (messageId: string) => Promise<void>;
  /**
   * Start a generation job. When a reply to answered follow-up questions suggests a job, it
   * starts right away (the user already said what they want). Without it the job is offered.
   */
  startJob?: (
    s: JobSuggestion,
    ctx: { projectId: string; conversationId: string },
  ) => Promise<{ jobId: string; messageId: string }>;
}

function userFacingError(e: unknown): string {
  if (e instanceof ProviderError) return e.message;
  if (e instanceof LockedError) return 'Another member is editing this project.';
  if (e instanceof ValidationError || e instanceof NotFoundError) return e.message;
  if (e instanceof Error && e.name === 'AgentTurnError') return e.message;
  return 'Something went wrong running the agent.';
}

/** Run a pending assistant message to completion (or error/cancel). Never throws. */
export async function runAssistantMessage(
  db: Db,
  actor: Actor,
  messageId: string,
  deps: RunDeps = {},
): Promise<MessageView> {
  const flushMs = deps.flushMs ?? 250;
  const controller = new AbortController();
  let row = await loadMessage(db, actor, messageId);
  const claimed = await db
    .update(agentMessages)
    .set({ status: 'streaming' })
    .where(and(eq(agentMessages.id, messageId), eq(agentMessages.status, 'pending')))
    .returning({ id: agentMessages.id });
  if (!claimed.length) return toMessageView(row); // already running, finished or cancelled

  let latest: TurnUpdate | null = null;
  let lastUpdate: TurnUpdate | null = null;
  let writing: Promise<void> = Promise.resolve();
  let lastFlush = 0;
  const checkCancelled = async () => {
    const [r] = await db
      .select({ status: agentMessages.status })
      .from(agentMessages)
      .where(eq(agentMessages.id, messageId));
    if (r?.status === 'cancelled') controller.abort();
  };
  const flush = () => {
    const u = latest;
    if (!u) return writing;
    latest = null;
    lastFlush = Date.now();
    writing = writing.then(async () => {
      const content: StoredAssistantContent = {
        v: 1,
        turns: u.turns,
        partial: u.partial,
        activity: u.activity,
      };
      await db
        .update(agentMessages)
        .set({ content })
        .where(and(eq(agentMessages.id, messageId), eq(agentMessages.status, 'streaming')));
      await checkCancelled();
    });
    return writing;
  };
  const poll = setInterval(() => void checkCancelled().catch(() => {}), deps.cancelPollMs ?? 1000);
  // Settle the message ourselves before the platform kills the function at maxDuration.
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, deps.deadlineMs ?? TURN_DEADLINE_MS);

  let final: {
    status: 'complete' | 'error' | 'cancelled';
    content: StoredAssistantContent;
    error: string | null;
  };
  try {
    const conv = await loadConversation(db, actor, row.conversationId);
    const project = await getProject(db, actor, conv.projectId);
    const ds = await resolveProjectDesignSystem(db, actor, project);
    const [userRow] = await db
      .select()
      .from(agentMessages)
      .where(and(eq(agentMessages.conversationId, conv.id), eq(agentMessages.seq, row.seq - 1)));
    if (!userRow || userRow.role !== 'user') throw new ValidationError('Missing user message');
    const stored = userRow.content as StoredUserContent;
    const { doc } = await getDoc(db, actor, conv.projectId);
    const base = withoutDocument(stored.turns[0]!);
    const blocks: Anthropic.ContentBlockParam[] =
      typeof base.content === 'string' ? [{ type: 'text', text: base.content }] : base.content;
    const scope = conv.scope as { nodeId: string; allowWider?: boolean } | null;
    // A request that clearly needs a new design: remind the model to ask first (not stored).
    const hint =
      !scope && !stored.answersFor && detectJobRequest(stored.prompt)
        ? [
            {
              type: 'text' as const,
              text: 'This request needs a new design. Ask your follow-up questions with ask_questions before anything else.',
            },
          ]
        : [];
    // Tool results (answers to questions) must lead the user message.
    const userTurn: Anthropic.MessageParam = {
      role: 'user',
      content: [
        ...blocks.filter((b) => b.type === 'tool_result'),
        { type: 'text', text: buildTurnContext(doc, stored.context ?? {}) },
        ...hint,
        ...blocks.filter((b) => b.type !== 'tool_result'),
      ],
    };
    const host = await createDbToolHost(db, actor, {
      projectId: conv.projectId,
      agentMessageId: messageId,
      runtime: 'interactive',
      maxOpsPerPatch: 200,
      scope: scope
        ? { rootNodeId: scope.nodeId, allowWider: Boolean(scope.allowWider) }
        : undefined,
      beforeFirstCommit: () =>
        deps.beforeFirstCommit
          ? deps.beforeFirstCommit(messageId)
          : snapshotBeforeAgentEdit(db, actor, conv.projectId, messageId).then(() => undefined),
    });
    const history = await historyBefore(db, conv.id, userRow.seq, answeredToolUseId(base));
    const ctx = {
      workspaceId: actor.workspace.id,
      userId: actor.userId,
      projectId: conv.projectId,
      conversationId: conv.id,
      messageId,
      task: 'interactive' as const,
    };
    const result = await runAgentTurn({
      gateway: (params, o) => streamModel(db, ctx, params, o, deps.proxy),
      model:
        row.model ?? resolveModel(await getModelSettings(db, actor.workspace.id), 'interactive'),
      prefix: buildPrefix('interactive', ds.spec, prefixCacheTtl()),
      history,
      userTurn,
      host,
      signal: controller.signal,
      effort: 'medium',
      allowQuestions: !scope,
      onUpdate: (u) => {
        latest = u;
        lastUpdate = u;
        if (Date.now() - lastFlush >= flushMs) void flush();
      },
    });
    const status = timedOut ? 'error' : controller.signal.aborted ? 'cancelled' : 'complete';
    let startedJob: StoredAssistantContent['startedJob'] = null;
    if (status === 'complete' && stored.answersFor && result.jobSuggestion && deps.startJob) {
      try {
        startedJob = await deps.startJob(result.jobSuggestion, {
          projectId: conv.projectId,
          conversationId: conv.id,
        });
      } catch (e) {
        // Fall back to offering the job (the card keeps its Start button).
        console.error('[agent] auto-start failed', e instanceof Error ? e.name : typeof e);
      }
    }
    final = {
      status,
      content: {
        v: 1,
        turns: result.turns,
        activity: [],
        touched: result.touched,
        jobSuggestion: result.jobSuggestion,
        stopReason: result.stopReason,
        questions: result.questions,
        startedJob,
      },
      error: timedOut
        ? TIMEOUT_ERROR
        : result.stopReason === 'refusal'
          ? 'The model declined this request.'
          : result.stopReason === 'max_iterations'
            ? 'Stopped after too many steps.'
            : null,
    };
  } catch (e) {
    const aborted = controller.signal.aborted && !timedOut;
    if (!aborted) console.error('[agent] turn failed', e instanceof Error ? e.name : typeof e);
    const u = lastUpdate as TurnUpdate | null;
    final = {
      status: aborted ? 'cancelled' : 'error',
      content: {
        v: 1,
        turns: u?.turns ?? [],
        partial: u?.partial ?? null,
        activity: u?.activity ?? [],
      },
      error: aborted ? null : timedOut ? TIMEOUT_ERROR : userFacingError(e),
    };
  } finally {
    clearInterval(poll);
    clearTimeout(deadline);
  }
  await writing.catch(() => {});
  // A user cancel wins over completion; otherwise write the final state.
  const [updated] = await db
    .update(agentMessages)
    .set({ status: final.status, content: final.content, error: final.error })
    .where(and(eq(agentMessages.id, messageId), inArray(agentMessages.status, ['streaming'])))
    .returning();
  if (!updated) {
    // Cancelled while finishing: keep the cancel, but store what was produced.
    await db
      .update(agentMessages)
      .set({ content: final.content })
      .where(eq(agentMessages.id, messageId));
  }
  row = await loadMessage(db, actor, messageId);
  return toMessageView(row);
}

export async function cancelMessage(db: Db, actor: Actor, messageId: string): Promise<MessageView> {
  assertCan(actor.role, 'agent:run');
  await loadMessage(db, actor, messageId);
  await db
    .update(agentMessages)
    .set({ status: 'cancelled' })
    .where(
      and(eq(agentMessages.id, messageId), inArray(agentMessages.status, ['pending', 'streaming'])),
    );
  return toMessageView(await loadMessage(db, actor, messageId));
}

export async function getMessageView(
  db: Db,
  actor: Actor,
  messageId: string,
): Promise<MessageView> {
  assertCan(actor.role, 'project:read');
  return toMessageView(await loadMessage(db, actor, messageId));
}

export const messageStreamUrl = (messageId: string) => `/api/agent/messages/${messageId}/stream`;

/**
 * SSE frames for one message: a `message` event whenever its state changes, then `done` when it
 * reaches a terminal status. Ends after `maxMs` so serverless functions recycle; EventSource
 * reconnects and gets the current state immediately.
 */
export async function* messageEvents(
  db: Db,
  actor: Actor,
  messageId: string,
  opts: { signal?: AbortSignal; pollMs?: number; maxMs?: number; keepaliveMs?: number } = {},
): AsyncGenerator<string> {
  assertCan(actor.role, 'project:read');
  await loadMessage(db, actor, messageId);
  const pollMs = opts.pollMs ?? 300;
  const deadline = Date.now() + (opts.maxMs ?? 240_000);
  const keepaliveMs = opts.keepaliveMs ?? 15_000;
  let last = '';
  let lastSent = Date.now();
  let n = 0;
  yield encodeSse({ retry: 1000, data: { messageId }, event: 'open' });
  while (!opts.signal?.aborted) {
    let row = await loadMessage(db, actor, messageId);
    if (!TERMINAL.has(row.status) && (await settleStaleMessages(db, { messageId })))
      row = await loadMessage(db, actor, messageId);
    const view = toMessageView(row);
    const json = JSON.stringify(view);
    if (json !== last) {
      last = json;
      lastSent = Date.now();
      yield encodeSse({ event: 'message', id: ++n, data: view });
    }
    if (TERMINAL.has(view.status)) {
      yield encodeSse({ event: 'done', data: { status: view.status } });
      return;
    }
    if (Date.now() > deadline) return;
    if (Date.now() - lastSent > keepaliveMs) {
      lastSent = Date.now();
      yield SSE_KEEPALIVE;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
