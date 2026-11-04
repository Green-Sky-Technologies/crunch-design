# Project: CrunchDesign — AI Design Canvas

> **Handoff brief for Claude Code.** A web app that pairs a conversational agent
> with a WYSIWYG design canvas of live HTML frames. Teams describe a design, the
> agent builds it on the canvas, and they refine it through chat, inline comments,
> direct manipulation, and agent-generated sliders. Designs are built against a
> persistent design system and exported to code (React + Tailwind) and to Figma.
>
> Written as epics + user stories with acceptance criteria (AC). Work top to
> bottom; each epic is independently demoable. The original brief is preserved in
> `SPEC.v0.md`. Decisions made during refinement are logged in §9.

---

## 0. Context & Purpose

**Core loop:** describe → agent generates → refine (chat · inline comment ·
direct edit · slider) → export (code / Figma / HTML / share link).

**Why web:** fastest iteration, single rendering engine target (the browser).
No desktop shell, no PWA concerns in v1.

**Non-goal:** cloning any product's visual identity or branding. We replicate the
*interaction model and feature set*, not the trade dress.

**Out of scope for v1** (see §8 for the deferred list): real-time multiplayer,
two-way live Figma sync, non-Claude model providers, billing, mobile app,
PDF/PPTX/Canva/Google Slides export, GitHub PR export, document (DOCX/PDF/XLSX)
inputs, design-system import from a code repo.

---

## 1. Target Stack (decided)

| Layer | Choice | Notes |
|---|---|---|
| Frontend | **Next.js (React + TS)** on **Vercel** | Evergreen Chromium, Firefox, Safari. |
| Canvas | **tldraw SDK** hosting custom "frame" shapes — spike vs. custom (Story 3.0) | tldraw provides pan/zoom/arrange; frame contents are our own DOM renderer. |
| Design document | **Structured JSON doc tree** (`DesignDoc`) | The single source of truth. HTML is *rendered from* it, never parsed back. |
| App auth | **Clerk** (Organizations = Workspaces) | Email, Google, GitHub. Roles: Admin / Editor / Viewer. |
| Database | **Neon Postgres** (Vercel Marketplace) + **Drizzle ORM** | Neon branch per preview deploy. |
| Assets | **Vercel Blob** | Uploads, screenshots, thumbnails, export ZIPs. |
| Interactive agent | **Anthropic TS SDK (Messages API + tool use)** in Vercel Functions | Quick edits: chat tweaks, inline comments. Streams over **SSE**. |
| Long-running agent | **Claude Agent SDK** in **Vercel Sandbox** | Full generation, redesign, DS import, web capture, code export, Figma export. |
| Model access | **BYOK, Claude routes only** | Anthropic API, Amazon Bedrock, Google Vertex AI, Azure AI Foundry. Workspace-level credentials. |
| Figma | **CrunchDesign Figma plugin** + Figma REST API (read) | The plugin is the only way to write nodes into Figma. |
| Infra as code | **OpenTofu** | Vercel, Neon, Clerk config, and any future AWS resources. |
| Monorepo | **pnpm + Turborepo** | `apps/web`, `apps/figma-plugin`, `packages/doc-model`, `packages/renderer`, `packages/agent-tools`, `packages/sandbox-runner`. |

### Architecture shape
```
Browser (Next.js: chat · canvas (tldraw + frame renderer) · inspector)
   │  REST/Server Actions (CRUD)      SSE (agent + job streams)
   ▼
Vercel Functions (Node/TS)
   ├── Clerk auth, workspace/role checks
   ├── Projects · DesignDocs · Design Systems · Comments  → Neon Postgres
   ├── Assets                                             → Vercel Blob
   ├── Interactive agent (Messages API + tools)  ──┐
   ├── LLM proxy (key injection, metering, caps) ◄─┼── all model calls go through here
   └── Job API (create / status / events)          │
          │                                        │
          ▼                                        │
   Vercel Sandbox (one per job)                    │
      └── Claude Agent SDK ── ANTHROPIC_BASE_URL ──┘ (short-lived job token, never the real key)
          └── agent tools → call back to Job API to apply DesignDoc patches
                                                   ▼
                     Anthropic API · Bedrock · Vertex · Foundry (workspace BYOK)
Figma (CrunchDesign plugin) ── REST, plugin token ──► Vercel Functions
```

