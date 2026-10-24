# Local GitHub MVP Implementation Plan

This plan turns `PLAN_GITEA.md` Phase 0 and Phase 1 into reviewable work. It assumes the current repository contains only the master plan, README, and this planning deliverable. No product feature UI, Gitea fork, or Python execution worker is implemented in these phases.

## Goals and boundaries

Phase 0 must remove the Gitea assumptions that would otherwise block authentication and Git assignments. Phase 1 must leave a reproducible local/server foundation with a typed application, SQLite migrations, the complete education schema, and tested domain primitives. Work is split into exactly three executable tasks in `tasks/TASK_A.md`, `tasks/TASK_B.md`, and `tasks/TASK_C.md`.

The tasks are intentionally file-disjoint. Executors may import another task's public interfaces, but may not edit its files. `PLAN_GITEA.md` remains the product source of truth and is read-only for all executors.

## Phase 0 - technical validation harness

### Purpose

Validate the fixed Gitea configuration before building assignment and authentication features. The harness uses a disposable Gitea instance and a small TypeScript client; it records pass/fail evidence without becoming a second product.

### Owned artifacts

Task A creates the harness under `tools/gitea-validation/` and the command wrappers under `scripts/phase0/`. The harness must expose a client interface with these operations:

```ts
interface GiteaValidationClient {
  createUser(input: { username: string; email: string; password: string }): Promise<{ id: number; login: string }>;
  getOAuthAuthorizeUrl(state: string): string;
  exchangeOAuthCode(code: string): Promise<{ subject: string; login: string }>;
  createRepositoryFromTemplate(input: { templateOwner: string; templateRepo: string; name: string }): Promise<{ id: number; fullName: string }>;
  grantWriteAccess(input: { repo: string; login: string }): Promise<void>;
  protectBranch(input: { repo: string; branch: string }): Promise<void>;
  createSubmissionRef(input: { repo: string; sourceSha: string; ref: string }): Promise<void>;
  createPullRequest(input: { repo: string; head: string; base: string }): Promise<{ number: number }>;
  addComment(input: { repo: string; number: number; body: string; inline?: { path: string; line: number } }): Promise<void>;
}
```

The harness must run these checks against a clean fixture: create a user, complete OAuth/OIDC redirect and callback, create a private repository from a template, grant only Write access, protect `main`, create an immutable `submission/1` ref, create a PR, add general and inline comments, and clone/commit/push over the configured SSH or HTTPS transport. A negative pass is required for force-pushing or deleting the protected submission ref and for using an unrelated user's repository.

### Verification

```text
docker compose --profile validation up -d gitea proxy
npm run validate:gitea
npm run validate:gitea:negative
docker compose --profile validation down -v
```

The commands must exit non-zero on any failed assertion and write a short JSON result to `artifacts/phase0/` (ignored by Git). The result records the Gitea version/configuration, tested repository/ref names, and assertion names; it never records passwords, OAuth secrets, or access tokens.

### Phase 0 completion criteria

- The disposable stack starts from the committed Compose configuration with no manual database edits.
- All positive and negative checks above pass against the pinned Gitea image.
- OAuth subject-to-user mapping is stable across two logins.
- A submission ref cannot be changed or deleted by the student credentials.
- The evidence JSON is reproducible after `down -v` and a fresh `up`.
- Any Gitea limitation is written as a failing check and blocks Phase 1 authentication work until the configuration is corrected.

## Phase 1 - foundation

### Work sequence

1. **Scaffold and infrastructure (Task A).** Establish the package scripts, TypeScript/Next.js configuration, Compose services (app, Gitea, reverse proxy), environment contract, CI checks, and the Phase 0 harness.
2. **Data layer (Task B).** Implement the Drizzle SQLite client/configuration, every entity in §15.4, constraints/indexes/triggers for the stated invariants, migrations, deterministic seed data, and invariant tests.
3. **Domain and API primitives (Task C).** Implement identity and combined roles, server sessions, permission checks, audit writes, assignment/submission transitions, and Vitest unit tests. Route handlers should depend on the interfaces from Tasks A and B rather than reaching into infrastructure directly.

### Phase 1 verification commands

```text
npm run typecheck
npm run lint
npm run test:unit
npm run db:migrate
npm run db:seed
docker compose config
docker compose up -d
curl -fsS http://localhost/health
docker compose down
```

