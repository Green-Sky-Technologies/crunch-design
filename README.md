# CrunchDesign

AI design canvas: a conversational agent plus a WYSIWYG canvas of live HTML frames.
The product spec is in [`SPEC.md`](SPEC.md) (epics, stories, decision log).

## Layout

```
apps/web            Next.js 16 app (Vercel): UI, server actions, route handlers
packages/db         Drizzle schema, migrations, Postgres client
packages/crypto     Envelope encryption for secrets at rest
packages/authz      Roles → permissions (single source of truth)
packages/providers  Claude routes (Anthropic, Bedrock, Vertex, Foundry): credential shapes, clients, tests
packages/doc-model  DesignDoc schema, style allowlist, tokens, design-system spec, ops/reducer (Epic 2)
packages/renderer   Token CSS, live frame renderer (React, Shadow DOM) and static HTML renderer (Epic 2)
packages/contracts  Cross-stream interfaces: agent tools, agent edit, ds-lint, job runner, overlays, handoff
packages/ds-lint    Design-system linter (stub until Epic 4)
packages/canvas, agent, sandbox-runner, handoff, figma-convert   Phase 1 skeletons (see docs/worktree-plan.md)
apps/figma-plugin   Figma plugin skeleton (Epic 8)
infra/              OpenTofu: Vercel project, Neon Postgres, env vars
```

Workspace packages are consumed as TypeScript source (`exports` → `src/index.ts`) and
compiled by Next via `transpilePackages`. There's no separate build step.

## Local setup

Requires Node 22, pnpm 10 and Docker.

```bash
pnpm install
pnpm db:up                     # Postgres 17 on localhost:5433
pnpm db:migrate
cp apps/web/.env.example apps/web/.env.local
pnpm keygen                    # paste the output into CREDENTIALS_MASTER_KEYS
pnpm dev                       # http://localhost:3000
```

### Clerk

1. **Quick start, no account:** run `npx clerk@latest init --framework next --accountless` in
   `apps/web`. It writes temporary dev keys into `.env.local` (keeping your other variables).
   Run `clerk auth login` later to claim the app into your Clerk account.
   Or create an app at dashboard.clerk.com and put `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and
   `CLERK_SECRET_KEY` in `.env.local` yourself.
2. **Organizations and roles:** after `npx clerk@latest auth login`, run `scripts/clerk-setup.sh`
   (or `scripts/clerk-setup.sh prod`). It turns on Organizations (workspaces) with slugs and forced
   selection, creates the `org:editor` and `org:viewer` roles next to `org:admin`, and makes
   `org:viewer` the default for new members. It's safe to re-run. `org:member` is treated as
   editor; the mapping lives in `packages/authz`.
3. (Dev instances cap organizations at 5 members by default; raise `max_allowed_memberships`
   with `clerk enable orgs --max-members <n>` if you need more.)
4. **Webhook** (optional locally, required in production): endpoint `/api/webhooks/clerk`; events
   `user.*`, `organization.*`, `organizationMembership.*`; put the signing secret in
   `CLERK_WEBHOOK_SIGNING_SECRET`. Without it, workspaces and members are still mirrored lazily on
   each request.

## Commands

| Command                                      | What it does                                                   |
| -------------------------------------------- | -------------------------------------------------------------- |
| `pnpm dev`                                   | Run everything in dev mode                                     |
| `pnpm lint` / `pnpm typecheck` / `pnpm test` | Checks across all packages (via Turborepo)                     |
| `pnpm build`                                 | Production build                                               |
| `pnpm --filter @crunch/web e2e`              | Playwright on Chromium, Firefox and WebKit (needs Clerk keys)  |
| `pnpm db:generate`                           | Generate a migration after editing `packages/db/src/schema.ts` |
| `pnpm db:migrate`                            | Apply migrations to `DATABASE_URL`                             |
| `pnpm keygen [id]`                           | New credential master key                                      |

Integration tests use `TEST_DATABASE_URL` (default `postgres://crunch:crunch@localhost:5433/crunch_test`).
The test database is created and migrated automatically.

## Roles

|                                                    | Admin | Editor | Viewer |
| -------------------------------------------------- | :---: | :----: | :----: |
| View projects & designs                            |   ✓   |   ✓    |   ✓    |
| Deterministic export (HTML/ZIP, handoff bundle)    |   ✓   |   ✓    |   ✓    |
| Create / edit / archive projects, comment, sliders |   ✓   |   ✓    |        |
| Run the agent, LLM exports (codegen, Figma push)   |   ✓   |   ✓    |        |
| Manage members and model credentials               |   ✓   |        |        |