### Known risks (read before starting)
1. **DOM-on-canvas performance.** Many live HTML frames inside a zoomable canvas
   can get heavy. → Story 3.0 spike, Story 3.10 perf budget.
2. **Canvas ↔ code round-trip.** DesignDoc is the source of truth; code and Figma
   are *outputs*. Never parse code back in. Figma *import* is a one-shot lossy
   conversion, not a sync. → Epics 2, 7, 8.
3. **Credential exposure in sandboxes.** Agent jobs run tools that touch untrusted
   content (web capture, screenshots). Real provider keys never enter the sandbox;
   all model traffic goes through the LLM proxy. → Story 5.2.
4. **Auth/ToS.** Claude subscription login is not permitted for third-party apps;
   BYOK via permitted routes only. → §3.
5. **Unit economics.** Output tokens dominate cost. → §2.
6. **Prompt-cache TTL.** A 5-minute default TTL means pausing users get cache
   misses. → Story 5.11.
7. **Browser compatibility.** Chromium, Firefox, Safari. → Story 3.9.
8. **Vercel Hobby plan is non-commercial.** Fine for development. Production needs Pro.

---

## 2. Cost Architecture

**These are design constraints, not optimizations.** Users pay model costs through
their own keys, so wasting their tokens is a product defect.

1. **Canvas interactions never call the LLM.** Drag, resize, inspector edits,
   token changes, and slider moves mutate the DesignDoc locally. Zero tokens.
2. **Stable cacheable prefix.** System prompt + tool definitions + active design
   system are serialized deterministically (stable key order, no timestamps) and
   marked for prompt caching.
3. **Surgical edits.** The agent patches changed nodes through `patch_nodes` and
   similar tools; it never re-emits the whole document for a local change. Context
   sent to the model is the *relevant subtree* plus a compact outline of the rest.
4. **Full generation is rare and user-initiated.** Only explicit "generate",
   "redesign", or "show N alternatives" requests start a generation job.
5. **Code and Figma export happen on demand,** never on every edit.
6. **Tiered model defaults, user-overridable** (Story 5.9): Opus-class for
   generation/redesign/codegen, Sonnet-class for interactive edits, Haiku-class
   for cheap utility calls (titles, summaries, lint explanations).

**Honest caveat:** caching saves a modest share per turn, because output dominates.
The real lever is *not regenerating* (principles 1, 3, 4). Measure everything
(Story 5.10): tokens in/out, cache read/write, and estimated cost per call, job,
member, and workspace.

> Check current model pricing in Anthropic's docs when building the cost estimator;
> do not hard-code prices from this spec.

---

## 3. Auth & Credentials Model

**App auth:** Clerk. A Clerk Organization = a CrunchDesign **Workspace**.
Roles: **Admin** (members, credentials), **Editor** (edit designs, comment, run
the agent), **Viewer** (strictly view-only: no edits, comments, sliders, or agent;
can run **deterministic exports**: HTML/ZIP, handoff bundle, open share links).
LLM-backed exports (React + Tailwind codegen, Figma push) require Editor, since
they spend the workspace key.

**Model credentials:** BYOK, **workspace-level only** (no personal keys in v1).
- Supported routes: Anthropic API key · Amazon Bedrock · Google Vertex AI · Azure
  AI Foundry.
- Bedrock: prefer **cross-account IAM role assumption** (role ARN + external ID
  that we generate) over static access keys. Static keys are allowed as a fallback.
- Vertex: service-account JSON or Workload Identity Federation.
- Stored with **envelope encryption** (per-record data key, AES-256-GCM, master key
  in a secret manager/env). Never logged, never returned to the client (only
  the last 4 characters plus provider and status), never placed in a sandbox.
- **No spend caps during beta.** Usage is still metered per member and workspace
  (Story 5.10) so caps can be added later without schema changes.

**Policy:** Anthropic does not allow third-party products to offer claude.ai login
or subscription rate limits, including agents built on the Claude Agent SDK.
OAuth tokens from Free/Pro/Max accounts are never accepted.

**Billing for CrunchDesign itself:** none in v1 (**free beta**). Instrument usage
so pricing can be decided later.

---

## 4. Interaction Model

**Layout:** conversation panel (left) · canvas (center) · inspector (right,
contextual). Top bar: project and frame navigation, breakpoint switcher, share,
export, presence avatars, edit-lock status.

