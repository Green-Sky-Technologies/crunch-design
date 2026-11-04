# CrunchDesign

An AI design canvas. Describe a screen, and an agent builds it as live HTML frames on an
infinite canvas. Refine it in chat, comment on elements, or edit it directly with a
Figma-style edit panel. Then share it, or export HTML, a handoff bundle or React + Tailwind.

- **Agent:** Claude, through Vercel AI Gateway (no API keys to manage) or your own Anthropic,
  Bedrock, Vertex or Foundry credentials. Quick edits stream from the Messages API. Long
  generations run as background jobs (Claude Agent SDK in a Vercel Sandbox).
- **Canvas:** live HTML frames with View, Edit and Comment modes, breakpoints, design-system
  tokens, sliders, versions and a soft edit lock for teams.
- **Teams:** workspaces with Admin, Editor and Viewer roles (Clerk Organizations).

The product spec is in [`SPEC.md`](SPEC.md).

## Deploy to Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FGreen-Sky-Technologies%2Fcrunch-design&project-name=crunch-design&repository-name=crunch-design&env=CREDENTIALS_MASTER_KEYS%2CCRON_SECRET&envDescription=Two%20random%20secrets.%20Generate%20each%20with%3A%20openssl%20rand%20-base64%2032&envLink=https%3A%2F%2Fgithub.com%2FGreen-Sky-Technologies%2Fcrunch-design%23deploy-to-vercel&stores=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22neon%22%2C%22productSlug%22%3A%22neon%22%7D%2C%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22clerk%22%2C%22productSlug%22%3A%22clerk%22%7D%2C%7B%22type%22%3A%22blob%22%2C%22access%22%3A%22public%22%7D%5D)

Everything runs on Vercel. The button walks you through it:

1. **Clone** the repository into your GitHub account.
2. **Set Root Directory to `apps/web`** on the Configure step (this is a monorepo).
3. **Add the integrations it offers:** Neon (Postgres), Clerk (sign-in and workspaces) and a
   public Blob store (chat images and Figma assets). Each has a free plan, and each sets its own
   environment variables.
4. **Fill in two secrets.** Generate each with `openssl rand -base64 32`:
   - `CREDENTIALS_MASTER_KEYS` encrypts stored secrets (model credentials, Figma tokens). Keep
     it safe: losing it means re-entering those secrets.
   - `CRON_SECRET` authenticates Vercel Cron.
5. **Deploy.** The build ([`scripts/vercel-build.mjs`](scripts/vercel-build.mjs)) applies
   database migrations and configures Clerk (organizations, slugs and the Editor and Viewer
   roles), so there's nothing else to set up.

Then open the deployment, sign up, and create a workspace.

