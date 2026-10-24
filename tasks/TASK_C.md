# TASK_C - Domain and API primitives

## Exact goal

Implement the Phase 1 server-side domain primitives: combined identity and roles, secure session handling, per-request permission checks, append-only audit writing, and the assignment/submission state machine. Expose only thin JSON API handlers over those services. Build the tests first with Vitest and keep Gitea calls behind an injected port.

## Files owned

Only these paths may be created or edited by this task:

    src/shared/contracts.ts
    src/domain/identity.ts
    src/domain/auth/session.ts
    src/domain/permissions.ts
    src/domain/audit.ts
    src/domain/assignments/state-machine.ts
    src/server/auth-context.ts
    src/server/ports/gitea-submissions.ts
    src/app/api/v1/session/route.ts
    src/app/api/v1/assignments/[assignmentId]/submit/route.ts
    src/app/api/v1/assignments/[assignmentId]/review/route.ts
    tests/domain/**
    tests/api/**

The executor must not edit files outside this list and must not edit PLAN_GITEA.md. Do not edit package.json, docker files, src/db/**, drizzle/**, the Task A health route, or the Task B tests. Import the database interfaces from Task B and the package scripts from Task A.

## Interfaces to export

- src/shared/contracts.ts: export the opaque ID aliases, Role, AssignmentStatus, SubmissionDecision, SessionPrincipal, Permission, and service input/output types from the shared contract in docs/IMPL_PLAN.md.
- IdentityService: getUser(userId), listRoles(userId), grantRole(actorId, targetUserId, role), and revokeRole(actorId, targetUserId, role). Enforce Owner/Admin boundaries and the last-Owner invariant through the injected Db.
- SessionStore: create(principal, ttlMs), get(sessionId), and revoke(sessionId). Store only a hash of the opaque session token, set an absolute expiry, and provide a cookie helper that sets HttpOnly, Secure in production, SameSite=Lax, and a bounded Max-Age.
- PermissionChecker: assert(actor, permission, resource) and can(actor, permission, resource). Check the target resource and assignment membership on every call; role presence alone is insufficient.
- AuditLogWriter: append(input) writes an AuditEvent through Task B's Db and returns its ID. The payload must be structured, redact secrets, and never expose session tokens or Gitea credentials.
- AssignmentStateMachine: submit(input), requestRevision(input), pass(input), and fail(input). Accept a clock and a GiteaSubmissionPort with hasCommit, createProtectedSnapshot, and getExistingSubmission operations. Repeated requests with the same idempotency key return the existing submission without another snapshot.
- API handlers under src/app/api/v1/ return stable JSON error codes and HTTP statuses. They obtain the principal from auth-context.ts, call a service, and never access the Gitea token or database connection directly.

## Required behavior

- A user may hold multiple roles. Admin cannot grant or revoke Owner. Owner cannot remove the final Owner. Role changes and activation conflicts are audited.
- Session lookup rejects expired, revoked, malformed, or unknown tokens. The raw token is never persisted or logged. Logout revokes the server-side session.
- Student resources are limited to the student's own courses, repositories, submissions, and results. Teacher actions require assignment/group responsibility. Admin/Owner checks are still evaluated per operation.
- No actor may review, pass, fail, or change the grade of their own submission, even with Admin or Owner role.
- submit requires a real remote commit, a valid assignment/student repository link, an unexpired deadline, and the next positive attempt number. It creates one protected snapshot and records its immutable commit SHA through Task B.
- State transitions are exactly: in_progress -> submitted; submitted -> revision_required | passed | failed; revision_required -> submitted | failed; terminal passed and failed have no outgoing transitions. revision_required is forbidden after the deadline. After the deadline, a timely submitted work may only become passed or failed.
- Server time controls deadline checks. A repeated request after a network retry returns the already-created attempt and never increments the attempt number.
- Every role change, activation conflict, submission, review decision, permission denial, and integration error writes an audit event. Audit failure prevents reporting the protected operation as successful.

## Required tests (TDD with Vitest)

Write these tests first, run them to confirm the expected red failure, then implement the minimum behavior and rerun them green:

- tests/domain/identity.test.ts: combined roles; Admin cannot grant Owner; final Owner cannot be revoked; role changes produce audit events.
- tests/domain/auth-session.test.ts: token hashing, expiry at the exact boundary, revocation, malformed token rejection, secure cookie attributes, and no raw token in the database mock.
- tests/domain/permissions.test.ts: student ownership, teacher assignment membership, per-action role checks, self-grading denial for Admin and Owner, and audit on denied sensitive access.
- tests/domain/audit.test.ts: structured append, target/actor indexes passed to the repository, redaction of token/password fields, and failure propagation.
- tests/domain/assignment-state.test.ts: every legal transition, illegal transition, deadline boundary, resubmission policy, no revision after deadline, and idempotent repeated submit.
- tests/api/assignment-routes.test.ts: authenticated success, unauthenticated 401, forbidden 403, malformed input 400, conflict/idempotent response, and no leaked secrets.

Tests use an in-memory/fake Db, clock, and GiteaSubmissionPort; they do not call a live Gitea service. Do not weaken an assertion to make an implementation pass.

## Commands to run

    npm run typecheck
    npm run test:unit -- tests/domain tests/api
    npm run lint

Run the complete suite after Task B is available:

    npm run test:unit

## Definition of done

- The red/green TDD sequence is visible in the task's development history or review notes.
- All exported interfaces above are typed, dependency-injected, and covered by focused unit tests.
- Role, session, permission, audit, state-transition, deadline, and idempotency rules pass without skipped tests.
- API handlers use the shared status/error contract and do not expose secrets or bypass permission checks.
- Typecheck, lint, and the full Vitest suite pass against the real Task B schema types.
- The diff contains no infrastructure or schema edits and no files outside the ownership list.