**Four refinement modes:**
1. **Chat:** broad changes ("darker scheme", "show 3 alt layouts").
2. **Inline comments:** pin a comment to an element. Either a human comment thread
   or "Ask agent" for a targeted, surgical change to that node.
3. **Direct edits:** select, drag, resize, edit text, and edit any style prop in
   the inspector. Flow-first drag with absolute positioning as an opt-in.
4. **Sliders:** agent-generated controls bound to props or tokens, applied live
   at zero token cost.

**Concurrency:** async teams with a **soft lock**. One Editor holds the edit lock
per project; others view and comment and can request control. The agent acts only
on behalf of the lock holder.

---

## 5. Data Model (sketch)

> **Implemented in Epic 2.** The authoritative definitions are now code: `packages/doc-model`
> (DesignDoc, style allowlist, tokens, design-system spec, ops), `packages/db/src/schema/*`
> (tables) and `packages/contracts` (cross-stream interfaces). Where this sketch and the code
> differ, the code wins. Notable differences: the design system is linked from the project
> row, not the doc; docs carry `tokenOverrides`; and there are 15 op types (see `ops/types.ts`).

```ts
// packages/doc-model
type NodeId = string;              // stable nanoid; also used as the Figma plugin-data key
type Breakpoint = 'base' | 'md' | 'lg';   // base = mobile-first; maps to Tailwind prefixes

interface DesignDoc {
  id: string; projectId: string; version: number;
  designSystemId: string; designSystemVersion: number;
  frames: Frame[];                 // artboards on the canvas
  nodes: Record<NodeId, Node>;     // normalized node store
  sliders: Slider[];
}

interface Frame { id: string; name: string; rootNodeId: NodeId;
  canvas: { x: number; y: number }; width: number; previewBreakpoints: Breakpoint[]; }

interface Node {
  id: NodeId;
  type: 'box' | 'text' | 'image' | 'svg' | 'instance';   // instance = DS component
  name?: string;
  parentId: NodeId | null; children: NodeId[];
  positioning: 'flow' | 'absolute';
  style: Partial<Record<Breakpoint, StyleProps>>;          // base + overrides
  props?: Record<string, unknown>;                         // text content, src, alt, component props
  componentRef?: { componentId: string; variant?: string };
}

// A StyleProps value is either a literal or a token reference, e.g.
//   { color: { token: 'color.primary' } } | { color: '#1a1a1a' }
// The allowed StyleProps keys are an explicit allowlist that covers what Tailwind can express
// (layout, flex/grid, spacing, sizing, typography, color, border, radius, shadow, opacity, transform).

interface Slider { id: string; label: string; min: number; max: number; step: number;
  value: number; bindings: Array<{ target: { nodeId: NodeId; prop: string; breakpoint: Breakpoint }
                                   | { token: string };
                                   map: 'linear' | { stops: [number, string | number][] } }>;
  pinned: boolean; }
```

**Patch ops** (`packages/doc-model/ops`): `insertNode`, `removeNode`, `moveNode`,
`setStyle`, `setProps`, `setToken`, `insertFrame`, `upsertSlider`, and so on.
Every mutation (human, agent, or slider) is an op. Ops are validated by a Zod schema,
applied by a pure reducer, inverted for undo, and batched into transactions. **The
agent's tools emit the same ops.**

**Postgres tables (initial):** `workspaces` (mirrors Clerk org), `members`,
`provider_credentials`, `spend_caps`, `projects`, `design_docs` (current snapshot
+ version), `doc_ops` (append-only log), `doc_versions` (auto and named
snapshots), `design_systems`, `design_system_versions`, `comments`,
`comment_threads`, `share_links`, `assets`, `agent_conversations`,
`agent_messages`, `jobs`, `job_events`, `llm_calls` (usage metering),
`edit_locks`, `figma_links`.

---

## 6. Epics & Stories

### Epic 1 — Foundation & Workspaces
*Demo: sign up, create a workspace, invite a teammate, add a Claude credential,
create an empty project.*

- **1.1 Monorepo scaffold.** pnpm + Turborepo, TS strict, ESLint/Prettier, Vitest,
  Playwright. AC: `pnpm dev` runs the web app; CI runs lint, typecheck and tests on PRs.
- **1.2 Infra as code.** OpenTofu for the Vercel project and env vars, Neon project
  and branches, Blob store. AC: `tofu apply` recreates staging from scratch; every
  preview deploy gets its own Neon branch.
