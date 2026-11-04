import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ForbiddenError } from '@crunch/authz';
import type { Anthropic, JobSuggestion, QuestionSet } from '@crunch/agent';
import { agentMessages, eq } from '@crunch/db';
import {
  answerQuestions,
  getProjectChat,
  runAssistantMessage,
  sendMessage,
} from '@/server/services/agent';
import { requestAgentEdit } from '@/server/services/agent/edit';
import { getDoc } from '@/server/services/design-docs';
import { createProject } from '@/server/services/projects';
import type { LlmProxyDeps, MessagesApi } from '@/server/services/llm-proxy';
import { NotFoundError, ValidationError } from '@/server/services/types';
import { makeActor, reset, testDb } from './helpers';
import { scriptedClient, textBlock, toolUse, type ScriptedResponse } from './fakes/anthropic';

const { db, close } = testDb();
afterAll(close);
beforeEach(() => reset(db));

const proxyWith = (client: { messages: MessagesApi }): LlmProxyDeps => ({
  loadClient: async () => ({ messages: client.messages, provider: 'anthropic' }),
});

const QUESTIONS: QuestionSet = {
  intro: 'Two quick questions.',
  questions: [
    {
      id: 'audience',
      prompt: 'Who is it for?',
      kind: 'single',
      allowOther: true,
      options: [
        { id: 'devs', label: 'Developers' },
        { id: 'smb', label: 'Small businesses' },
      ],
    },
    {
      id: 'sections',
      prompt: 'Which sections?',
      kind: 'multi',
      allowOther: false,
      options: [
        { id: 'faq', label: 'FAQ' },
        { id: 'compare', label: 'Comparison table' },
      ],
    },
  ],
};

const ask: ScriptedResponse = {
  content: [
    textBlock('A couple of questions first.'),
    toolUse('tu_ask', 'ask_questions', QUESTIONS),
  ],
  stopReason: 'tool_use',
};

const suggest = (prompt: string): ScriptedResponse => ({
  content: [
    toolUse('tu_job', 'suggest_generation_job', { kind: 'generate', prompt, reason: 'New page' }),
  ],
  stopReason: 'tool_use',
});

async function setup() {
  const editor = await makeActor(db, 'editor');
  const project = await createProject(db, editor, { name: 'P' });
  return { editor, project };
}

/** Send a new-design prompt and run the reply, which asks questions. */
async function askedQuestions(client: ReturnType<typeof scriptedClient>) {
  const s = await setup();
  const sent = await sendMessage(db, s.editor, {
    projectId: s.project.id,
    prompt: 'Design a pricing page',
  });
  const view = await runAssistantMessage(db, s.editor, sent.messageId, {
    proxy: proxyWith(client),
  });
  return { ...s, sent, view };
}

const lastUserTurn = (req: Anthropic.MessageStreamParams) =>
  req.messages.at(-1)!.content as Anthropic.ContentBlockParam[];