The local smoke check must show the Next.js health response through the reverse proxy and a healthy Gitea container. The database commands must work against a new SQLite file and be repeatable. No command may require a network install during this planning run; executors use the dependencies declared by Task A.

### Phase 1 completion criteria

- A clean checkout can be configured from `.env.example`, migrated, seeded, and started with Compose.
- `npm run typecheck`, `npm run lint`, and `npm run test:unit` pass without skipped tests.
- All §15.4 entities exist in the Drizzle schema and migrations.
- The four required data invariants have automated tests and fail for the expected constraint/guard when deliberately violated.
- Domain tests cover role combinations, self-grading denial, session expiry/revocation, audit records, legal assignment transitions, deadline checks, and idempotent repeated submission requests.
- The health endpoint is reachable through the proxy; no secret is committed.

## Shared contracts

These names are the integration contract. Changing one requires an explicit plan update before implementation.

### Canonical paths and ownership

| Contract | Path | Owner |
| --- | --- | --- |
| Application package/config/Compose/proxy/CI | `package.json`, `tsconfig.json`, `next.config.ts`, `docker-compose.yml`, `docker/`, `.env.example`, `Makefile`, `.github/`, `tools/gitea-validation/`, `scripts/phase0/`, `src/app/api/health/route.ts` | Task A |
| Database client, schema, migrations, seed, DB tests | `drizzle.config.ts`, `src/db/`, `drizzle/`, `tests/db/` | Task B |
| Shared domain types, identity/session/permissions/audit, assignment state machine, API routes, domain tests | `src/shared/`, `src/domain/`, `src/server/`, `src/app/api/v1/`, `tests/domain/`, `tests/api/` | Task C |
| App shell only | `src/app/layout.tsx`, `src/app/page.tsx`, `src/app/globals.css` | Task A |

Task C may import `src/db/client.ts` and `src/db/schema.ts`; it must not edit them. Task B exports database-only types and must not depend on Task C paths, so the data task can complete before domain code exists. `scripts/seed.ts` is owned by Task B; all other `scripts/` files are not implicitly shared and must be listed in a task before editing.

### Type and persistence conventions

- IDs are opaque lowercase UUID strings. Public aliases are `UserId`, `GroupId`, `CourseId`, `AssignmentId`, `RepositoryLinkId`, `SubmissionId`, `ReviewId`, and `AuditEventId`.
- SQLite timestamps are UTC epoch milliseconds. API payloads serialize them as ISO-8601 UTC strings.
- Roles are the exact literals `student | teacher | admin | owner`; a user may have multiple rows in `user_roles`.
- Assignment statuses are `in_progress | submitted | revision_required | passed | failed`.
- Submission attempts are positive integers unique within `(studentId, assignmentId)`. `commitSha` is non-null and immutable after insertion.
- `src/db/client.ts` exports `db` and `type Db`; `src/db/schema.ts` exports all table definitions and inferred row/insert types. `src/shared/contracts.ts` exports the ID, role, status, and service input/output types consumed by Task C.
- Task C services accept a `Db` dependency and a clock (`() => number`) so deadline and expiry tests are deterministic. API handlers return JSON and never expose Gitea tokens or password material.

### Environment names

Task A documents every name in `.env.example`; Tasks B and C consume only these names:

`NODE_ENV`, `APP_BASE_URL`, `DATABASE_URL`, `SESSION_SECRET`, `GITEA_BASE_URL`, `GITEA_HTTP_PORT`, `GITEA_SSH_PORT`, `GITEA_ADMIN_TOKEN`, `GITEA_OAUTH_CLIENT_ID`, `GITEA_OAUTH_CLIENT_SECRET`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`, `TELEGRAM_BOT_TOKEN`, `TEST_WORKER_URL`, `PROXY_HTTP_PORT`, `PROXY_HTTPS_PORT`, `TZ`.

Secrets are required at runtime where applicable, have safe local placeholders only in `.env.example`, and are never written to test evidence or audit payloads.

## Review gates

Each task is committed separately by its executor. Before accepting a task, review its diff for scope violations, debug output, secrets, skipped assertions, and undocumented contract changes. After all three tasks are integrated, rerun the Phase 1 verification commands and the Phase 0 harness; the proxy smoke request and the fresh-database migration are the minimum live checks.
