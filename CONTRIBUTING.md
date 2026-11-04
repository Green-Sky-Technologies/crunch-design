# Contributing

Thanks for helping out. Set up a local checkout with the steps in the README under
**Local development**.

## Before you open a pull request

```bash
pnpm db:up
pnpm lint && pnpm typecheck && pnpm test && pnpm format:check
```

CI runs the same checks, plus the browser suites.

## Conventions

[`CLAUDE.md`](CLAUDE.md) is the short version. The rules that matter most:

- **Authorization lives next to the resource.** Every page, server action and route handler
  gets the caller from `requireActor()` / `getActor()`. Every service function calls
  `assertCan(actor.role, '<permission>')`. New permissions go in `packages/authz` with tests.
- **Scope every query by workspace.** A resource from another workspace is a `NotFoundError`,
  never "forbidden".
- **Services are framework-free** (`apps/web/src/server/services`). They take `(db, actor, input)`
  and are tested against real Postgres in `apps/web/test`.
- **Secrets** are encrypted with `@crunch/crypto`. Never log request bodies or credentials,
  and never send secrets to the browser or into a sandbox.
- **Schema changes:** edit `packages/db/src/schema`, run `pnpm db:generate`, and commit the
  migration.

## License

By contributing, you agree that your contributions are licensed under the
[AGPL-3.0](LICENSE).