**Models.** On Vercel, the agent uses [Vercel AI Gateway](https://vercel.com/ai-gateway)
automatically. It authenticates with the deployment's own OIDC token, so there's no API key, and
usage is billed to the Vercel team that hosts the deployment. A workspace admin can instead add
their own credential under **Settings → Model access** (Anthropic, Amazon Bedrock, Google
Vertex AI, Microsoft Foundry, or an AI Gateway key) to bill that workspace's usage to them.

**Cron.** [`apps/web/vercel.json`](apps/web/vercel.json) runs the job reaper daily, which is
what the Hobby plan allows. While anyone is watching a job, the app also runs the reaper about
once a minute. On a Pro plan, you can change the schedule to `* * * * *`.

**Previews.** Migrations run on production deploys only. If previews have their own database
(Neon's integration can create a branch per preview), set `MIGRATE_ON_PREVIEW=1`.

**Production sign-in.** The Clerk integration starts with a development instance. To go live,
add a production instance and domain in Clerk and update the keys in Vercel.

### Updating your deployment

The Deploy Button **clones** this repository into your account. It's a copy, not a fork, so
updates don't arrive on their own. To pull in a new release:

```bash
git remote add upstream https://github.com/Green-Sky-Technologies/crunch-design.git  # once
git pull upstream main
git push                    # Vercel redeploys; migrations run in the build
```

If you'd rather keep a GitHub fork (with its "Sync fork" button), fork the repository first, then
import the fork in Vercel (**Add New → Project**). Set Root Directory to `apps/web`, add the
Neon, Clerk and Blob integrations from the project's **Storage** tab, and set the two secrets.

### Configuration

| Variable                                                | Required    | Notes                                                                                                                                              |
| ------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                          | yes         | Set by the Neon integration.                                                                                                                       |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` | yes         | Set by the Clerk integration.                                                                                                                      |
| `CREDENTIALS_MASTER_KEYS`                               | yes         | `openssl rand -base64 32`. To rotate, use `newid:<key>,<old key>` and set `CREDENTIALS_ACTIVE_KEY_ID=newid`.                                       |
| `CRON_SECRET`                                           | recommended | `openssl rand -base64 32`. Without it, the cron endpoint refuses every call.                                                                       |
| `BLOB_READ_WRITE_TOKEN`                                 | recommended | Set by the Blob store. Without it, chat image uploads and Figma image import are off.                                                              |
| `CRUNCH_AI_GATEWAY`                                     | no          | `on` or `off`. The default is on when running on Vercel or when `AI_GATEWAY_API_KEY` is set. With `off`, every workspace needs its own credential. |
| `AI_GATEWAY_API_KEY`                                    | no          | Use a gateway API key instead of the deployment's OIDC token (for example, when hosting outside Vercel).                                           |
| `CLERK_WEBHOOK_SIGNING_SECRET`                          | no          | Webhook at `/api/webhooks/clerk` for `user.*`, `organization.*` and `organizationMembership.*`. Without it, members sync on each request.          |
| `MIGRATE_ON_PREVIEW`                                    | no          | `1` to run migrations on preview deploys.                                                                                                          |
| `CRUNCH_AWS_PRINCIPAL_ARN`                              | no          | Only for Bedrock credentials that use role assumption.                                                                                             |

## Local development

Requires Node 22, pnpm 10 and Docker.

```bash
pnpm install
pnpm db:up && pnpm db:migrate      # Postgres 17 on localhost:5433
cp apps/web/.env.example apps/web/.env.local
```

Then fill in `apps/web/.env.local`:

- **Clerk:** create a free app at [dashboard.clerk.com](https://dashboard.clerk.com) and paste its
  keys. Then run `pnpm setup:clerk` once to turn on organizations and create the roles.
- **`CREDENTIALS_MASTER_KEYS`:** `openssl rand -base64 32`.
- **Models (pick one):**
  - `vercel link && vercel env pull` gives you an OIDC token for AI Gateway.
  - Or set `AI_GATEWAY_API_KEY`.
  - Or set `CRUNCH_AI_GATEWAY=off` and add a credential under Settings → Model access.

```bash
pnpm dev                           # http://localhost:3000
```

### Commands

| Command                                      | What it does                                                                 |
| -------------------------------------------- | ---------------------------------------------------------------------------- |
| `pnpm dev`                                   | Run the app in dev mode                                                      |
| `pnpm lint` / `pnpm typecheck` / `pnpm test` | Checks across all packages (Turborepo). Integration tests need `pnpm db:up`. |
| `pnpm build`                                 | Production build                                                             |
| `pnpm db:generate`                           | Generate a migration after editing `packages/db/src/schema`                  |
| `pnpm db:migrate`                            | Apply migrations to `DATABASE_URL`                                           |
| `pnpm setup:clerk`                           | Configure the Clerk instance in `CLERK_SECRET_KEY` (idempotent)              |
| `pnpm keygen [id]`                           | Print a named credential master key (`id:base64`) for rotation               |
| `pnpm --filter @crunch/web e2e:canvas`       | Canvas end-to-end tests (Playwright, no sign-in)                             |
| `pnpm --filter @crunch/web e2e:app`          | Signed-in end-to-end suite with real Clerk users, roles and workspaces       |

Integration tests use `TEST_DATABASE_URL` (default
`postgres://crunch:crunch@localhost:5433/crunch_test`), which is created and migrated
automatically.

`e2e:app` builds the app, starts it on port 3200 and signs in real Clerk users. It needs Clerk
**development** keys, `CREDENTIALS_MASTER_KEYS` and a migrated database of its own (for example,
`crunch_e2e`). Each run creates and then deletes its own users and organizations. If a run dies
first, the next run cleans up, or run `pnpm exec tsx apps/web/e2e/app/cleanup.ts`.

## Repository layout

```
apps/web               Next.js 16 app: UI, server actions, route handlers
apps/figma-plugin      Figma plugin (push designs, sync tokens)
packages/agent         Agent tools, prompts, interactive turns, follow-up questions
packages/canvas        Canvas geometry, layout, insert and drag logic
packages/doc-model     DesignDoc schema, styles, tokens, design systems, ops
packages/renderer      Live (Shadow DOM) and static HTML renderers
packages/db            Drizzle schema, migrations, Postgres client
packages/providers     Model routes: AI Gateway, Anthropic, Bedrock, Vertex, Foundry
packages/crypto        Envelope encryption for secrets at rest
packages/authz         Roles and permissions
packages/handoff, figma-convert, ds-lint, sandbox-runner, contracts
scripts/               vercel-build, setup-clerk, keygen
```

Workspace packages are consumed as TypeScript source and compiled by Next.js; there's no
separate build step. [`CLAUDE.md`](CLAUDE.md) has the code conventions (authorization,
services, secrets).

## Roles

|                                                     | Admin | Editor | Viewer |
| --------------------------------------------------- | :---: | :----: | :----: |
| View projects and designs                           |   ✓   |   ✓    |   ✓    |
| Deterministic export (HTML/ZIP, handoff bundle)     |   ✓   |   ✓    |   ✓    |
| Create, edit and archive projects; comment; sliders |   ✓   |   ✓    |        |
| Run the agent, LLM exports (codegen, Figma push)    |   ✓   |   ✓    |        |
| Manage members and model access                     |   ✓   |        |        |

## Contributing

Issues and pull requests are welcome. See [`CONTRIBUTING.md`](CONTRIBUTING.md). Please report
security issues privately, as described in [`SECURITY.md`](SECURITY.md).

## License

[AGPL-3.0](LICENSE). If you run a modified version as a network service, you must offer its
users the source of your version.
