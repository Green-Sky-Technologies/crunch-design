import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { sampleLandingDoc, starterDesignSystem } from '@crunch/doc-model';
import {
  ASK_QUESTIONS_TOOL,
  AnswerError,
  answersSummary,
  askQuestionsInput,
  buildPrefix,
  formatAnswersForModel,
  memoryHost,
  runAgentTurn,
  validateAnswers,
  type QuestionSet,
} from './index';
import { scriptedGateway, text, toolUse } from './evals/scripted';

const ds = starterDesignSystem();

const set: QuestionSet = {
  intro: 'A couple of things before I design it.',
  questions: [
    {
      id: 'audience',
      prompt: 'Who is it for?',
      kind: 'single',
      allowOther: true,
      options: [
        { id: 'devs', label: 'Developers' },
        { id: 'smb', label: 'Small businesses', description: 'Owners, not IT' },
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
        { id: 'quotes', label: 'Testimonials' },
      ],
    },
  ],
};

const userTurn = (t: string): Anthropic.MessageParam => ({
  role: 'user',
  content: [{ type: 'text', text: t }],
});

describe('ask_questions input', () => {
  it('accepts a valid question set', () => {
    expect(askQuestionsInput.safeParse(set).success).toBe(true);
  });

  it.each([
    ['no questions', { questions: [] }],
    [
      'too many questions',
      { questions: Array.from({ length: 6 }, (_, i) => ({ ...set.questions[0]!, id: `q${i}` })) },
    ],
    ['one option', { questions: [{ ...set.questions[0]!, options: [{ id: 'a', label: 'A' }] }] }],
    [
      'seven options',
      {
        questions: [
          {
            ...set.questions[0]!,
            options: Array.from({ length: 7 }, (_, i) => ({ id: `o${i}`, label: `O${i}` })),
          },
        ],
      },
    ],
    ['bad kind', { questions: [{ ...set.questions[0]!, kind: 'free' }] }],
    ['unknown key', { ...set, extra: 1 }],
    ['duplicate question ids', { questions: [set.questions[0]!, set.questions[0]!] }],
    [
      'duplicate option ids',
      {
        questions: [
          {
            ...set.questions[0]!,
            options: [
              { id: 'a', label: 'A' },
              { id: 'a', label: 'B' },
            ],
          },
        ],
      },
    ],
    ['bad id', { questions: [{ ...set.questions[0]!, id: 'has space' }] }],
  ])('rejects %s', (_, input) => {
    expect(askQuestionsInput.safeParse(input).success).toBe(false);
  });

  it('is in the interactive prefix only, with a JSON schema', () => {
    const tool = buildPrefix('interactive', ds).tools.find((t) => t.name === ASK_QUESTIONS_TOOL);
    expect(tool?.input_schema).toMatchObject({ type: 'object', required: ['questions'] });
    expect(buildPrefix('interactive', ds).system[0]!.text).toContain('ALWAYS ask first');
    expect(buildPrefix('job', ds).tools.map((t) => t.name)).not.toContain(ASK_QUESTIONS_TOOL);
  });
});

