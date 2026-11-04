# ADR 0002: Prompt-cache TTL for the agent prefix

- **Status:** Accepted for beta, provisional. The decision below rests on a cost model. Story 5.11
  requires measured hit-rate data, which has to come from real traffic (see "Measurement plan").
  Revisit after two weeks of beta usage.
- **Story:** 5.11 (with 5.10 for the data)
- **Date:** 2026-11-03

## Context

Every agent request starts with the same prefix: the tool definitions (sorted by name), the
system prompt, and the project's design system, serialized with sorted keys. The conversation and
the per-turn document context (outline plus the relevant subtree) come after it. Tests in
`packages/agent/src/interactive.test.ts` check that the prefix is byte-stable: no timestamps, and
the same bytes whatever the key order of the design system.

Size today, with the starter design system: about 46 KB, roughly 11–12k tokens. Most of that is
the tool input schemas for `patch_nodes` and `insert_frame`, which describe the style allowlist.
(Inlining those schemas originally made the tools about 1 MB. They now use `$ref`s, and a test
caps the prefix at 80 KB.) Bigger design systems add more.

Prompt caching has two TTLs. Prices are multiples of the base input price, from Anthropic's
pricing docs:

|             | 5-minute TTL             | 1-hour TTL |
| ----------- | ------------------------ | ---------- |
| Cache write | 1.25×                    | 2×         |
| Cache read  | 0.1× (0.05× on Opus 5.5) | same       |

A read refreshes the timer for either TTL. Designers often pause for longer than 5 minutes
between prompts: they look at the canvas, make direct edits (zero tokens) or talk to colleagues.
With a 5-minute TTL, each of those pauses turns the next prompt into a full cache write.

## Cost model

Let P be the cost of the prefix at the base input price. For the interactive default (Sonnet 5.5,
$2/MTok) and a 12k-token prefix, P is about $0.024. Over one editing session:

- Turns less than 5 minutes apart cost the same under both TTLs (reads at 0.1P), except that
  the first write costs 2P instead of 1.25P. **The 1h TTL costs an extra 0.75P per session.**
- Each gap of 5 to 60 minutes costs 1.25P (a new write) with the 5-minute TTL, and 0.1P (a read)
  with the 1-hour TTL. **The 1h TTL saves 1.15P per gap.**

So the 1-hour TTL is cheaper once a session averages more than **0.65 gaps of 5–60 minutes**.
For an editor who works for an hour and prompts every 5–15 minutes, that's several gaps per
session. A session of rapid-fire prompts (no gaps) pays about $0.018 extra.

The messages part of the request (conversation history) uses automatic caching with the default
5-minute TTL. It changes every turn and is much smaller than the prefix for typical chats.

Background jobs (Agent SDK in the sandbox) make calls seconds apart, so the 5-minute TTL is
always enough there. The Agent SDK manages its own cache breakpoints through our proxy.

## Decision

1. Use the **1-hour TTL** on the prefix breakpoint (on the design-system system block, which also
   covers the tools and system prompt) for the interactive path. `prefixCacheTtl()` in
   `packages/agent/src/prefix.ts` defaults to `1h`.
2. Keep the conversation on automatic caching with the **5-minute** TTL.
3. **Don't re-warm on editor focus yet.** With a 1h prefix, re-warming only helps after more than
   an hour idle. That would save one cold write's latency, but costs a write even when the user
   never sends a prompt. Reconsider if measured time-to-first-token after long idles is a
   problem.
4. `AGENT_PREFIX_CACHE_TTL=5m` switches the TTL back, so the two settings can be compared on real
   traffic.

## Measurement plan (to finalize this ADR)

Every call is recorded in `llm_calls`: `cache_read_tokens`, `cache_write_tokens`, `input_tokens`,
`est_cost_micros`, `task`, `model`, `user_id` and `conversation_id`. The usage dashboard
(`/w/:slug/settings/usage`) shows the cache hit rate overall and by member, model, task and day.

1. Run one week at `1h` and one at `5m`, or split by workspace.
2. For `task = 'interactive'`, compare hit rate = read / (input + read + write) and estimated
   cost per conversation. Also compare the distribution of gaps between consecutive calls in a
   conversation (from `created_at`).
3. Keep `1h` if the cost per conversation is lower, or within 5% with a better hit rate.
4. Reconcile `est_cost_micros` with the provider's usage report (Story 5.10 AC: within ±5%).

Two schema gaps limit this today (see `docs/schema-requests/agent.md`). `llm_calls` doesn't
store the 1h/5m split of cache writes; the cost estimate uses the split, but only the total is
persisted. It also doesn't store which TTL setting a call used. Until those columns exist, run
the two settings in separate time windows.

## Consequences

- Sessions with a single prompt pay about 0.75P more (about $0.018 at today's Sonnet price).
- Sessions with pauses get cache hits instead of repeated writes, which is the common pattern
  for design work.
- Changing a workspace's design system invalidates the prefix (by design). Publishing a new
  version means one new write per active user.
