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

1. Create a Clerk application, then put `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` in
   `.env.local`. Clerk's keyless mode also works for a quick start in an interactive terminal.
2. **Enable Organizations** with membership **required** (workspaces are Clerk orgs).
3. **Roles** (Organizations → Roles & Permissions): add custom roles `org:editor` and `org:viewer`
   next to the built-in `org:admin`, and make `org:viewer` the default role for invitations.
   `org:member` is treated as editor. The mapping lives in `packages/authz`.
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
