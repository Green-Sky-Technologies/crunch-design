# Project: CrunchDesign — AI Design Canvas

> **Handoff brief for Claude Code.** A web application that pairs a conversational
> agent with an interactive design canvas, inspired by the interface of the (now
> folded-into-Claude) standalone design surface. Written as epics + user stories
> with acceptance criteria. Work top to bottom; each epic is independently demoable.

---

## 0. Context & Purpose

We are building a **web app** that pairs **a conversational agent** with **an
interactive design canvas**. The user describes a design in natural language, the
agent generates a working design on the canvas, and the user refines it via chat,
inline comments, direct on-canvas manipulation, and generated control sliders.
Designs are built against a persistent **design system** (brand tokens +
components) and can be handed off to a code agent for implementation.

**Why a web app (not desktop):** faster iteration cycles. We deliberately chose the
web over Tauri to avoid cross-WebView rendering divergence and native sidecar
packaging. A PWA can be layered on later for offline/installability without
changing the architecture. **Build web-first; do not add PWA concerns in v1.**

**Non-goal:** pixel-perfect cloning of any specific product's visual identity or
branding. We replicate the *interaction model and feature set*, not the trade dress.

---

## 1. Target Stack (decided)

| Layer | Choice | Notes |
|---|---|---|
| Frontend | **React + TypeScript** | Single target: modern evergreen browsers. |
| Canvas | **tldraw SDK** (primary) — spike vs. custom **Konva** | See Epic 3, Story 3.0 spike. |
| Agent | **Claude Agent SDK** | Runs **server-side** in the backend; streams to the client. |
| Backend | **Node + TypeScript** | Hosts the Agent SDK; auth, projects, streaming. |
| Persistence | **Postgres** + object storage for assets | |
| Deploy | Static frontend + containerized agent service | See Epic 6. |

### Architecture shape
```
Browser (React + canvas)
   │  REST (CRUD) + WebSocket (agent stream)
   ▼
Node/TS backend
   ├── Auth (BYOK key storage, encrypted)
   ├── Projects + design-system CRUD  → Postgres
   ├── Asset storage → object store
   └── Agent service → Claude Agent SDK (TS) → Claude API
```

### Known risks (read before starting)
1. **Agent is a server process.** Host it, stream output to the client, manage its
   lifecycle. → Epic 5, Story 5.1; Epic 6, Story 6.1.
2. **Canvas ↔ code round-tripping** is the hardest problem in the project. Treat
   the design document as the single source of truth and generate code *from* it;
   do not try to parse code back into the canvas. → Epic 4.
3. **Auth/ToS.** Subscription login is **not permitted**; BYOK only. → Auth section.
4. **Unit economics.** Output-dominated cost; requires the Cost Architecture
   principles. → Cost Architecture section.
5. **Cache TTL.** 5-minute prompt-cache expiry causes misses for interactive users.
   → Story 5.11.
6. **Browser compat (reduced).** Verify Chromium, Firefox, Safari. → Story 3.9.

---

## 2. Cost Architecture

**These are design constraints, not optimizations. Violating them breaks the unit
economics.**

Claude-Design-class generation runs on Opus-tier models ($4–5/MTok input,
$20–25/MTok output). Real-world signals: a reviewer spent **$20 of credits in 5
minutes**; Max-5x users report **two projects exhausting a week's allowance**; Pro
users report **hitting limits after 3–4 prompts**. Output is priced **5× input**, so
**generation output dominates cost** — not context.

Five principles:

1. **Canvas interactions never call the LLM.** Drag, resize, recolor, and slider
   changes mutate the document model locally. Zero tokens. *(If the canvas
   re-rendered React on every drag, every pixel nudge would cost Opus rates. It
   must not.)*
2. **The design system is a cached prefix.** System prompt + design system + tool
   defs sit in a stable, cacheable prefix (~90% off that portion via cache reads at
   $0.20/MTok).
3. **Agent edits are surgical.** The agent patches the *changed element*, not the
   whole design. A one-element change must not regenerate the page.
4. **Full generation is rare and user-initiated.** Only on explicit "generate" /
   "redesign" requests.
5. **Code generation happens on export/handoff**, not on every edit.

**Honest caveat:** caching saves roughly **~20% per turn**, not 90% — because the
design system is only part of the input, and input is only part of the cost. The
*real* lever is **not regenerating** (principles 1, 3, 4). Caching is a multiplier
on top.

**Caching mechanics:** prompt cache TTL is **5 minutes** (1-hour option costs more
to write). Interactive users who pause between edits will hit cache misses.
**Measure cache hit rate.**

---

## 3. Auth Model

**Finding (from Anthropic's docs, verbatim):**
> "Anthropic does not allow third party developers to offer claude.ai login or rate
> limits for their products, including agents built on the Claude Agent SDK. Use the
> API key authentication methods described in the Quickstart instead."

**Confirmed:** OAuth tokens from Free/Pro/Max accounts are for Claude Code and
claude.ai **only**. Using them in any other product — **including a local/desktop
app** — is not permitted. The restriction is about *whose credentials*, not *where
the code runs*. **Going back to a desktop app does not fix this.**

**Permitted paths:** Anthropic API key · Amazon Bedrock · Google Vertex AI · Azure
AI Foundry. Or explicit prior approval from Anthropic.

**Decision for v1: BYOK (bring-your-own-key).**
- Each user supplies their **own Anthropic Console API key**.
- Stored **encrypted, per-user**, server-side; never logged, never sent to client.
- Clean unit economics for us; user bears their own usage cost.
- **Documented as the v1 default.** You-pay SaaS is deferred until real usage data
  exists.

**Deferred: you-pay + credits.** Only viable with hard caps and per-action cost
gating. Revisit after instrumentation produces real numbers.
**Deferred: bundled subscription.** Requires Anthropic approval (business
conversation, not technical).

---

## 4. Reference Interface — What We're Replicating

**Core layout:** a **conversation panel** (left) beside a **canvas** (right). The
agent generates onto the canvas; the conversation drives it.

**The iteration loop (four refinement modes):**
1. **Chat** — broad changes ("make the color scheme darker", "show 2–3 alt layouts").
2. **Inline comments** — click a specific element, request a targeted change
   ("make this button padding larger", "use the primary brand color here").
3. **Direct canvas edits** — drag, resize, edit text/color by hand.
4. **Custom sliders** — agent-generated knobs for spacing/color/layout, applied live.

**Design system:** persistent brand context (colors, typography, components, layout
patterns). One project inherits it automatically. Multiple systems, Published/Draft
states, import from codebase / design files / raw uploads. The agent checks its own
output against the system and self-corrects.

**Inputs:** text prompt; uploads (images, DOCX, PPTX, XLSX); linked repo; **web
capture tool** (grab live elements from a URL).

**Outputs:** share URL, folder save, PDF, PPTX, standalone HTML, ZIP, Canva, Google
Slides.

**Handoff:** package the design into a bundle the code agent consumes in one
instruction (design intent + components, not just a screenshot).

**Surfaces (reference):** standalone workspace; in-chat; artifacts tab; code tool;
mobile view. **We build the standalone web workspace only.**
