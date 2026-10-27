# PHASE_ACCEPTANCE_RECOVERY — Remaining Full Plan Phase Acceptance

**Status:** Design orchestrator allocation only. Controller executes.  
**Constraint:** ≤220 lines. No product edits. No CLI/infrastructure changes.  
**Model:** claude-opus-5-5 via Claude Code, sole design orchestrator.

---

## Current State Summary

**Merged into recovery branch (agent/recovery-integration-20261026):**
- Idempotency core (1d04834): persisted `idempotency_key` column, unique index `(repository_link_id, idempotency_key)`, semantic lookup, conflict detection, deadline admission.
- HTTP validation (0cadc35): nonempty string/object validation, stable 409/401/403 JSON contracts, forwarding original key/SHA.
- Fresh Phase 0 evidence: positive 20/20, negative 7/7 against Gitea 1.27.3 (docs/RECOVERY_VERIFICATION.md lines 53-60).
- Independent baseline: typecheck/lint/283 unit tests PASS (6 optional live skipped), production build 10/10 pages, fresh migration/seed.

**Confirmed defects resolved:** orphan snapshot SHA substitution (line 19-21), protection test `enable_push === false` (line 48), legacy provisioning API name assertions (line 49).

**Still-open acceptance gaps (lines 34-37, 68-70):**
1. **Transactional audit atomicity:** `insertSubmission` (db-assignment-repository.ts:102-133) wraps submission row + link status update in SQLite transaction, but `audit.append` calls remain OUTSIDE transaction in state-machine.ts:239-245. Required: PR/snapshot failure must not report success; audit must commit atomically with submission row per masterplan line 472.
2. **Phase 2 end-to-end:** identity/registration/OIDC/recovery flow not demonstrated beyond historical primitives. QR activation, email verification, recovery page, two-panel switch missing UI acceptance.
3. **Phase 3 teacher/material workflow:** course creation, lesson publication, ZIP upload, material browsing not demonstrated end-to-end. Backend primitives exist; teacher workflow acceptance open.
4. **Phase 4 full acceptance:** durable idempotency merged but full authenticated student submit→deadline→resubmission→terminal state cycle not refreshed since integration.
5. **Phase 5 partial:** review state/PR scaffolding only; inline comment UI, revision cycle, grading page incomplete.
6. **Phase 6 pending:** test execution worker, notification channels.
7. **Phase 7 pending:** compensation/reliability/full user-cycle.

No claim of Phase 4 MVP PASS. Seed fixture missing idempotency key (line 64) being fixed by controller.

---

## Atomic Audit Transaction Requirement

**Current defect (state-machine.ts:220-247):**
```typescript
submission = await this.repo.insertSubmission({...}); // SQLite tx commits here
// ... catch and replay winner ...
await this.audit.append({...}); // OUTSIDE transaction — async network/append could fail
return { submission, alreadyExisted };
```

**Masterplan contract (PLAN_GITEA.md:462-473):** "При нажатии «Сдать» backend ... Записывает SHA и номер попытки ... Операция должна быть повторяемой ... Если создание Git-снимка или запись состояния не удались, система не должна сообщать об успешной сдаче."

**Required:** Audit append must succeed atomically with submission persistence. If audit fails, submission must not exist. Current implementation commits submission then appends audit asynchronously — a network/disk failure after commit reports success without durable audit.

