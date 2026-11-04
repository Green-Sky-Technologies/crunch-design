/**
 * Interactive agent turn (Story 5.4): Messages API + tool use, streamed. A manual loop (not the
 * SDK tool runner) because every call must go through the metered LLM proxy, tools run against
 * the server-side ToolHost, and partial output is persisted for SSE as it streams.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { executeTool, type ToolHost } from './tools';
import { SUGGEST_JOB_TOOL, suggestJobInput, type JobSuggestion, type Prefix } from './prefix';
import { ASK_QUESTIONS_TOOL, askQuestionsInput, type QuestionSet } from './questions';

export type MessageStreamParams = Omit<Anthropic.MessageCreateParamsStreaming, 'stream'>;

/** One streamed model call. In the app this is the LLM proxy's streamModel. */
export type ModelGateway = (
  params: MessageStreamParams,
  opts: { signal?: AbortSignal; onEvent?: (e: Anthropic.RawMessageStreamEvent) => void },
) => Promise<Anthropic.Message>;

export type Effort = 'low' | 'medium' | 'high';

export interface ToolActivity {
  id: string;
  name: string;
  status: 'running' | 'done' | 'error';
}

export interface TurnUpdate {
  /** Completed API turns so far (assistant and tool-result user turns). */
  turns: Anthropic.MessageParam[];
  /** The assistant turn currently streaming, if any. */
  partial: Anthropic.ContentBlockParam[] | null;
  activity: ToolActivity[];
}

export interface RunTurnOptions {
  gateway: ModelGateway;
  model: string;
  prefix: Prefix;
  /** Earlier conversation turns (complete messages only). */
  history: Anthropic.MessageParam[];
  /** This turn's user message (document context + request). */
  userTurn: Anthropic.MessageParam;
  host: ToolHost;
  signal?: AbortSignal;
  maxIterations?: number;
  maxTokens?: number;
  effort?: Effort;
  /** Whether ask_questions may end the turn (false on scoped "ask agent" edits). Default true. */
  allowQuestions?: boolean;
  onUpdate?: (u: TurnUpdate) => void;
}

/**
 * A question set the turn ended on. The last assistant turn holds the ask_questions tool_use;
 * its tool_result is sent when the user answers, together with `results` (the tool results of
 * any other tool calls in that same assistant turn, which must share the user message).
 */
export interface PendingQuestions {
  toolUseId: string;
  set: QuestionSet;
  results: Anthropic.ToolResultBlockParam[];
}

export interface TurnResult {
  turns: Anthropic.MessageParam[];
  touched: string[];
  txnIds: string[];
  jobSuggestion: JobSuggestion | null;
  /** Set when the turn ended by asking the user questions. */
  questions: PendingQuestions | null;
  stopReason: Anthropic.StopReason | 'max_iterations' | null;
  iterations: number;
}

export class AgentTurnError extends Error {
  override name = 'AgentTurnError';
}

/** Mirror stream events into displayable partial content. */
function applyEvent(blocks: Anthropic.ContentBlockParam[], e: Anthropic.RawMessageStreamEvent) {
  if (e.type === 'content_block_start') {
    const b = e.content_block;
    if (b.type === 'text') blocks[e.index] = { type: 'text', text: b.text };
    else if (b.type === 'tool_use')
      blocks[e.index] = { type: 'tool_use', id: b.id, name: b.name, input: {} };
    else if (b.type === 'thinking')
      blocks[e.index] = { type: 'thinking', thinking: '', signature: '' };
  } else if (e.type === 'content_block_delta') {
    const b = blocks[e.index];
    if (b?.type === 'text' && e.delta.type === 'text_delta') b.text += e.delta.text;
  }
}

/** Response blocks can be sent back as-is; the SDK's param types are a superset in practice. */
const asParams = (content: Anthropic.ContentBlock[]) =>
  content as unknown as Anthropic.ContentBlockParam[];

