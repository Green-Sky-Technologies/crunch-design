/**
 * On-demand eval run against a live model (Story 5.13). Spends real tokens on the caller's key:
 *
 *   ANTHROPIC_API_KEY=… pnpm --filter @crunch/agent eval -- --model claude-sonnet-5-5
 *
 * Options: --model <id> (repeatable; default MODEL_TIERS.interactive), --case <id> (repeatable),
 * --update-baseline. Writes evals/results/<model>.json, compares with evals/baselines/<model>.json,
 * and exits 1 on any regression (or any failure when there is no baseline yet).
 * Calls go straight to the Anthropic API, not through the app's LLM proxy (no app or workspace).
 */
import Anthropic from '@anthropic-ai/sdk';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODEL_TIERS } from '@crunch/providers';
import type { ModelGateway } from '../interactive';
import {
  compareToBaseline,
  goldenCase,
  runCase,
  summarize,
  type EvalReport,
  type GoldenCase,
} from './harness';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../evals');

export function loadGoldenCases(dir = join(ROOT, 'golden')): GoldenCase[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .flatMap((f) => {
      const raw = JSON.parse(readFileSync(join(dir, f), 'utf8')) as unknown[];
      return raw.map((c) => goldenCase.parse(c));
    });
}

export function anthropicGateway(client: Anthropic): ModelGateway {
  return async (params, opts) => {
    const stream = client.messages.stream(params, { signal: opts.signal });
    for await (const e of stream) opts.onEvent?.(e);
    return stream.finalMessage();
  };
}

function args(argv: string[]) {
  const models: string[] = [];
  const cases: string[] = [];
  let update = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--model') models.push(argv[++i]!);
    else if (argv[i] === '--case') cases.push(argv[++i]!);
    else if (argv[i] === '--update-baseline') update = true;
  }
  return { models: models.length ? models : [MODEL_TIERS.interactive], cases, update };
}

async function main() {
  const { models, cases, update } = args(process.argv.slice(2));
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Set ANTHROPIC_API_KEY to run evals (they make real, billed model calls).');
    process.exit(2);
  }
  const all = loadGoldenCases().filter((c) => !cases.length || cases.includes(c.id));
  const gateway = anthropicGateway(new Anthropic());
  let failed = false;
  for (const model of models) {
    const results = [];
    for (const c of all) {
      const r = await runCase(c, { gateway, model });
      console.log(
        `${r.passed ? 'PASS' : 'FAIL'} ${model} ${c.id} (${r.usage.outputTokens} out)${r.passed ? '' : ` — ${r.failures.join('; ')}`}`,
      );
      results.push(r);
    }
    const report = summarize(model, results);
    mkdirSync(join(ROOT, 'results'), { recursive: true });
    writeFileSync(join(ROOT, 'results', `${model}.json`), JSON.stringify(report, null, 2) + '\n');
    const baselinePath = join(ROOT, 'baselines', `${model}.json`);
    const baseline = existsSync(baselinePath)
      ? (JSON.parse(readFileSync(baselinePath, 'utf8')) as EvalReport)
      : null;
    const regressions = compareToBaseline(report, baseline);
    for (const r of regressions) console.log(`REGRESSION ${model} ${r.id} ${r.kind}: ${r.detail}`);
    console.log(
      `${model}: ${report.passed}/${results.length} passed, ${regressions.length} regression(s)`,
    );
    if (regressions.length || (!baseline && report.failed)) failed = true;
    if (update) {
      mkdirSync(dirname(baselinePath), { recursive: true });
      writeFileSync(baselinePath, JSON.stringify(report, null, 2) + '\n');
    }
  }
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) void main();