- **1.3 Clerk auth + workspaces.** Clerk Organizations mapped to workspaces;
  a webhook syncs orgs and members into Postgres. AC: Admin/Editor/Viewer enforced
  server-side on every route; a user without a workspace is guided to create or join one.
- **1.4 Provider credentials.** An Admin adds, tests, rotates and removes one
  credential per workspace (Anthropic / Bedrock role / Vertex / Foundry). AC:
  envelope-encrypted at rest; a test-connection call succeeds or shows a provider
  error; the secret is never returned to the client or written to logs (covered by tests).
- **1.5 Spend caps — deferred (beta).** Keep a no-op `checkBudget()` hook in the
  LLM proxy so caps can be enabled later.
- **1.6 Projects CRUD.** Create, rename, duplicate, archive and list, with thumbnails.
  AC: Viewers can't create or edit; every project is linked to a design system (default
  system created per workspace).

### Epic 2 — Document Model & Renderer
*Demo: a hand-written DesignDoc JSON renders as live frames that match a
reference HTML page at all breakpoints.*

- **2.1 DesignDoc schema + ops.** Zod schemas, pure reducer, inverse ops,
  transactions. AC: property-based tests show `apply(op); apply(inverse(op))` is
  the identity; unknown style keys are rejected.
- **2.2 Token resolution.** A design system compiles to CSS custom properties;
  token references render as `var(--…)`. AC: changing one token re-renders every
  frame using it without remounting the whole tree.
- **2.3 Frame renderer.** Renders a frame's subtree to DOM inside a style-isolated
  container (Shadow DOM, or an iframe if the 3.0 spike says so). AC: style isolation
  from the app chrome; incremental re-render (a changed node re-renders only its subtree).
- **2.4 Breakpoint overrides.** Mobile-first base styles plus `md`/`lg` overrides. AC:
  a frame previews at each breakpoint width; the inspector shows which breakpoint
  a value is set on and which it inherits from.
- **2.5 Persistence.** Ops are debounced to the server, appended to `doc_ops`,
  snapshot compacted. AC: reload restores the exact state; a version conflict
  (stale lock) is rejected, not silently merged.

### Epic 3 — Canvas & Direct Editing (WYSIWYG)
*Demo: select any element, drag to reorder, resize, edit text and every CSS
property in the inspector, undo and redo, no LLM calls.*

- **3.0 Spike: tldraw vs. custom canvas** (time-box: 3 days). Build a canvas with
  20 live frames of ~300 nodes each in both (a) tldraw custom shapes and (b) a
  custom CSS-transform pan/zoom surface. Measure FPS during pan/zoom, selection
  latency, and memory in Chromium, Firefox and Safari. Also compare Shadow DOM and
  iframe frame containers. AC: written decision record in `docs/adr/0001-canvas.md`.
- **3.1 Frames on canvas.** Add, move, resize (width), rename and duplicate frames;
  pan and zoom; minimap. AC: 60fps pan/zoom at the 3.0 benchmark size on a mid-range laptop.
- **3.2 Selection overlay.** Click to select a node inside a frame, Shift for
  multi-select, Esc/Enter to move up or down the tree, hover outlines, a layers panel
  mirroring the tree. AC: the overlay stays correct across zoom levels and breakpoints.
- **3.3 Inspector.** Grouped fields: layout (flex/grid, gap, align), spacing,
  size, typography, fill, border, radius, shadow, opacity, transform, positioning.
  Every field accepts a literal or a token (picker). AC: every allowlisted
  StyleProp is editable; edits apply in under 16ms and are a single undo step per gesture.
- **3.4 Flow-first drag & drop.** Dragging reorders within a flex/grid parent or
  reparents into another container, with drop indicators. Holding a modifier or
  toggling "absolute" enables free x/y placement. AC: the result is valid flow CSS;
  absolute nodes keep their position relative to the nearest positioned ancestor.
- **3.5 Resize handles & smart guides.** Resizing sets width/height (fixed, fill
  or hug, like auto-layout); spacing guides and snapping. AC: hug/fill map to the
  Tailwind sizing equivalents on export.
- **3.6 Inline text editing.** Double-click to edit text in place. AC: IME and
  emoji safe; Esc cancels; formatting is limited to the node's text style.
- **3.7 Undo/redo.** Session history over ops, including agent transactions
  (one agent turn = one undo step). AC: Cmd/Ctrl+Z works across human and agent edits.
