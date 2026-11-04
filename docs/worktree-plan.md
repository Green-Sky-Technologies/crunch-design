# Worktree Plan: CrunchDesign Epics 2–9

## Overview

- **Workstreams:** 1 foundation → 5 parallel → 1 integration
- **Phases:** 3
- **Atomic commits:** ~62 (foundation 11 · canvas 10 · agent 12 · design-system 5 · collab-export 8 · figma 6 · integration 10)
- **Estimated parallel speedup:** ~2.5–3× over sequential. Foundation is about a fifth of the work and gates everything; Phase 1 runs 5-wide.

Epic 1 is done on `main`. **Epic 2 (document model + renderer) is the foundation phase.** Every
other epic reads or writes DesignDocs, so the doc model, ops, renderer and persistence are the
interface contract the parallel streams build against.

### Conflict hotspots and how this plan handles them

| Hotspot                                                                                                                          | Rule                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/db/src/schema*` + `packages/db/migrations/**` (Drizzle `_journal.json` is a single sequential file)                    | **Foundation creates every table for Epics 2–8 in one migration.** Phase 1 streams must not generate migrations. If a stream truly needs a column, record it in `docs/schema-requests.md` (create it in your worktree; the integration phase applies them).           |
| `pnpm-lock.yaml`, `apps/web/package.json`                                                                                        | Foundation pre-installs every dependency we can anticipate (list in Foundation commit 11). If a stream needs another one, add it only to a package it owns. On merge, resolve a lockfile conflict by taking `main`'s version and running `pnpm install` (mechanical). |
| `apps/web/next.config.ts` (`transpilePackages`)                                                                                  | Foundation registers every planned package.                                                                                                                                                                                                                           |
| Workspace nav (`app/w/[slug]/layout.tsx`) and the project editor page                                                            | Foundation adds every nav item, stub route and editor slot. Streams fill in their own `src/features/<stream>/` directory and never edit the shell.                                                                                                                    |
| `packages/authz`                                                                                                                 | Permissions for all epics already exist (Epic 1). Streams don't modify it. If one must, it's a schema-request-style note for integration.                                                                                                                             |
| Cross-stream calls (lint used by agent; "ask agent" from comments; comment pins on canvas; job runner used by DS import/codegen) | Foundation defines **contracts with stub implementations**. The owning stream replaces the stub; consumers code against the interface. Work that needs two streams' real implementations goes to Phase 2.                                                             |

## File Ownership Map

| Worktree               | Owns (create/modify)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `foundation`           | `packages/db/**`, `packages/doc-model/**`, `packages/renderer/**`, `packages/contracts/**`, `apps/web/src/features/doc-store/**`, `apps/web/src/server/services/{design-docs,snapshots}.ts`, `apps/web/src/app/api/projects/[projectId]/doc/**`, editor shell `apps/web/src/app/w/[slug]/p/[projectId]/**`, `apps/web/src/app/w/[slug]/layout.tsx`, `apps/web/src/components/workspace-nav.tsx`, stub feature entry files `apps/web/src/features/*/index.tsx`, stub routes, `apps/web/next.config.ts`, root and app `package.json`, `pnpm-lock.yaml`, `turbo.json` |
| `stream-canvas`        | `apps/web/src/features/canvas/**` (except the slot file's exported name), `packages/canvas/**`, `apps/web/src/app/api/projects/[projectId]/lock/**`, `apps/web/src/server/services/locks.ts`, `apps/web/e2e/canvas/**`, `docs/adr/0001-canvas.md`                                                                                                                                                                                                                                                                                                                  |
| `stream-agent`         | `packages/agent/**` (tool impls, prompts), `packages/sandbox-runner/**`, `apps/web/src/features/agent/**`, `apps/web/src/app/api/{llm,agent,jobs}/**`, `apps/web/src/server/services/{llm-proxy,agent,jobs,usage}.ts`, `apps/web/src/app/w/[slug]/settings/usage/**`, `evals/**`, `docs/adr/0002-cache-ttl.md`                                                                                                                                                                                                                                                     |
| `stream-design-system` | `packages/ds-lint/**` (replaces stub), `apps/web/src/features/design-system/**`, `apps/web/src/app/w/[slug]/design-systems/**`, `apps/web/src/server/services/design-systems.ts`                                                                                                                                                                                                                                                                                                                                                                                   |
| `stream-collab-export` | `apps/web/src/features/{collab,export}/**`, `packages/handoff/**`, `apps/web/src/app/s/**` (public share viewer), `apps/web/src/app/api/{comments,versions,share,export}/**`, `apps/web/src/server/services/{comments,versions,share-links,activity,export}.ts`                                                                                                                                                                                                                                                                                                    |
| `stream-figma`         | `apps/figma-plugin/**`, `packages/figma-convert/**`, `apps/web/src/app/api/figma/**`, `apps/web/src/app/w/[slug]/settings/figma/**`, `apps/web/src/server/services/{figma,plugin-tokens}.ts`                                                                                                                                                                                                                                                                                                                                                                       |
| `integration`          | Anything, after all Phase 1 branches merge                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

`packages/contracts` is **read-only** for Phase 1 streams. Each stream implements the contract in its own package (for example `packages/ds-lint` replaces the stub that `contracts` re-exports).

---

## Phase 0: Foundation

> Must merge to `main` before Phase 1 starts.

### Worktree: `foundation`

- **Branch:** `feat/foundation`
- **Purpose:** Epic 2 in full (DesignDoc model, ops, renderer, persistence), every Phase 1 table,
  cross-stream contracts with stubs, the editor shell with feature slots, and all anticipated dependencies.
- **Commit sequence:**

| #   | Commit message                                                                                   | Files                                                                                                                                                                                                     | Verify                                                                                   |
| --- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 1   | `refactor(db): split schema into per-domain modules`                                             | `packages/db/src/schema/{core,index}.ts`, `packages/db/src/schema.ts` (re-export)                                                                                                                         | `pnpm db:generate` produces **no** new migration; tests pass                             |
| 2   | `feat(db): add tables for docs, versions, design systems, collaboration, agent, jobs, figma`     | `packages/db/src/schema/{docs,design-systems,collab,agent,figma}.ts`, `packages/db/migrations/0001_*`                                                                                                     | `pnpm db:migrate` on a fresh DB; `pnpm test`                                             |
| 3   | `feat(doc-model): DesignDoc, node, style, token and design-system schemas`                       | `packages/doc-model/src/{schema,styles,tokens,design-system}.ts` + tests                                                                                                                                  | `pnpm --filter @crunch/doc-model test`                                                   |
| 4   | `feat(doc-model): patch ops, reducer, inverse ops and transactions`                              | `packages/doc-model/src/ops/**` + property tests (fast-check)                                                                                                                                             | apply∘inverse = identity property holds                                                  |
| 5   | `feat(renderer): compile design-system tokens to CSS custom properties`                          | `packages/renderer/src/tokens.ts` + tests                                                                                                                                                                 | tests pass                                                                               |
| 6   | `feat(renderer): style-isolated frame renderer with incremental subtree updates and breakpoints` | `packages/renderer/src/react/**` + tests                                                                                                                                                                  | render tests: change one node, only its subtree re-renders                               |
| 7   | `feat(renderer): static HTML renderer sharing the DOM renderer's output`                         | `packages/renderer/src/static.ts` + snapshot tests                                                                                                                                                        | static and DOM output match for fixtures                                                 |
| 8   | `feat(web): DesignDoc persistence, ops API and snapshot service`                                 | `apps/web/src/server/services/{design-docs,snapshots}.ts`, `apps/web/src/app/api/projects/[projectId]/doc/**`, tests                                                                                      | integration tests: ops append, compaction, version conflict rejected, viewer can't write |
| 9   | `feat(contracts): cross-stream interfaces with stub implementations`                             | `packages/contracts/src/{agent-tools,agent-edit,ds-lint,job-runner,canvas-overlay,export}.ts`                                                                                                             | typecheck; stubs return no-ops                                                           |
| 10  | `feat(web): editor shell, client doc store with undo/redo, feature slots and stub routes`        | `apps/web/src/features/doc-store/**`, `apps/web/src/features/{canvas,agent,collab,export,design-system}/index.tsx` (stubs), editor page, layout/nav, stub pages for design systems, usage, Figma settings | `pnpm build`; editor page renders a sample doc read-only                                 |
| 11  | `chore: pre-install Phase 1 dependencies and register packages`                                  | `package.json`s, `pnpm-lock.yaml`, `apps/web/next.config.ts`, empty `packages/{canvas,agent,sandbox-runner,ds-lint,handoff,figma-convert}` skeletons, `apps/figma-plugin` skeleton                        | `pnpm install --frozen-lockfile && pnpm build && pnpm test`                              |

**Contracts (commit 9).** Interfaces only, plus stubs:

- `agent-tools`: Zod input/output schemas and names for every tool in Story 5.3, shared by both agent runtimes.
- `agent-edit`: `requestAgentEdit({ projectId, nodeId, prompt }) → { conversationId }`. The collab stream calls it from comments (5.7) and the agent stream implements it.
- `ds-lint`: `lintDoc(doc, designSystem) → LintIssue[]`, a stub returning `[]`. Implemented by `stream-design-system` and consumed by the agent.
- `job-runner`: `JobRunner` (`start/cancel/status/events`) and the `JobKind` union. Implemented by `stream-agent`; consumed in Phase 2 by DS import and codegen.
- `canvas-overlay`: `registerOverlay(id, Component)` for anchoring UI to a node's on-screen rect. Implemented by `stream-canvas`; used by collab for comment pins.
- `export`: `HandoffBundle` schema (7.2), so Figma and codegen agree on the shape.

**Anticipated deps (commit 11):** `tldraw`, `zustand`, `immer`, `nanoid`, `fast-check`,
`@anthropic-ai/claude-agent-sdk`, `@vercel/sandbox`, `@vercel/blob`, `jszip`, `culori` (color math
for lint and contrast), `@figma/plugin-typings`, `esbuild` (plugin build), `@testing-library/react`, `happy-dom`.

- **Done when:** `main` has Epic 2 complete, all tables are migrated, every contract file exists with stubs, the editor page renders a sample DesignDoc, and `pnpm lint && pnpm typecheck && pnpm test && pnpm build` is green.

---

## Phase 1: Parallel Workstreams

> All five start from `main` after foundation merges.

### Worktree: `stream-canvas` (Epic 3)

- **Branch:** `feat/canvas`
  | #   | Commit message                                                                                                                               | Story |
  | --- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
  | 1   | `docs(canvas): ADR 0001 for tldraw vs custom canvas and Shadow DOM vs iframe` (spike code under `packages/canvas/spike`, deleted afterwards) | 3.0   |
  | 2   | `feat(canvas): frames on an infinite canvas with pan, zoom and minimap`                                                                      | 3.1   |
  | 3   | `feat(canvas): selection overlay, tree navigation and layers panel` (+ implement `canvas-overlay` contract)                                  | 3.2   |
  | 4   | `feat(canvas): inspector with token-aware fields for all style props`                                                                        | 3.3   |
  | 5   | `feat(canvas): flow-first drag and drop with absolute positioning opt-in`                                                                    | 3.4   |
  | 6   | `feat(canvas): resize handles with fixed, fill and hug sizing and smart guides`                                                              | 3.5   |
  | 7   | `feat(canvas): inline text editing`                                                                                                          | 3.6   |
  | 8   | `feat(canvas): soft edit lock, presence and request control`                                                                                 | 3.8   |
  | 9   | `test(canvas): cross-browser Playwright suite for editor interactions`                                                                       | 3.9   |
  | 10  | `perf(canvas): perf budget checks and fixes`                                                                                                 | 3.10  |

(Story 3.7 undo/redo is in the foundation doc store.)

### Worktree: `stream-agent` (Epic 5)

- **Branch:** `feat/agent`
  | #   | Commit message                                                                                   | Story            |
  | --- | ------------------------------------------------------------------------------------------------ | ---------------- |
  | 1   | `feat(agent): LLM proxy with credential injection, job tokens, usage metering and a budget hook` | 5.2, 5.10 (data) |
  | 2   | `feat(agent): agent tool implementations over DesignDoc ops`                                     | 5.3              |
  | 3   | `feat(agent): interactive agent path with SSE streaming`                                         | 5.4              |
  | 4   | `feat(agent): chat panel with streaming, tool activity, cancel and retry`                        | 5.6              |
  | 5   | `feat(agent): Vercel Sandbox job runner with resumable event stream`                             | 5.1              |
  | 6   | `feat(agent): generation jobs for generate, redesign and alternatives`                           | 5.5              |
  | 7   | `feat(agent): implement requestAgentEdit contract for scoped node edits`                         | 5.7 (backend)    |
  | 8   | `feat(agent): agent-generated sliders and slider tray`                                           | 5.8              |
  | 9   | `feat(agent): task-based model picker and workspace model defaults`                              | 5.9              |
  | 10  | `feat(agent): auto snapshot before agent edits with one-click revert`                            | 5.12             |
  | 11  | `feat(agent): usage dashboard and cache TTL ADR`                                                 | 5.10 (UI), 5.11  |
  | 12  | `test(agent): golden-prompt eval suite`                                                          | 5.13             |

### Worktree: `stream-design-system` (Epic 4, local parts)

- **Branch:** `feat/design-system`
  | #   | Commit message                                                                           | Story   |
  | --- | ---------------------------------------------------------------------------------------- | ------- |
  | 1   | `feat(design-system): service and API for systems, versions and components`              | 4.1–4.3 |
  | 2   | `feat(design-system): token and component editor with live preview`                      | 4.1     |
  | 3   | `feat(design-system): draft and published versions with project upgrade prompt`          | 4.2     |
  | 4   | `feat(design-system): multiple systems per workspace and project switching with preview` | 4.3     |
  | 5   | `feat(ds-lint): deterministic design-system linter with WCAG contrast checks`            | 4.6     |

(This is the lightest stream. If it finishes early, it can take Story 6.4, the activity feed, from collab-export, since those files are disjoint.)

### Worktree: `stream-collab-export` (Epics 6 and 7, deterministic parts)

- **Branch:** `feat/collab-export`
  | #   | Commit message                                                                                | Story    |
  | --- | --------------------------------------------------------------------------------------------- | -------- |
  | 1   | `feat(collab): comment threads pinned to nodes with mentions and resolve`                     | 6.1      |
  | 2   | `feat(collab): ask-agent comments via the requestAgentEdit contract`                          | 5.7 (UI) |
  | 3   | `feat(collab): named versions with restore and side-by-side compare`                          | 6.2      |
  | 4   | `feat(collab): share links (workspace-only or public, expiring, revocable) and public viewer` | 6.3      |
  | 5   | `feat(collab): project activity feed`                                                         | 6.4      |
  | 6   | `feat(export): standalone HTML and ZIP export`                                                | 7.1      |
  | 7   | `feat(handoff): versioned handoff bundle builder`                                             | 7.2      |
  | 8   | `test(export): visual parity tests for exported HTML`                                         | 7.1 AC   |

### Worktree: `stream-figma` (Epic 8)

- **Branch:** `feat/figma`
  | #   | Commit message                                                                | Story |
  | --- | ----------------------------------------------------------------------------- | ----- |
  | 1   | `feat(figma): plugin tokens (workspace-scoped, revocable) and settings page`  | 8.1   |
  | 2   | `feat(figma): Figma plugin scaffold that lists projects and frames`           | 8.1   |
  | 3   | `feat(figma-convert): DesignDoc to Figma node mapping with a fidelity report` | 8.2   |
  | 4   | `feat(figma): push to Figma with update-in-place via plugin data`             | 8.2   |
  | 5   | `feat(figma-convert): Figma to DesignDoc import from REST and plugin`         | 8.3   |
  | 6   | `feat(figma): token sync with Figma variables, with a diff view`              | 8.4   |

---

## Phase 2: Integration

### Worktree: `integration`

- **Branch:** `feat/integration`, from `main` after every Phase 1 branch merges.
  | #   | Commit message                                                                                              | Story     |
  | --- | ----------------------------------------------------------------------------------------------------------- | --------- |
  | 1   | `feat(db): apply schema requests from Phase 1` (only if `docs/schema-requests.md` has entries)              | —         |
  | 2   | `feat(canvas): render comment pins via the canvas overlay` (if not already wired)                           | 6.1 + 3.2 |
  | 3   | `feat(agent): run_lint uses ds-lint with a self-correction loop`                                            | 4.6 + 5.3 |
  | 4   | `feat(design-system): import from URL or screenshots as an agent job`                                       | 4.4       |
  | 5   | `feat(design-system): import from Figma variables into a draft`                                             | 4.5       |
  | 6   | `feat(export): React + Tailwind codegen job from the handoff bundle`                                        | 7.3       |
  | 7   | `feat(agent): Figma frames as prompt attachments`                                                           | 5.6 + 8.3 |
  | 8   | `feat(ops): structured logging with redaction, error tracking and alerts`                                   | 9.2       |
  | 9   | `fix(security): findings from the security review` (IDOR, CSP for frames, SSRF on URL capture, rate limits) | 9.3       |
  | 10  | `feat(ops): workspace deletion purge and retention jobs`                                                    | 9.4       |

---

## Setup

Run `scripts/setup-worktrees.sh foundation` now, and `scripts/setup-worktrees.sh phase1`
after `feat/foundation` merges. Each worktree gets its own databases (`crunch_<name>`,
`crunch_test_<name>`) and its own dev port, so sessions don't clobber each other's data.

## Merge Order

1. `feat/foundation` → `main` (before Phase 1)
2. `feat/design-system`: smallest, and it replaces the `ds-lint` stub the agent consumes
3. `feat/canvas`: implements `canvas-overlay`, which collab's pins use
4. `feat/agent`: implements `requestAgentEdit`, the job runner and the proxy
5. `feat/collab-export`
6. `feat/figma`
7. `feat/integration`

Rebase each Phase 1 branch onto `main` before merging it, and keep the atomic commits (merge or rebase; don't squash).
Expected conflicts: only `pnpm-lock.yaml`, if a stream added a dependency. Resolve with `git checkout main -- pnpm-lock.yaml && pnpm install`.

---

## Claude Code Prompts

Every prompt shares this preamble. Paste it first, followed by the stream-specific block.

```
You are working on CrunchDesign in a git worktree dedicated to one workstream. Read SPEC.md
(product spec; stories referenced by number), CLAUDE.md (conventions), and
docs/worktree-plan.md (this plan: file ownership and contracts) before starting.

## Commit discipline: important
- One atomic commit per task below, using the exact commit messages given (append the
  Co-Authored-By trailer your instructions specify).
- Each commit includes its code AND tests, and leaves `pnpm lint && pnpm typecheck && pnpm test`
  green. Never commit a broken state; if a task needs sub-steps, squash them into its commit.
- Don't push and don't open PRs: the user merges locally.

## Boundaries
- Only create or modify files your stream owns (see "File Ownership Map" in docs/worktree-plan.md).
- Never edit packages/db schema or migrations, packages/contracts, packages/authz, the editor
  shell, the workspace layout and nav, or next.config.ts. If you need a schema change, append it to
  docs/schema-requests.md and code against a temporary in-memory or JSON-column approach
  noted in that file.
- New dependencies go only in a package you own.
- This worktree has its own databases and dev port (root .env + apps/web/.env.local, created by
  scripts/setup-worktrees.sh). Never point it at another worktree's database.
```

### `foundation`

```
## Your goal
Phase 0: build Epic 2 (Stories 2.1–2.5) and the shared infrastructure every parallel stream depends
on. You own everything listed for `foundation` in the ownership map, and you may edit any existing file.
Execute Foundation commits 1–11 from docs/worktree-plan.md in order.

Key requirements:
- Commit 2: create ALL tables in SPEC §5 for Epics 2–8 (design_docs, doc_ops, doc_versions,
  design_system_versions, comments, comment_threads, share_links, assets, agent_conversations,
  agent_messages, jobs, job_events, llm_calls, edit_locks, figma_links, plugin_tokens, activity).
  Think through each Phase 1 stream's stories so they don't need new columns. Spend time here.
- Commits 3–4: DesignDoc per SPEC §5. The StyleProps allowlist must cover what Tailwind can express.
  Ops are pure and Zod-validated, with inverses and transactions. Use fast-check property tests.
- Commits 5–7: the DOM renderer and the static HTML renderer must produce identical markup and CSS.
  Token references become CSS variables. Breakpoints are mobile-first (base/md/lg).
- Commit 8: ops are appended to doc_ops and compacted into design_docs snapshots; a stale version
  is rejected; enforce design:edit for writes and project:read for reads.
- Commit 9: the contracts listed under "Contracts (commit 9)", each with a documented interface and a no-op stub.
- Commit 10: an editor shell with three panes (chat / canvas / inspector) whose contents are
  imported from src/features/<stream>/index.tsx stubs, plus nav items and stub pages for design
  systems, usage and Figma settings. The doc store (zustand + immer) applies ops, handles undo
  and redo (Story 3.7: one transaction is one step), persists through commit 8's API, and is
  read-only for viewers.
- Commit 11: the dependency list from the plan, package skeletons, transpilePackages.

## Done when
Every Foundation commit is made; the editor page renders a seeded sample DesignDoc; full
lint/typecheck/test/build is green; `git log --oneline` shows 11 clean commits.
```

### `stream-canvas`

```
## Your goal
Epic 3: the WYSIWYG canvas (SPEC Stories 3.0–3.10, except 3.7, which lives in the foundation doc store).
Execute the stream-canvas commits from docs/worktree-plan.md in order. Commit 1 is a
time-boxed spike: build both options under packages/canvas/spike, benchmark as Story 3.0 says,
write docs/adr/0001-canvas.md, and delete the spike code in the same commit, keeping only the ADR.
Every canvas edit goes through doc-store ops (zero LLM calls). Implement the canvas-overlay contract
in commit 3. Respect viewer read-only mode, and the edit lock from commit 8 onward.
```

### `stream-agent`

```
## Your goal
Epic 5: the agent (SPEC Stories 5.1–5.13; 5.7 is backend only). Execute the stream-agent commits
in order. Load the claude-api skill before writing Claude API code. The Claude Agent SDK is for
sandbox jobs; check its docs at code.claude.com/docs/en/agent-sdk.
Hard rules: real provider credentials never enter a sandbox (the sandbox gets ANTHROPIC_BASE_URL
pointing at /api/llm and a short-lived job token); every model call goes through the proxy and is
recorded in llm_calls; agent edits are DesignDoc op transactions attributed to the agent; the
interactive path patches only the nodes it touches. The prefix (system prompt, tools, design system)
must be byte-stable for caching. Use loadWorkspaceClient() and MODEL_TIERS / providerModelId()
from Epic 1. Consume the ds-lint contract through its interface (it's still a stub until the
design-system stream merges).
```

### `stream-design-system`

```
## Your goal
Epic 4's local parts: Stories 4.1, 4.2, 4.3 and 4.6. 4.4 and 4.5 are deferred to integration.
Execute the stream-design-system commits in order. Token and component types come from
@crunch/doc-model; preview rendering uses @crunch/renderer. Commit 5 replaces the ds-lint stub
with a real deterministic linter (literals that should be tokens, off-scale spacing, WCAG AA
contrast via culori) behind the exact contract interface in packages/contracts.
```

### `stream-collab-export`

```
## Your goal
Epic 6 (Stories 6.1–6.4), the comment UI for 5.7, and the deterministic exports of Epic 7
(7.1, 7.2). Execute the stream-collab-export commits in order. Comment pins anchor to nodes through
the canvas-overlay contract. Ask-agent comments call requestAgentEdit (a stub until the agent stream
merges; show a "not available yet" state for now). Viewers can't comment
(design:comment) but can export (export:deterministic). Public share links expose only the
rendered design, with no workspace data, and are rate-limited. Exported HTML comes from
@crunch/renderer's static renderer. Prove visual parity with Playwright screenshot diffs.
```

### `stream-figma`

```
## Your goal
Epic 8 (Stories 8.1–8.4). Execute the stream-figma commits in order. Figma's REST API can't create
nodes, so all writes into Figma happen in the plugin (apps/figma-plugin, built with esbuild, typed
with @figma/plugin-typings). The plugin authenticates to our API with a workspace-scoped plugin
token (hashed at rest, revocable). Flow layout maps to auto-layout; tokens map to variables;
NodeId is stored in plugin data so pushing again updates in place. Import is a one-shot lossy
conversion with a fidelity report. Put conversion logic in packages/figma-convert as pure
functions with fixture tests.
```

### `integration`

```
## Your goal
Phase 2: wire the parallel streams together and finish Epic 9. Every Phase 1 branch is merged
into main. Execute the integration commits in order; skip commit 1 or 2 if there's nothing to do.
Before commit 9, run the security-review skill over the whole codebase and fix the findings in that commit.
```
