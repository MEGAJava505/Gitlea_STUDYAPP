# IDEMPOTENCY_RECOVERY — persisted semantic idempotencyKey

**Status:** Required Phase 4 work. Controller executes; design orchestrator allocates only.  
**Constraint:** ≤180 lines. No product edits. No children launched.

---

## Problem Statement

Current `submit()` checks `idempotencyKey` is non-empty but ignores its value. Deduplication is by `commitSha` only. This fails:
- Cross-restart / cross-deadline replay of same key+SHA returns wrong result
- Same key + different SHA produces undefined behavior (not stable 409)
- Different key + same SHA has no explicit contract
- Partial Gitea success (snapshot created, DB failed) has no reconciliation path
- Concurrent identical requests race without coordination

**Goal:** Persisted `idempotencyKey` as a semantic key with stable, restart-safe behavior.

---

## Public Contract (AssignmentStateMachine.submit)

**Input (SubmitInput, unchanged shape):**
```ts
{
  actor: SessionPrincipal;
  assignmentId: AssignmentId;
  commitSha: string;        // nonempty
  idempotencyKey: string;   // nonempty; semantic key, not just nonce
}
```

**Output (SubmitResult, unchanged shape):**
```ts
{
  submission: SubmissionRecord;  // existing or newly created
  alreadyExisted: boolean;       // true → idempotent replay
}
```

**Error cases (stable across retries):**
- `409 Conflict` — same `idempotencyKey` with different `commitSha` (stable, not transient)
- `invalidInput` — missing or empty `idempotencyKey` / `commitSha`
- `deadlineExpired` — now > deadline AND no prior successful submission for this key
- `invalidState` — current status cannot transition to submitted
- `forbidden` — resubmission not allowed from revision_required
- `integration` — Gitea commit not found (audited, not retried under same key)

**Deadline race admission:**
- If `now > deadline` at entry, reject UNLESS a prior submission with this exact `idempotencyKey` already exists (return it, `alreadyExisted: true`).
- A key that first succeeds before deadline remains retrievable after deadline.
- A key that first arrives after deadline is rejected even if a different key for same commit succeeded earlier.

**Audit semantics:**
- `submission.idempotent` — replay of existing key+SHA (success path)
- `submission.created` — new key+SHA accepted (success path)
- `submission.conflict` — same key, different SHA (failure, 409)
- `integration.error` — commit not found or Gitea snapshot failure (failure, includes reason)

---

## Schema & Migration Requirements (ONE owner)

**New column on `submissions`:**
```sql
idempotency_key TEXT NOT NULL
```
- Nonempty check constraint
- Unique index: `(repository_link_id, idempotency_key)` — enforces one submission per key per link
- Migration must be idempotent (CREATE INDEX IF NOT EXISTS or guarded)

**No other schema changes.** Existing attempt/ref/commit uniqueness preserved.

**Data adapter change:** `insertSubmission` and `listSubmissions` must handle the new column. Lookup by `(linkId, idempotencyKey)` becomes the canonical idempotency check.

---

## Transactional Boundary (critical)

**Rule:** Never hold a SQLite transaction across an awaited network call.

- Gitea `hasCommit` / `createProtectedSnapshot` / `ensureReviewPullRequest` are OUTSIDE any DB tx
- DB tx wraps only: (a) idempotency lookup, (b) insert submission row + update link status, (c) audit append
- If Gitea snapshot succeeds but DB tx fails, the orphan snapshot is acceptable (student cannot force-push it; sweeper or manual reconciliation handles). No automatic cleanup required for MVP.
- If DB tx commits but subsequent Gitea PR creation fails, the submission row stands; PR reconciliation is a separate background concern.

---

## Worker Allocation (max 3, disjoint, approved roster)

**Worker A — Schema + Data Layer + State Machine (coupled, single owner)**
- Approved model: `claude-opus-5-5` or `claude-sonnet-5-5`
- Files: `src/db/schema.ts` (migration), `src/server/db-assignment-repository.ts` (lookup + insert by key), `src/domain/assignments/state-machine.ts` (idempotency gate + deadline race + audit), `tests/db/assignment-repository.test.ts`, `tests/domain/assignment-state.test.ts`
- Owns: table definition, unique index, lookup-by-key implementation, submit() idempotency logic, deadline admission, conflict error shape, audit events
- Must not touch HTTP route or adapter boundary tests

**Worker B — HTTP Boundary Regression + Validation (disjoint)**
- Approved model: `gpt-6.1-sol` or `glm-5.3-anthropic`
- Files: `src/app/api/v1/assignments/[assignmentId]/submit/route.ts` (if exists) or equivalent, `tests/api/assignment-submit.test.ts` (new or extend), contract validation only
- Owns: request validation (nonempty key/SHA), 409 response shape for conflict, 401/403 for authz failures, JSON error contract stability
- Must not modify schema, repository, or state machine

**Worker C — Independent QA Lane (disjoint, optional)**
- Approved model: `gpt-6-luna` or `glm-5.3-max`
- Files: `tests/live/gitea-submission-idempotency.live.test.ts` (new), `tests/server/submission-idempotency.test.ts` (new, mocked adapter)
- Owns: live harness covering restart-safe replay, samekey+differentSHA 409, differentkey+samesha explicit outcome, concurrent identical request dedup, partial-Gitea retry (snapshot exists, DB missing → reconcile on next submit)
- Must not modify production source

**If only 2 workers feasible:** Merge B+C scope into one approved model; Worker A remains distinct.

---

## Test Acceptance (before phase consideration)

Each worker must run and pass:
```
npm run typecheck
npm run lint
npm run test:unit -- <worker-owned test globs>
npm run test:unit
```

**Acceptance checklist (recorded by controller after worker completion):**
- [ ] `idempotency_key` column exists with unique index on (link_id, key)
- [ ] samekey+samesha returns original submission, `alreadyExisted: true`, no new snapshot
- [ ] samekey+differentSHA returns stable 409, no submission created, audit `submission.conflict`
- [ ] differentkey+samesha creates second submission (different attempt) — explicit semantics confirmed
- [ ] Key first used after deadline is rejected even if commit exists
- [ ] Key first used before deadline remains retrievable after deadline
- [ ] Concurrent identical requests (same key+SHA) produce exactly one submission
- [ ] Partial Gitea (snapshot exists, no DB row) → next submit with same key reconciles without duplicate snapshot
- [ ] All new/modified tests green; no regression in existing suite
- [ ] typecheck + lint clean

**No claim of Phase 4 pass.** This document allocates tasks only. Controller verifies, executes, and reports.

---

**End of allocation. ≤180 lines.**