- **3.8 Edit lock & presence.** A soft lock per project with heartbeat and timeout;
  avatars show who's viewing; "request control" notifies the holder; Admins can
  take over. AC: a non-holder's canvas is read-only with comments enabled; a lock
  expires 2 minutes after the holder's tab dies.
- **3.9 Browser compatibility.** Playwright suite on Chromium, Firefox and WebKit
  covering select, drag, resize, inspector and text editing. AC: green on all three in CI.
- **3.10 Performance budget.** AC: under 100ms to first interactive frame after
  project load for a 10-frame project; no long tasks over 50ms during drag.

### Epic 4 — Design Systems
*Demo: create a system manually, import one from a URL, publish it, and see a
project pick it up.*

- **4.1 Design-system editor.** Tokens (color, typography, spacing, radius,
  shadow, breakpoints) and components (named DesignDoc subtrees with props and
  variants). AC: a live preview page renders every token and component.
- **4.2 Draft / Published versions.** Projects pin a published version; an upgrade
  prompt appears when a newer one is published. AC: editing a draft never changes
  existing projects.
- **4.3 Multiple systems per workspace.** AC: a project can switch systems, with a
  preview of what will change.
- **4.4 Import from URL / screenshots** (Agent SDK job). Capture the page (headless
  browser in the sandbox) or analyze uploaded screenshots, then propose tokens and
  candidate components for review. AC: nothing is saved until the user accepts the
  proposal; the proposal shows its sources.
- **4.5 Import from Figma variables.** Via Epic 8 token sync. AC: token names and
  modes map deterministically (light/dark modes become theme variants).
- **4.6 Design-system lint + agent self-check.** A deterministic linter flags
  literal values that should be tokens, off-scale spacing, and contrast failures
  (WCAG AA). The agent runs the linter after each edit and self-corrects up to N
  times. AC: lint runs locally on every edit (zero tokens); the agent loop uses the
  same lint output.

### Epic 5 — Agent
*Demo: "Design a pricing page" produces a multi-frame design via a background
job; "make this button larger" via an inline comment patches one node.*

- **5.1 Job runner on Vercel Sandbox.** `packages/sandbox-runner` behind a
  `JobRunner` interface (to allow a future Fargate implementation). Lifecycle:
  queued → provisioning → running → succeeded / failed / cancelled. Progress events
  go to `job_events`; the client streams them over SSE with resume (`Last-Event-ID`).
  AC: the user can close the tab and come back to see progress or results; cancel
  stops the sandbox; timeouts and retries are configurable; orphaned sandboxes are
  reaped.
- **5.2 LLM proxy.** All model calls (interactive and sandbox) go through
  `/api/llm`. Sandboxes get `ANTHROPIC_BASE_URL` plus a short-lived, job-scoped
  token. The proxy resolves the workspace credential, routes to the right provider
  (Anthropic / Bedrock / Vertex / Foundry), calls the (no-op in beta) budget hook, and records usage in
  `llm_calls`. AC: a test proves the real key never appears in the sandbox env or
  filesystem; a revoked job token is rejected immediately.
- **5.3 Agent tools** (`packages/agent-tools`). Shared by both runtimes:
  `get_outline`, `get_subtree`, `patch_nodes` (ops), `insert_frame`,
  `create_slider`, `get_design_system`, `run_lint`, `screenshot_frame`,
  `capture_url` (sandbox only), `get_figma_frame`. AC: every tool validates inputs
  with Zod; patches are applied server-side as a transaction attributed to the agent.
- **5.4 Interactive agent path.** Messages API + tool use in a Vercel Function,
  streaming SSE to the chat panel. Used for chat tweaks and inline-comment asks.
  AC: a one-node change emits a patch touching only that node (verified by an eval);
  if the request is too big for the interactive path, the agent offers to start a
  generation job instead.
- **5.5 Generation jobs.** Agent SDK in the sandbox for "generate", "redesign" and
  "N alternatives". The agent writes frames incrementally, and they appear on the
  canvas as they're built. AC: alternatives land as sibling frames; the
  job summary lists what was created.
- **5.6 Chat panel.** Conversation per project, streaming, tool-activity
  indicators, cancel, retry, and job cards with progress. AC: messages persist; the
  attachments are images, a URL to capture, or a Figma frame link.