describe('follow-up questions', () => {
  it('persists the question set, answers it, and starts the job with the enriched brief', async () => {
    const client = scriptedClient([
      ask,
      suggest('Pricing page for developers with an FAQ and a comparison table'),
      { content: [textBlock('Starting the pricing page.')] },
    ]);
    const { editor, project, sent, view } = await askedQuestions(client);
    expect(view).toMatchObject({
      status: 'complete',
      questions: QUESTIONS,
      answers: null,
      text: 'A couple of questions first.',
    });

    // Survives reload.
    const reloaded = await getProjectChat(db, editor, project.id);
    expect(reloaded.messages[1]).toMatchObject({ id: sent.messageId, questions: QUESTIONS });

    const answered = await answerQuestions(db, editor, sent.messageId, {
      answers: [
        { questionId: 'audience', optionIds: ['devs'] },
        { questionId: 'sections', optionIds: ['faq', 'compare'] },
      ],
    });
    expect(answered).toMatchObject({ conversationId: sent.conversationId, needsRun: true });

    const started: JobSuggestion[] = [];
    const reply = await runAssistantMessage(db, editor, answered.messageId, {
      proxy: proxyWith(client),
      startJob: async (s, at) => {
        started.push(s);
        expect(at).toEqual({ projectId: project.id, conversationId: sent.conversationId });
        return { jobId: '00000000-0000-4000-8000-000000000001', messageId: 'job-message' };
      },
    });
    expect(started).toEqual([
      expect.objectContaining({
        kind: 'generate',
        prompt: 'Pricing page for developers with an FAQ and a comparison table',
      }),
    ]);
    // The job started, so it isn't offered again.
    expect(reply).toMatchObject({
      status: 'complete',
      jobSuggestion: null,
      startedJobMessageId: 'job-message',
    });

    // The answers went back as the pending tool_result, first in the user turn, right after
    // the tool_use, with the document context after it.
    const req = client.calls[1]!;
    const prev = req.messages.at(-2)!;
    expect(prev.role).toBe('assistant');
    expect(JSON.stringify(prev.content)).toContain('tu_ask');
    const turn = lastUserTurn(req);
    expect(turn[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'tu_ask' });
    const result = String((turn[0] as Anthropic.ToolResultBlockParam).content);
    expect(result).toContain('Who is it for?\n   Answer: Developers');
    expect(result).toContain('Which sections?\n   Answer: FAQ; Comparison table');
    expect(turn[1]).toMatchObject({ type: 'text' });
    expect((turn[1] as Anthropic.TextBlockParam).text).toMatch(/^<document>/);
    expect(JSON.stringify(turn)).not.toContain('ask_questions before anything else');

    const chat = await getProjectChat(db, editor, project.id);
    expect(chat.messages.map((m) => [m.role, m.answersFor])).toEqual([
      ['user', null],
      ['assistant', null],
      ['user', sent.messageId],
      ['assistant', null],
    ]);
    expect(chat.messages[1]!.answers).toMatchObject({
      outcome: 'answered',
      answers: [
        { questionId: 'audience', optionIds: ['devs'] },
        { questionId: 'sections', optionIds: ['faq', 'compare'] },
      ],
    });
    expect(chat.messages[2]!.text).toContain('Who is it for? Developers');

    // Later turns replay the exchange in a valid order.
    const next = await sendMessage(db, editor, {
      projectId: project.id,
      conversationId: sent.conversationId,
      prompt: 'thanks',
    });
    await runAssistantMessage(db, editor, next.messageId, { proxy: proxyWith(client) });
    const roles = client.calls[3]!.messages.map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user']);
  });

  it('skips: the agent decides, and nothing is offered without a job starter', async () => {
    const client = scriptedClient([ask, suggest('A pricing page')]);
    const { editor, sent } = await askedQuestions(client);
    const answered = await answerQuestions(db, editor, sent.messageId, { skip: true });
    const reply = await runAssistantMessage(db, editor, answered.messageId, {
      proxy: proxyWith(client),
    });
    // Without a starter (or if it fails) the job is offered as before.
    expect(reply.jobSuggestion).toMatchObject({ kind: 'generate' });
    const turn = lastUserTurn(client.calls[1]!);
    expect(String((turn[0] as Anthropic.ToolResultBlockParam).content)).toContain(
      'skipped the questions',
    );
    const [asked] = await db
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.id, sent.messageId));
    expect((asked!.content as { answers: unknown }).answers).toMatchObject({ outcome: 'skipped' });
  });

  it('validates answers and accepts them only once', async () => {
    const client = scriptedClient([ask]);
    const { editor, sent } = await askedQuestions(client);
    await expect(
      answerQuestions(db, editor, sent.messageId, {
        answers: [{ questionId: 'audience', optionIds: ['devs', 'smb'] }],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      answerQuestions(db, editor, sent.messageId, {
        answers: [{ questionId: 'sections', optionIds: [], other: 'Blog' }],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(answerQuestions(db, editor, sent.messageId, { answers: [] })).rejects.toThrow(
      'Answer a question, or skip',
    );
    await answerQuestions(db, editor, sent.messageId, {
      answers: [{ questionId: 'audience', optionIds: [], other: 'Designers' }],
    });
    await expect(answerQuestions(db, editor, sent.messageId, { skip: true })).rejects.toThrow(
      'already answered',
    );
  });

  it('is limited to editors in the same workspace', async () => {
    const client = scriptedClient([ask]);
    const { editor, sent } = await askedQuestions(client);
    const viewer = await makeActor(db, 'viewer', editor.workspace);
    await expect(
      answerQuestions(db, viewer, sent.messageId, { skip: true }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const outsider = await makeActor(db, 'editor');
    await expect(
      answerQuestions(db, outsider, sent.messageId, { skip: true }),
    ).rejects.toBeInstanceOf(NotFoundError);
    // Messages without questions aren't answerable.
    await expect(
      answerQuestions(db, editor, sent.userMessageId, { skip: true }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('a new message instead of answers supersedes the questions', async () => {
    const client = scriptedClient([ask, { content: [textBlock('Sure, a blog page.')] }]);
    const { editor, project, sent } = await askedQuestions(client);
    const next = await sendMessage(db, editor, {
      projectId: project.id,
      conversationId: sent.conversationId,
      prompt: 'Actually, make it a blog page',
    });
    await runAssistantMessage(db, editor, next.messageId, { proxy: proxyWith(client) });
    const turn = lastUserTurn(client.calls[1]!);
    expect(turn[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'tu_ask' });
    expect(JSON.stringify(turn)).toContain('Actually, make it a blog page');
    const chat = await getProjectChat(db, editor, project.id);
    expect(chat.messages[1]!.answers).toMatchObject({ outcome: 'superseded' });
    await expect(
      answerQuestions(db, editor, sent.messageId, { skip: true }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('scoped ask-agent edits never stop on questions', async () => {
    const editor = await makeActor(db, 'editor');
    const project = await createProject(db, editor, { name: 'P' });
    const { doc } = await getDoc(db, editor, project.id);
    const frame = doc.frames[0]!;
    const client = scriptedClient([ask, { content: [textBlock('Done.')] }]);
    const res = await requestAgentEdit(db, editor, {
      projectId: project.id,
      frameId: frame.id,
      nodeId: frame.rootNodeId,
      prompt: 'make it nicer',
    });
    const view = await runAssistantMessage(db, editor, res.messageId, {
      proxy: proxyWith(client),
    });
    expect(view.questions).toBeNull();
    expect(view.text).toContain('Done.');
  });
});