**Design decision needed:** Audit port must become transaction-aware (append within caller's tx) OR submission success must be conditioned on post-commit audit success (compensating rollback on audit failure). First option preserves existing SQLite transactional boundary; second requires explicit compensation.

---

## Three Disjoint Implementation Lanes (Max 3, Bounded, Useful)

### Lane A — Atomic Audit Submission Integration (Core Coupled Owner)

**Scope:** Resolve transactional audit requirement coherently under single owner.

**Approved model:** `claude-opus-5-5` or `claude-sonnet-5-5`

**Files owned:**
- `src/server/db-assignment-repository.ts` (insertSubmission transaction boundary)
- `src/domain/assignments/state-machine.ts` (submit audit calls)
- `src/shared/contracts.ts` (AuditLogWriter port if signature changes)
- `src/server/production-services.ts` (audit writer wiring if needed)
- `tests/domain/assignment-state.test.ts` (atomic audit+submission coverage)
- `tests/db/assignment-repository.test.ts` (if transaction-aware audit added)

**Exact contract:**
- Decision: Make `AuditLogWriter.append` transaction-aware (accepts optional tx handle) OR add post-commit audit success verification with compensating action on failure.
- If transaction-aware: `insertSubmission` tx must include audit append before commit; signature `append({...}, tx?: Transaction)`.
- If post-commit verification: submission insert commits, then synchronous audit append; on audit failure, mark submission row invalid OR delete via compensating tx and throw integration error.
- Audit failure during submit must prevent `SubmitResult` success; client receives error, no submission exists.
- Concurrent identical requests must still produce exactly one submission (existing idempotency winner replay unchanged).
- All existing 283 unit tests remain green; no regression in submit/replay/conflict/deadline behavior.

**Integration order:** First; blocks Phase 4 full acceptance claim.

**Tests required:**
- Mock audit writer fails after submission row committed → submit throws, no submission retrievable.
- Mock audit writer fails, concurrent retry with same key → winner succeeds with audit, loser replays winner.
- Successful submit with transaction-aware audit → both submission and audit exist atomically.

---

### Lane B — Phase 3 Teacher Material Workflow UI (Independent Earlier-Phase)

**Scope:** Complete missing Phase 3 teacher course/lesson/material management UI for acceptance demonstration.

**Approved model:** `claude-opus-5-5` or `claude-sonnet-5-5`

**Files owned:**
- `src/app/(panels)/teacher/courses/page.tsx` (course library UI)
- `src/app/(panels)/teacher/courses/new/page.tsx` (course creation form)
- `src/app/(panels)/teacher/courses/[courseId]/lessons/page.tsx` (lesson management)
- `src/app/(panels)/teacher/courses/[courseId]/lessons/[lessonId]/materials/page.tsx` (material upload/browse)
- `src/app/api/v1/courses/route.ts` (if missing POST course)
- `src/app/api/v1/lessons/route.ts` (if missing POST lesson)
- `src/app/api/v1/lessons/[lessonId]/materials/route.ts` (extend for ZIP upload if needed)
- `tests/api/teacher-course-workflow.test.ts` (new, end-to-end teacher flow)
- New page components only; no schema/domain/repository changes.

**Exact contract:**
- Teacher can create course with title/description/slug (authorId = actor.userId).
- Teacher can add lesson to owned course with position/title.
- Teacher can publish lesson to assigned group (records lessonPublications row with publishedAt).
- Teacher can upload material (ZIP, PDF, markdown) to lesson; stores metadata in lesson.contentMetadata JSON or separate materials table if schema extended (coordinate with controller if schema change needed).
- Student can view published lessons and download materials (existing or new student material pages).
- UI uses existing authentication/authorization; respects teacher/student panel separation.
- All existing tests green; new teacher workflow test demonstrates create→lesson→material→publish→student-view cycle.

**Integration order:** Second; independent of Lane A; unblocks Phase 3 acceptance without blocking Phase 4.

**Tests required:**
- Teacher creates course, adds lesson, uploads ZIP, publishes to group → student sees lesson and downloads material.
- Teacher without course ownership cannot edit another teacher's course materials.
- Unpublished lesson not visible to students in assigned group.

---

### Lane C — Durable SQLite Concurrent Idempotency QA (Independent Regression)

**Scope:** SQLite-backed concurrency and restart-safety regression coverage beyond in-memory baseline.

**Approved model:** `gpt-6-luna` or `glm-5.3-max`

**Files owned:**
- `tests/server/submission-idempotency-sqlite.test.ts` (new, durable DB tests)
- `tests/server/submission-restart-reconciliation.test.ts` (new, crash/restart simulation)
- No production source changes.

**Exact contract:**
- Real SQLite file (not `:memory:`), close/reopen between operations to verify durability.
- Two concurrent Node processes or two independent DB connections submit same `(linkId, idempotencyKey, commitSha)` → exactly one submission row exists, both clients receive same submission (one created, one replayed).
- Submit succeeds, process crashes (simulated by closing DB), restart and resubmit same key → returns existing submission with `alreadyExisted: true`.
- Same key + different SHA after restart → stable 409 conflict (existing persisted key prevents new SHA).
- Partial Gitea snapshot exists (mock reports prior snapshot), DB has no submission row → next submit reconciles and inserts row with existing snapshot's SHA/ref.
- Independent of Lane A (tests current implementation); Lane A fixes may turn some red tests green.

**Integration order:** Third; independent QA lane; red outcomes are acceptable (documents remaining work), not blocking.

**Tests required:**
- Concurrent two-connection submit with same key → one insert, one unique constraint violation → both return same submission.
- Close DB after successful submit, reopen, query by key → submission exists with correct SHA.
- Submit key1+sha1, close DB, reopen, submit key1+sha2 → 409 conflict, original submission unchanged.

---

## Acceptance Checklist (Controller Records After Lane Completion)

**Lane A (Atomic Audit):**
- [ ] Design decision documented: transaction-aware append OR post-commit verification.
- [ ] Audit failure during submit prevents SubmitResult success.
- [ ] Submission row and audit event committed atomically (or compensated on audit failure).
- [ ] All 283 existing unit tests green.
- [ ] New atomic audit test: mock audit failure → no submission exists.

**Lane B (Teacher Material UI):**
- [ ] Teacher creates course via UI.
- [ ] Teacher adds lesson and uploads material (ZIP or PDF).
- [ ] Teacher publishes lesson to group.
- [ ] Student sees published lesson and downloads material.
- [ ] Unpublished lesson hidden from students.
- [ ] All existing tests green; new teacher workflow test green.

**Lane C (Durable QA):**
- [ ] Concurrent two-connection submit produces one submission.
- [ ] Restart-safe: close/reopen DB, resubmit same key returns existing.
- [ ] Same key + different SHA after restart returns 409.
- [ ] Baseline documented; red outcomes acceptable (work remains).

**No full Phase 4 MVP PASS claim.** Remaining gates: authenticated end-to-end student cycle with fresh durable evidence, Phase 5 inline review UI, Phase 6 test worker, Phase 7 compensation/reliability.

---

## Integration Handoff

**Controller responsibilities:**
1. Launch at most three disjoint workers from approved roster with exact file ownership above.
2. Collect independent diffs; verify no file overlap.
3. Integrate sequentially: A (atomic audit), B (teacher UI), C (QA) onto recovery branch.
4. Rerun full release chain: typecheck, lint, unit tests (all green expected except C red acceptable), build, fresh migration/seed.
5. Record lane acceptance evidence in docs/RECOVERY_VERIFICATION.md continuation section.
6. Do NOT merge to main; do NOT claim full Phase 4 acceptance.

**Design orchestrator continuation:** After three-lane integration, controller invokes this orchestrator again with updated context for next bounded slice allocation or phase-gate assessment.

**No installation/infrastructure/secrets changes.** Read-only inspection and bounded implementation only.

---

**End of allocation. 218 lines.**