- **5.7 Inline "ask agent" comments.** Pin a comment to a node and ask the agent.
  The request carries that node's subtree and design-system context only. AC: the
  resulting patch is scoped to that subtree unless the user approves a wider change.
- **5.8 Sliders.** The agent proposes sliders bound to props or tokens (e.g.
  "density" controls padding and gap). They render in a slider tray; dragging applies
  ops locally (zero tokens); sliders can be pinned, renamed and deleted. AC: slider
  changes are undoable as one step per drag.
- **5.9 Model picker.** Defaults by task (Opus-class: generation, codegen;
  Sonnet-class: interactive; Haiku-class: utilities), overridable per prompt; Admins
  set workspace defaults and an allowed-model list. AC: the picker shows the
  estimated relative cost.
- **5.10 Usage instrumentation.** Per call: model, tokens in/out, cache read/write,
  latency, estimated cost, task type. Dashboards per workspace and member. AC: the
  cache hit rate is visible; costs reconcile with provider usage within ±5%.
- **5.11 Cache TTL strategy.** Deterministic prefix serialization; use the 1-hour
  cache TTL for the DS + tools prefix when the session is active (measure write cost
  against miss rate); optionally re-warm on editor focus after idle. AC: a decision
  backed by measured hit-rate data, documented in an ADR.
- **5.12 Auto snapshots.** A snapshot is taken before every agent transaction;
  "Revert agent change" appears on each agent message. AC: one-click restore, which is itself undoable.
- **5.13 Agent eval suite.** Golden prompts → assertions (lint-clean, patch scope,
  token usage within budget). AC: runs in CI on demand and tracks regressions per
  model.

### Epic 6 — Collaboration, Versions & Sharing
*Demo: a teammate leaves comments, the owner names a version, and shares a public
view-only link.*

- **6.1 Comment threads.** Pinned to node or canvas position; replies, resolve,
  @mentions (in-app notifications; email digests later). AC: comments survive node
  moves; if a node is deleted, its comments become orphaned but stay visible.
- **6.2 Named versions.** Save, restore and compare (side-by-side visual diff of
  frames). AC: restoring creates a new version and never destroys history.
- **6.3 Share links.** Workspace-only by default; an Editor can make a link public
  (view-only), with optional expiry and revoke. AC: public view needs no auth,
  leaks no workspace data beyond the design, and is rate-limited.
- **6.4 Activity feed.** Who changed what (human vs. agent), per project.

### Epic 7 — Export & Code Handoff
*Demo: download a ZIP of standalone HTML; run code export and get a
React + Tailwind project that matches the canvas.*

- **7.1 Standalone HTML/CSS + ZIP.** Deterministic export from the DesignDoc (no
  LLM). AC: opens offline and is visually identical to the canvas at each breakpoint
  (Playwright screenshot diff under a threshold).
- **7.2 Handoff bundle.** Versioned JSON: DesignDoc subset, resolved tokens,
  component inventory, per-frame screenshots, design intent notes (from the chat
  history, summarized), and responsive rules. AC: a documented schema; a code agent
  can consume it in one instruction ("implement `handoff.json`").
- **7.3 React + Tailwind codegen** (Agent SDK job). A deterministic pre-pass maps
  styles → Tailwind classes and tokens → `tailwind.config` theme; the agent then
  extracts components, names things well, and adds props and states. AC: output builds
  (`pnpm build`) in the sandbox before delivery; a screenshot diff against the canvas
  stays under a threshold; delivered as a ZIP.

### Epic 8 — Figma Integration
*Demo: push a design to Figma with the plugin, edit in CrunchDesign, push again (updates in
place); import a Figma frame; sync tokens with Figma variables.*

- **8.1 Figma plugin scaffold** (`apps/figma-plugin`). The user pastes a plugin token
  generated in CrunchDesign (scoped to a workspace, revocable). AC: the plugin lists
  the user's projects and frames.
- **8.2 Push to Figma.** Builds frames with auto-layout (flow → auto-layout;
  absolute → absolute), text styles, fills, strokes, effects; tokens → Figma
  variables; DS components → Figma components. Each Figma node stores the
  CrunchDesign `NodeId` in plugin data. AC: pushing again updates matched nodes in
  place and only creates or removes the difference; a mapping report lists anything
  that couldn't be represented.