describe('answers', () => {
  it('validates and normalizes answers to question order', () => {
    expect(
      validateAnswers(set, [
        { questionId: 'sections', optionIds: ['quotes', 'faq', 'faq'] },
        { questionId: 'audience', optionIds: [], other: '  Designers ' },
      ]),
    ).toEqual([
      { questionId: 'audience', optionIds: [], other: 'Designers' },
      { questionId: 'sections', optionIds: ['quotes', 'faq'] },
    ]);
    // Empty answers are dropped.
    expect(validateAnswers(set, [{ questionId: 'audience', optionIds: [], other: ' ' }])).toEqual(
      [],
    );
  });

  it.each([
    ['unknown question', [{ questionId: 'nope', optionIds: [] }]],
    ['unknown option', [{ questionId: 'audience', optionIds: ['x'] }]],
    ['two answers to a single question', [{ questionId: 'audience', optionIds: ['devs', 'smb'] }]],
    [
      'option plus Other on a single',
      [{ questionId: 'audience', optionIds: ['devs'], other: 'x' }],
    ],
    ['Other where not allowed', [{ questionId: 'sections', optionIds: [], other: 'Blog' }]],
    [
      'the same question twice',
      [
        { questionId: 'audience', optionIds: ['devs'] },
        { questionId: 'audience', optionIds: ['smb'] },
      ],
    ],
  ])('rejects %s', (_, answers) => {
    expect(() => validateAnswers(set, answers)).toThrow(AnswerError);
  });

  it('formats readable answers for the model and a summary for the chat', () => {
    const result = {
      outcome: 'answered' as const,
      answers: [{ questionId: 'sections', optionIds: ['faq', 'compare'] }],
    };
    const forModel = formatAnswersForModel(set, result);
    expect(forModel).toContain('1. Who is it for?\n   Answer: no preference (use your judgement)');
    expect(forModel).toContain('2. Which sections?\n   Answer: FAQ; Comparison table');
    expect(forModel).toContain('suggest_generation_job');
    expect(answersSummary(set, result)).toBe('Which sections? FAQ, Comparison table');
    expect(
      formatAnswersForModel(set, {
        outcome: 'answered',
        answers: [{ questionId: 'audience', optionIds: [], other: 'Designers' }],
      }),
    ).toContain('Answer: Other: Designers');
    expect(formatAnswersForModel(set, { outcome: 'skipped', answers: [] })).toContain(
      'Use your own judgement',
    );
    expect(formatAnswersForModel(set, { outcome: 'superseded', answers: [] })).toContain(
      'did not answer',
    );
  });
});

describe('ask_questions in a turn', () => {
  it('ends the turn with the question set pending (no tool_result yet)', async () => {
    const host = memoryHost(sampleLandingDoc(), ds);
    const { gateway, requests } = scriptedGateway([
      {
        content: [
          text('A few questions first.'),
          toolUse('tu_o', 'get_outline', {}),
          toolUse('tu_q', ASK_QUESTIONS_TOOL, set),
        ],
      },
      { content: [text('should not be called')] },
    ]);
    const res = await runAgentTurn({
      gateway,
      model: 'm',
      prefix: buildPrefix('interactive', ds),
      history: [],
      userTurn: userTurn('Design a pricing page'),
      host,
    });
    expect(requests).toHaveLength(1);
    expect(res.turns.map((t) => t.role)).toEqual(['assistant']);
    expect(res.questions).toMatchObject({ toolUseId: 'tu_q', set: { intro: set.intro } });
    // The other call's result waits with the questions (it must share their user message).
    expect(res.questions!.results.map((r) => r.tool_use_id)).toEqual(['tu_o']);
    expect(res.stopReason).toBe('tool_use');
  });

  it('returns an error result for invalid input and keeps going', async () => {
    const host = memoryHost(sampleLandingDoc(), ds);
    const { gateway, requests } = scriptedGateway([
      { content: [toolUse('tu_q', ASK_QUESTIONS_TOOL, { questions: [] })] },
      { content: [text('Making it anyway.')] },
    ]);
    const res = await runAgentTurn({
      gateway,
      model: 'm',
      prefix: buildPrefix('interactive', ds),
      history: [],
      userTurn: userTurn('x'),
      host,
    });
    expect(res.questions).toBeNull();
    const result = (requests[1]!.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[])[0]!;
    expect(result).toMatchObject({ tool_use_id: 'tu_q', is_error: true });
    expect(String(result.content)).toContain('Invalid input: questions');
  });

  it('refuses questions where they are not allowed (scoped edits)', async () => {
    const host = memoryHost(sampleLandingDoc(), ds);
    const { gateway, requests } = scriptedGateway([
      { content: [toolUse('tu_q', ASK_QUESTIONS_TOOL, set)] },
      { content: [text('ok')] },
    ]);
    const res = await runAgentTurn({
      gateway,
      model: 'm',
      prefix: buildPrefix('interactive', ds),
      history: [],
      userTurn: userTurn('x'),
      host,
      allowQuestions: false,
    });
    expect(res.questions).toBeNull();
    expect(JSON.stringify(requests[1]!.messages.at(-1))).toContain('not available here');
  });
});
