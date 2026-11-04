# Infrastructure (OpenTofu)

Manages the Vercel project, its environment variables, and the Neon Postgres project
(`main` = production, `staging` branch).

```bash
export VERCEL_API_TOKEN=...   # vercel.com/account/tokens
export NEON_API_KEY=...       # console.neon.tech → API keys
cp terraform.tfvars.example prod.auto.tfvars   # untracked; fill in secrets
tofu init
tofu plan
tofu apply
```

Without a local `tofu`, use the container image:
`docker run --rm -it -v "$PWD":/w -w /w -e VERCEL_API_TOKEN -e NEON_API_KEY ghcr.io/opentofu/opentofu:latest plan`

**State:** local by default (gitignored). Before a second person runs `apply`, configure a
remote backend (S3 + DynamoDB, or the encrypted state feature in OpenTofu).

**Preview databases:** install the Neon integration from the Vercel Marketplace and link it to the
`crunchdesign` Neon project with "create a branch for each preview deployment" enabled. It
overrides `DATABASE_URL` per preview. Run migrations in the build for previews
(`pnpm db:migrate && next build`) once the integration is connected.

**Not managed here:** Vercel Blob stores (the provider has no resource; create one in the dashboard and
pass `blob_read_write_token`), the Clerk instance (dashboard/CLI), and Vercel Sandbox (no infra needed).
