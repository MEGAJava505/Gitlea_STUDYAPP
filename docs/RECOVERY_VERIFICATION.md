# Autonomous recovery verification — 2026-10-26

## Scope and ownership

Controller: session `e57c9fd0-80c6-4e5e-8e0c-64a5604837ec`; parent owns continuation. Source of truth remains `PLAN_GITEA.md`. This is execution evidence, not a replacement design or acceptance declaration.

Recovered main `5d9b8e1` and clean **unmerged** candidate `344321b`, preserving its five commits. Candidate was not accepted merely because commits existed. Integration branch: `agent/recovery-integration-20261026`.

## Independent baseline checks on candidate 344321b

- `npm run typecheck`: exit 0.
- `npm run lint`: exit 0, no warnings/errors.
- `npm run test:unit`: exit 0, 255 passed, **6 optional live tests skipped** (27 passed files, 1 skipped).
- `npm run build`: exit 0, production compile and 10/10 static pages generated.
- Production `next start` on temporary port3194 and temporary SQLite: `/api/health`200, unauthenticated `/student/assignments`401, unauthenticated POST submit401 with `UNAUTHENTICATED` JSON. Server wrapper intentionally timed out after requests; no app failure inferred from wrapper exit124.
- Existing pinned validation runtime responds Gitea1.27.3 on localhost3102. Historical ignored Phase0 evidence: positive20/20 and negative7/7; **not fresh product-cycle evidence**.

## Confirmed defect before repairs

Public state-machine probe seeded protected orphan snapshot SHA `abc123`, requested SHA `def456`, and returned `{requested:def456,actuallyRecorded:abc123,reportedSuccess:true}`. A protected existing snapshot must never silently substitute a different requested commit. Assigned to persistence worker with regression-first repair.

## Orchestration evidence

Actual `codex exec -m gpt-6-astra` read plan/history/worktrees and recommended preservation plus disjoint persistence/deadlines, Gitea provisioning, studentUI lines. Stopped after >4minutes no output before distinct fallback (not overlapping orchestrators). Current design authority fallback is actual `claude-opus-5-5` via Claude Code, initialization model recorded in `/tmp/gitlea-opus-orchestrator.jsonl`; formal phase/task documents pending. No Fable.

Three workers launched with `modelApplied=true`, resolved `openai/gpt-6.1-sol`, separate worktrees based on344321b:

1. `agent/recovery-persistence`: submission SHA reconciliation, latest status synchronization, stale deadline writes; source and related domain/DB tests only.
2. `agent/recovery-gitea`: HTTP204 handling, pinned branch-protection contract, assignment-specific repository naming; adapter/provisioning source/tests only.
3. `agent/recovery-student`: student query/page visibility, latest status, deadline/terminal UI; student query/pages/tests only.

No worker owns schema/shared contracts/production wiring or another worker files. Maximum three. Formal orchestrator tasks must be reconciled before acceptance; technical repair assignments follow its emitted scope direction and existing spec, not a controller architecture redesign.

## Phase acceptance remains open

Phase0 has historical live harness evidence; Phase1 candidate build/tests verified but clean-stack acceptance not refreshed. Phase2 has primitives/panels, not demonstrated end-to-end registration/OIDC/recovery and import UI. Phase3 backend exists, teacher/student materials workflow not accepted. Phase4 candidate implemented but confirmed defects/live enforcement acceptance open. Phase5 partial review state/PR scaffolding only. Phase6 test execution/notifications pending. Phase7 compensation/reliability/full user-cycle pending. Formal detailed map is orchestrator-owned.

## Continuation

Collect all three workers, inspect disjoint diffs and red/green evidence, integrate onto preserved candidate, rerun typecheck/lint/full suite/build and fresh migration/seed. Do not merge main or call full Phase4 accepted with unresolved P1 defects or optional live tests skipped. Next use approved orchestrator to issue remaining coherent tasks, including actual auth and teacher workflows, before phases5–7. Parent and existing enabled20minute watchdog retain follow-through; active identities are in workspace `state/pipeline.md` to prevent duplicate launches.


## Continued execution — 2026-10-27 02:05 UTC

### Integrated repair acceptance (not full Phase 4)

- Watcher Opus5.5 integrated original three worker lines as `adc851f`. Its later report incorrectly claimed semantic-key lookup existed and dependencies required installation. Actual source still deduped by SHA; existing `wt-gitassign2/node_modules` enabled independent checks without installs.
- Controller recovered preserved failing protection test, observed 1failed/53passed, repaired explicit `enable_push === false` in `f5694b4`; integrated copy `2f705fd`.
- Full integration revealed2 failing legacy provisioning API name assertions (280passed/6optional-skipped). Updated exact assignment-scoped expected names and ADDED cross-assignment isolation coverage, preserving assertions, commit `1371436`.
- Independent release chain on source `1371436`: typecheck PASS; lint PASS; **283 unit tests PASS /6 optional live skipped**,30passedfiles; productionbuild PASS,10/10pages; fresh SQLite migration PASS; seed twice PASS; diffcheck PASS. Verified repair slice merged into recovery branch as **`1c44521`**, not main.
- Fresh live snapshot enforcement: **6/6 PASS** against existing pinned Gitea1.27.3 in unique fixture namespace. Force-push, normal push, Git/API delete were denied; protected SHA remained; same-SHA retry/different-SHA rejection and unprotected branch denial passed. Exact adapter blob `47981f41022c9c041579cc85d68a9f41c1f1e851`, live test and helpers match integration byte-for-byte. Organization cleanup204; initial validation token API revocation401, raw value discarded (no logged/stored/argv credential). Later runs use fully disposable administrators instead.

