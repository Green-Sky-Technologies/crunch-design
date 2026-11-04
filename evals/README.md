# Agent evals (Story 5.13)

Golden prompts for the interactive agent. Each case runs the real interactive loop (cached
prefix, per-turn document context, tool handlers, scope enforcement) against a fixture document
in memory, then asserts:

- **patch scope**: which nodes the agent touched (`touchWithin`, `mustTouch`, `maxTouched`, `noEdits`);
- **lint-clean**: no `@crunch/ds-lint` errors on the touched nodes (`lintClean`);
- **job hand-off**: too-big requests offer a generation job (`jobSuggestion`);
- **token budget**: input and output tokens for the whole turn (`maxInputTokens`, `maxOutputTokens`).

The harness is `packages/agent/src/evals/harness.ts`. The cases are in `golden/*.json`; each file
holds an array validated by `goldenCase`.

## Running

This makes real, billed model calls on the key in `ANTHROPIC_API_KEY`. It calls the Anthropic API
directly, not the app's LLM proxy.

```sh
ANTHROPIC_API_KEY=sk-ant-… pnpm --filter @crunch/agent eval -- --model claude-sonnet-5-5
# several models, one case, refresh the baseline:
ANTHROPIC_API_KEY=… pnpm --filter @crunch/agent eval -- --model claude-sonnet-5-5 --model claude-haiku-5-5 --case headline-copy
ANTHROPIC_API_KEY=… pnpm --filter @crunch/agent eval -- --model claude-sonnet-5-5 --update-baseline
```

Results go to `results/<model>.json` (gitignore-worthy). Commit `baselines/<model>.json` to
track regressions per model. A run exits 1 when a case that passed in the baseline now fails, or
when a case's output tokens grow more than 25%. With no baseline yet, any failure exits 1.

`pnpm test` runs the harness itself against scripted model responses (no keys, no spend). That
checks the assertions, not model quality.

## CI on demand

Suggested workflow (`.github/workflows/agent-evals.yml`; not added by this stream, since root
config belongs to integration):

```yaml
name: agent-evals
on:
  workflow_dispatch:
    inputs:
      models: { description: 'Space-separated model ids', default: 'claude-sonnet-5-5' }
jobs:
  evals:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @crunch/agent eval -- $(for m in ${{ inputs.models }}; do echo --model $m; done)
        env: { ANTHROPIC_API_KEY: '${{ secrets.EVALS_ANTHROPIC_API_KEY }}' }
      - uses: actions/upload-artifact@v4
        with: { name: eval-results, path: evals/results }
```