export async function runAgentTurn(o: RunTurnOptions): Promise<TurnResult> {
  const maxIterations = o.maxIterations ?? 10;
  const turns: Anthropic.MessageParam[] = [];
  const touched = new Set<string>();
  const txnIds: string[] = [];
  const activity: ToolActivity[] = [];
  let jobSuggestion: JobSuggestion | null = null;
  let questions: PendingQuestions | null = null;
  let stopReason: TurnResult['stopReason'] = null;
  let iterations = 0;

  const update = (partial: Anthropic.ContentBlockParam[] | null) =>
    o.onUpdate?.({
      turns: [...turns],
      partial: partial ? [...partial] : null,
      activity: [...activity],
    });

  while (iterations < maxIterations) {
    iterations++;
    const partial: Anthropic.ContentBlockParam[] = [];
    const message = await o.gateway(
      {
        model: o.model,
        max_tokens: o.maxTokens ?? 16_000,
        system: o.prefix.system,
        tools: o.prefix.tools,
        messages: [...o.history, o.userTurn, ...turns],
        // Automatic breakpoint on the conversation; the prefix carries its own 1h marker.
        cache_control: { type: 'ephemeral' },
        thinking: { type: 'adaptive' },
        output_config: { effort: o.effort ?? 'medium' },
      },
      {
        signal: o.signal,
        onEvent: (e) => {
          applyEvent(partial, e);
          if (e.type === 'content_block_delta' || e.type === 'content_block_start') update(partial);
        },
      },
    );
    stopReason = message.stop_reason;
    turns.push({ role: 'assistant', content: asParams(message.content) });

    const toolUses = message.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );
    if (message.stop_reason === 'refusal') break;
    if (message.stop_reason === 'pause_turn') continue;
    if (!toolUses.length || message.stop_reason !== 'tool_use') {
      if (message.stop_reason === 'max_tokens' && toolUses.length)
        throw new AgentTurnError('The response was cut off mid tool call (max_tokens)');
      break;
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      const act: ToolActivity = { id: tu.id, name: tu.name, status: 'running' };
      activity.push(act);
      update(null);
      if (tu.name === ASK_QUESTIONS_TOOL) {
        const parsed = askQuestionsInput.safeParse(tu.input);
        const error =
          o.allowQuestions === false
            ? 'Questions are not available here. Use your judgement and make the change.'
            : questions
              ? 'Ask all your questions in one ask_questions call.'
              : !parsed.success
                ? `Invalid input: ${parsed.error.issues[0]?.path.join('.') || '(root)'} ${parsed.error.issues[0]?.message ?? 'invalid'}`.trim()
                : null;
        if (error || !parsed.success) {
          act.status = 'error';
          results.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            is_error: true,
            content: error ?? 'Invalid input',
          });
        } else {
          // No result yet: the user's answers become it.
          act.status = 'done';
          questions = { toolUseId: tu.id, set: parsed.data, results: [] };
        }
        continue;
      }
      if (tu.name === SUGGEST_JOB_TOOL) {
        const parsed = suggestJobInput.safeParse(tu.input);
        if (parsed.success) {
          jobSuggestion = parsed.data;
          act.status = 'done';
          results.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content:
              'Shown to the user as an offer to start a background job. Do not make edits for this request now.',
          });
        } else {
          act.status = 'error';
          results.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            is_error: true,
            content: `Invalid input: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
          });
        }
        continue;
      }
      const r = await executeTool(o.host, tu.name, tu.input);
      act.status = r.isError ? 'error' : 'done';
      for (const id of r.touched) touched.add(id);
      if (r.txnId) txnIds.push(r.txnId);
      results.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: r.content,
        is_error: r.isError || undefined,
      });
    }
    if (questions) {
      // The turn ends on the question form; sibling results wait with it.
      (questions as PendingQuestions).results = results;
      update(null);
      break;
    }
    turns.push({ role: 'user', content: results });
    update(null);
    if (o.signal?.aborted) break;
  }
  if (iterations >= maxIterations && turns.at(-1)?.role === 'user') stopReason = 'max_iterations';
  return {
    turns,
    touched: [...touched],
    txnIds,
    jobSuggestion: questions ? null : jobSuggestion,
    questions,
    stopReason,
    iterations,
  };
}

/** Plain text of the assistant turns (for summaries and tests). */
export function turnText(turns: Anthropic.MessageParam[]): string {
  return turns
    .filter((t) => t.role === 'assistant')
    .flatMap((t): (string | Anthropic.ContentBlockParam)[] =>
      typeof t.content === 'string' ? [t.content] : t.content,
    )
    .map((b) => (typeof b === 'string' ? b : b.type === 'text' ? b.text : ''))
    .filter(Boolean)
    .join('\n');
}
