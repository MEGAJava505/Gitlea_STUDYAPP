# TASK_A - Project scaffold and infrastructure

## Exact goal

Create the runnable TypeScript/Next.js foundation and disposable infrastructure required by PLAN_GITEA.md Phase 0 and Phase 1. Pin the Gitea image/configuration, provide an app plus reverse proxy Compose stack, define the shared environment and package scripts, and implement the small Gitea validation harness. Do not build educational product features.

## Files owned

Only these paths may be created or edited by this task:

```text
package.json
tsconfig.json
next.config.ts
vitest.config.ts
docker-compose.yml
docker/app/Dockerfile
docker/gitea/app.ini
docker/proxy/Caddyfile
.env.example
.gitignore
Makefile
.github/workflows/ci.yml
src/app/layout.tsx
src/app/page.tsx
src/app/globals.css
src/app/api/health/route.ts
scripts/phase0/run-positive.ts
scripts/phase0/run-negative.ts
tools/gitea-validation/client.ts
tools/gitea-validation/assertions.ts
tools/gitea-validation/fixtures.ts
```

The executor must not edit files outside this list and must not edit `PLAN_GITEA.md`. Do not add dependencies by running a network install; declare all required runtime and test dependencies in `package.json` and let the integration owner install them later.

## Interfaces to export

- `package.json` scripts: `dev`, `build`, `start`, `typecheck`, `lint`, `test:unit`, `test:unit:watch`, `db:generate`, `db:migrate`, `db:seed`, `validate:gitea`, and `validate:gitea:negative`.
- `src/app/api/health/route.ts`: `GET` returns HTTP 200 JSON `{ "status": "ok" }` without secrets or database contents.
- `tools/gitea-validation/client.ts`: export the `GiteaValidationClient` interface and its implementation, matching the contract in `docs/IMPL_PLAN.md`.
- `tools/gitea-validation/assertions.ts`: export assertion functions that throw on failure and return a serializable `{ name: string; passed: true }` record on success.
- `tools/gitea-validation/fixtures.ts`: export deterministic fixture usernames/repository names and a cleanup helper; generated secrets stay in process memory.
- Compose service names are exactly `app`, `gitea`, and `proxy`; the `validation` profile may disable `app` while retaining `gitea` and `proxy`.

## Required implementation

- Use strict TypeScript and a Next.js App Router skeleton. The root page may be a plain foundation placeholder.
- Configure Vitest with the repository TypeScript path aliases and a Node test environment. The package scripts must not silently skip missing test files.
- Pin compatible image versions and health checks for Gitea and the app. Persist Gitea data in a named volume and the SQLite path through `DATABASE_URL`.
- Configure Caddy (or the selected reverse proxy) to forward the public HTTP entrypoint to `app` and expose the health route. HTTPS may use a documented local development mode; production certificate handling must be explicit in the environment contract.
- Disable Gitea self-registration, public repositories, unnecessary organization creation, Actions, and other capabilities called out in PLAN_GITEA.md §8.6.
- Keep all credentials in environment variables. `.env.example` contains placeholders and comments, never real tokens.
- CI skeleton runs typecheck, lint, unit tests, `docker compose config`, and a migration dry run without publishing images.
- The Phase 0 harness must exercise every positive and negative assertion listed in `docs/IMPL_PLAN.md`, produce `artifacts/phase0/*.json`, and redact secret values.

## Required tests and checks

The executor must run these checks and fix failures:

```text
npm run typecheck
npm run lint
npm run test:unit
docker compose config
docker compose --profile validation up -d gitea proxy
npm run validate:gitea
npm run validate:gitea:negative
docker compose --profile validation down -v
```

The validation scripts must fail when Gitea is unavailable, when an assertion fails, or when a secret would be written to evidence. A successful run must include the Gitea version and assertion names in the JSON artifact.

## Definition of done

- A clean checkout with dependencies already available passes all commands above.
- `docker compose up -d` starts `app`, `gitea`, and `proxy`; `curl -fsS http://localhost/health` returns the documented JSON through the proxy.
- The validation harness proves user creation, OAuth/OIDC callback mapping, template repository creation, restricted Write access, branch protection, immutable submission ref behavior, PR creation, general and inline comments, and SSH/HTTPS clone/push.
- Negative validation proves a student cannot mutate/delete the protected submission ref or access another student's repository.
- CI checks are present and use the same script names as local development.
- The diff contains no secrets, debug logging, generated artifacts, or edits outside the ownership list.

## Scope guard

This task owns infrastructure and the validation harness only. Do not edit `PLAN_GITEA.md`, any `src/db/**`, `drizzle/**`, `src/shared/**`, `src/domain/**`, `src/server/**`, `src/app/api/v1/**`, or any test files owned by Tasks B or C. Do not implement identity, permissions, assignment state, migrations, or product screens.