### Fresh Phase 0 harness rerun

- First two isolated runs failed after7 assertions. Targeted HTTP tracing and one failing unit regression located hardcoded template destination organization; namespace-independent source template generation incorrectly targeted `local-github-validation`.
- Minimal fix `f796430` uses `input.templateOwner`, retaining private/git_content flags and original default fixture behavior. Regression1failed→1passed; typecheckPASS. Tracing remained only in temporary runner, not product code.
- Original unminimized harness rerun now **positive20/20 PASS, negative7/7 PASS**, version1.27.3. Includes real OAuth/OIDC two-login subject stability, private template copy, restrictedWrite, clone/commit/push, protected reference immutability and general/inline PR comments; other-student repo access denied.
- Evidence `artifacts/phase0/positive.json` and `negative.json` is redacted/ignored and contains actual assertion names. This reused the pinned disposable runtime; a fresh cold Compose installation/TLS-proxy launch was NOT claimed.
- Setup used a unique namespace, ephemeral administrator with cryptographically generated password, token/OAuth client held only in memory/environment. Organization cleanup204; administrator+tokens purged via documented CLI exit0. Two specific repositories accidentally created by failed runs were removed204. No service config/restart/volume changes.

### Orchestrator-assigned next slice actually executing

- Sole approved Opus5.5 design run committed **`9aa6248`**, copied `0ba69a3`, `tasks/IDEMPOTENCY_RECOVERY.md`: coupled durable-key schema/data/state owner A, HTTP owner B, independent QA C.
- A: `claude-opus-5-5` through ClaudeCode in `wt-idempotency-core` (native alias was rejected BEFORE any launch); implements safe migration/backfill, persistence, conflict and replay. Scope includes tightly coupled migration/journal/shared-contract/DB-fixture dependencies under ONE owner. Still pending independent acceptance.
- B: actual native `gpt-6.1-sol`, `5f990e1`/`6de8549`: nonempty STRING/object validation, forwarding original key/SHA unchanged, stable401/403/409/internal-error JSON. Reported RED12failed/12passed→GREEN32passed, typecheck/lint/full315passed6optional-skipped on its branch. Merged as **`0cadc35`**; controller independently verified typecheck+48focused tests (32newAPI+15existingAPI+1harness).
- C: actual native `gpt-6-luna`, `6e2a63f`, independent6 public-contract tests baseline4failed/2passed. Caveat: initial suite used in-memory fixture, not durable SQLite. Controller continued same QA line with concrete realSQLite close/reopen/two-instance concurrency tests; red is pending fixwork, not completion.

### Recovered controller integration — 2026-10-27 02:28 UTC

- Fresh technical controller recovered actual core commit `1d04834` and independent QA `6e2a63f` before redoing work. Merged them as `9039be7` and `c9b84f7`, retaining strict fail-closed push protection (adapter is byte-identical to `f5694b4`).
- Core includes in-place populated SQLite migration/backfill and immutable-key guards, canonical durable-key lookup, stable409 conflicts, preserved deadline/terminal/revision policies, orphan snapshot reconciliation and independent-connection concurrency coverage.
- Independent integrated seed regression reproduced **1 failed/16 passed**: insert omitted required semantic key. Minimal stable seed key `seed:submission:1` fixed in `f5dd21a`; focused rerun **17/17 PASS**. No constraints weakened.
- Independent integrated typecheck PASS; lint PASS; full suite **335 PASS /6 optional live skipped**,35 passed files. Production build was still running when this subsection was written; no build PASS asserted here.
- Fresh temporary SQLite migration PASS and seed twice PASS. Populated legacy upgrade/repeated migrate test PASS, preserves reviews/test-run references and immutable triggers.
- Separate CURRENT-source pinned Gitea1.27.3 protected snapshot live suite **6/6 PASS**. Fresh Phase0 positive **20/20 PASS**, negative **7/7 PASS**. Each used unique namespaces, disposable administrators and in-memory credentials; organization cleanup204 and administrator/token purge exit0 for both runs. No live configuration/restart/volume changes.
- Earlier QA continuation stopped for a missing dependency seam; controller synced integrated interfaces into the same QA worktree and launched real SQLite public-service QA. This is additional independent evidence, not a missing production dependency anymore.
- Sole approved design orchestrator is actual `claude-opus-5-5` via ClaudeCode, doc-only `tasks/PHASE_ACCEPTANCE_RECOVERY.md`; Sol remains technical controller only. Next allocation must retain three useful disjoint executor lanes and full-plan acceptance ownership.

### Still-open acceptance

No full Phase4/MVP PASS. Durable semantic idempotency, upgrades of existing submissions, race/audit atomicity and full authenticated education flow remain gates; required PR/snapshot failure must not report successful submission. Normal revision/resubmission/terminal state policies cannot be bypassed by new keys. Earlier identity/course/material UI end-to-end gates remain; Phase5partial,6–7pending. Current active work/identities and watchdog nonduplication state are in workspace `state/pipeline.md`.