- **8.3 Import from Figma.** Paste a file or frame URL (Figma REST API, with a
  user-provided Figma token or OAuth), or send it from the plugin. Auto-layout → flow, styles
  → StyleProps, matching variables → tokens, complex vectors → SVG nodes. AC:
  one-shot conversion with a fidelity report; imported frames can also be used
  as prompt reference (5.6).
- **8.4 Token sync with Figma variables.** Through the plugin (works on all Figma
  plans): pull variables into a DS draft, or push DS tokens to variables. A diff
  view before applying, in either direction. AC: conflicts are shown, never auto-resolved.

### Epic 9 — Operations & Security
- **9.1 Environments.** Preview (per PR), staging, production, all in OpenTofu.
- **9.2 Observability.** Structured logs (with secret redaction), error tracking,
  job and LLM dashboards, alerts on job failure rate and proxy errors.
- **9.3 Security review.** Authorization tests for every route (IDOR), CSP for
  rendered frames (no script execution in user designs; sanitize URLs and SVG),
  SSRF protection for URL capture, rate limits, plugin-token scoping.
- **9.4 Data lifecycle.** Workspace deletion purges DB rows, Blob assets and
  credentials; snapshot retention policy.

---

## 7. Suggested Build Order
1. Epic 1 (1.1–1.3) → Epic 2 → **Story 3.0 spike** → rest of Epic 3. A fully usable
   manual editor with no AI is the first milestone.
2. Epic 4 (4.1–4.3, 4.6 lint).
3. Epic 5: 5.2 proxy → 5.3 tools → 5.4 interactive → 5.1 job runner → 5.5 generation.
4. Epic 6, Epic 7, Epic 8, then 4.4/4.5 imports.
5. Epic 9 runs throughout; 9.3 is required before any public beta.

---

## 8. Deferred (post-v1)
Real-time multiplayer · two-way live Figma sync · OpenAI and other non-Claude
providers · personal keys · CrunchDesign billing and plans · PDF/PNG/PPTX/Canva/Google
Slides export · GitHub PR export into existing repos · DS import from a code repo ·
DOCX/PDF/XLSX inputs · branching versions · PWA and mobile surfaces · moving the job
runner to AWS Fargate (only if scale demands it).

---

## 9. Decision Log
| # | Decision | Rationale |
|---|---|---|
| D1 | Live HTML frames from a JSON doc tree, not a vector scene graph | Matches the LLM's strongest output format and code handoff; WYSIWYG still possible (Framer/Webflow model). |
| D2 | Flow-first drag + absolute opt-in | Keeps exports responsive, real CSS. |
| D3 | Async teams, soft lock + presence | No merge conflicts; the agent acts for one editor. |
| D4 | Vercel-first; OpenTofu for IaC | Single platform; AWS only if a workload demands it. |
| D5 | Split agent runtime: Messages API (interactive) + Agent SDK in Vercel Sandbox (long jobs) | Fast and cheap small edits; Agent SDK for long multi-step jobs. Sandbox costs ~cents per job. |
| D6 | SSE instead of WebSockets | Vercel Functions don't hold WebSockets; SSE with resume suffices. |
| D7 | Clerk, Orgs = Workspaces | Fast to ship; roles built in. |
| D8 | BYOK, workspace key only, Claude routes only | Clean economics; one model family to tune. |
| D9 | LLM proxy; real keys never enter sandboxes | Prompt-injection safety, metering, caps. |
| D10 | Free beta, no billing in v1 | Gather real usage data first. |
| D11 | Export v1: share link, HTML/ZIP, handoff bundle, React + Tailwind | Highest value, lowest cost. |
| D12 | Figma v1: plugin push (update in place), import, variable sync; no live two-way sync | REST API can't write nodes; two-way merge is too risky for v1. |
| D13 | User-picked model with task-based defaults | Users control cost/quality. |
| D14 | Auto snapshots before agent edits + named versions | One-click "undo the AI". |
| D15 | Breakpoint overrides in one tree | Maps to Tailwind responsive prefixes. |
| D16 | Sliders bound to props/tokens, persistent | Zero-token tuning. |
| D17 | Viewers are view-only + deterministic export | Viewers never mutate designs or spend the workspace key. |
| D18 | No spend caps in beta; metering only | Keep beta friction-free; caps added later via the budget hook. |

## 10. Open Questions
1. Figma plugin distribution: publish to the Figma Community, or private/dev install for beta?
2. Retention period for `doc_ops` and auto snapshots?
3. Domain, product name check, and analytics tool choice.
