# Schema requests: stream-agent (Epic 5)

For the integration phase. Nothing here blocks Phase 1; each item lists the workaround in use.

## 1. `llm_calls.cache_write_1h_tokens integer not null default 0`

- **Why:** cache writes cost 1.25× (5-minute TTL) or 2× (1-hour TTL) the input price. The proxy
  already gets the split from the API (`usage.cache_creation.ephemeral_1h_input_tokens`) and uses it
  in `est_cost_micros`, but only the total is stored in `cache_write_tokens`. ADR 0002's
  measurement needs the split.
- **Workaround:** `est_cost_micros` is correct per call; the split itself isn't persisted.
- **Done at integration:** column added (migration 0002); recorded by `recordCall`. Previously: **Code to change after the migration:** `recordCall` in `apps/web/src/server/services/llm-proxy.ts`
  (`usage.cacheWrite1hTokens` is already computed).

## 2. `llm_calls.meta jsonb` (or `cache_ttl text`)

- **Why:** to tag which prefix TTL setting (`AGENT_PREFIX_CACHE_TTL`) a call ran with, and the
  stream that issued it, for A/B comparison (ADR 0002).
- **Workaround:** run the two TTL settings in separate time windows.

## 3. `jobs.model text` (optional)

- **Why:** a job's model override is currently read from its linked assistant message
  (`agent_messages.model`). Jobs started without a chat message (design-system import, codegen in
  Phase 2) can't carry a per-request override.
- **Workaround:** jobs without a message use the workspace's generation-tier default.
