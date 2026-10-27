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
- Independent integrated typecheck PASS; lint PASS; full suite **335 PASS /6 optional live skipped**,35 passed files. Production build then completed exit0,10/10 static pages generated; diffcheck PASS.
- Production `next start` on isolated port3195/tempDB: **10/10 HTTP fixture checks PASS**, health200; anonymous pages/submit401; production unsafe identity hook403; fixture session200; teacher200; student forbidden teacher/admin403; student own assignment list/detail200 with expected repository/workflow/Tashkent content. Raw fixture session tokens stayed in memory; only hashes in disposable DB, server stopped and DB removed. This is NOT real OIDC/app-login or full education-flow acceptance.
- Fresh temporary SQLite migration PASS and seed twice PASS. Populated legacy upgrade/repeated migrate test PASS, preserves reviews/test-run references and immutable triggers.
- Separate CURRENT-source pinned Gitea1.27.3 protected snapshot live suite **6/6 PASS**. Fresh Phase0 positive **20/20 PASS**, negative **7/7 PASS**. Each used unique namespaces, disposable administrators and in-memory credentials; organization cleanup204 and administrator/token purge exit0 for both runs. No live configuration/restart/volume changes.
- Earlier QA continuation stopped for a missing dependency seam; controller synced integrated interfaces into the same QA worktree. Independent actual Sol QA then committed `dbe75ec`, integrated `390b2b6`: **11 additional real SQLite public-service tests** use production repository/audit writer and actual SQL persistence, controlled Gitea only. Covers close/reopen/deadline/conflicts, revision/terminal policies, two connections, database failure/orphan recovery and PR retry. Controller independently verified integrated typecheck/lint PASS and full **346 PASS /6 optional live skipped /2 TODO**,36passedfiles; pushed integrated390b2b6+design7f63346. TODO audit rollback is a real remaining gate. QA second TODO asks post-DB PR retention, but masterplan requires PR failure to fail submission, so this allocation conflict must be resolved by approved design authority, NOT silently implemented.
- Sole approved design orchestrator actual `claude-opus-5-5` via ClaudeCode committed **7f63346** `tasks/PHASE_ACCEPTANCE_RECOVERY.md`, then hit600s cap124 after productive allocation (not a completed final report). EXACT3 actual disjoint globally-approved Sol implementation executors now execute its allocation: A transaction-aware submission/audit core; B earlier Phase3 teacher/student course/material UI; C independent SQL-failure injection QA. Sol remains technical controller/executor only, not design authority. Selected approved atomic option preserves immutable guards; no unsafe compensating delete. Required snapshot+PR remain preconditions for successful submission, masterplan superseding stale TODO. No full phase PASS.

### Executed approved three-lane slice — 2026-10-27 02:45–02:54 UTC

- Actual three implementation executors delivered clean owned commits: A `abf634b` → integrated **3250cab**; B `c53cd72` → **531dc6d**; C `cc92118` → **4cf6b7d**. No overlapping source ownership.
- A added `AssignmentRepository.insertSubmissionWithAudit(input,audit)`: one synchronous SQLite transaction persists submission, link status and redacted success audit. No network awaits inside transaction, no compensating immutable-row deletion. Snapshot AND review PR remain prerequisites before DB success. Replay/conflict auditing remains separate and preserves durable winner.
- Independent C inserted real SQL rejection triggers: both fresh and orphan-success audit failure initially left a committed submission (2 red); after A integration BOTH pass, rollback preserves link/in-progress/no row, restart retry converges. Also tests lost PR response reconciliation and failure during replay/conflict audit without mutating winner. Invalid post-DB PR TODO removed; required PR failure explicitly leaves no submission/success audit.
- B delivered actual teacher course library/create, ordered lessons, assign/publish course and individual lessons, student published course/lesson browsing and server ownership checks. Two real-file SQLite + CourseService + authenticated server page/API workflow tests PASS. Material metadata browser honestly displays missing service503. Actual ZIP/PDF/markdown bytes upload/download is still missing, NOT Phase3 accepted. Browser-click E2E was not performed.
- Independent integrated typecheck/lint PASS; full **358 PASS /6 optional live skipped /0 TODO**,39passedfiles. Fresh migrated SQLite + seed twice PASS; separate fresh pinned1.27.3 snapshot enforcement **6/6 PASS**, fixture organization cleanup204 and disposable administrator/token purge0.
- First final build failed because shared `wt-gitassign2/node_modules/next` files disappeared while compiling (cause unproven; no active installer found). Preserved prior symlink, restored PRIVATE integration dependencies from pinned lock via `npm ci --offline --ignore-scripts`:425 packages. Bundled better-sqlite313 NAPI runtime independently opens SQLite3.53.4. An unnecessary native rebuild attempt failed for missing make; no compiler install is required. Isolated-dependency full-suite rerun then PASS358/6optional-skipped/0TODO; fresh03:54–03:59 typecheck/lint/build completed `FINAL_RELEASE_EXIT=0`,10/10static pages plus actual teacher/student course routes. No missing-compiler blocker: bundled NAPI is sufficient.
- Existing pinned Next15.1.3 emitted a security warning referencing CVE-2025-66478. Patched maintained Next upgrade/regression is an explicit remaining launch/Phase7 security gate, no silent dependency/spec change.
- Approved Opus corrected its own next allocation; controller preserved authored doc in **deab918** `tasks/NEXT_IMPLEMENTATION_SLICE.md`: exactly3 disjoint lanes, A material schema/storage/service and sole production wiring, B HTTP byte upload/download plus reachable UI, C verified OIDC start/callback/state/nonce/JWT with independent factory and sole dependency ownership. First invalid shared-wiring draft was never launched. Final Opus tool receipt expired during a provider/runtime rate-limit gap02:55→03:54, but corrected authored file persisted; technical commit is not Sol design substitution. Full plan remains OPEN.

### Fresh real production HTTP + Gitea acceptance and preview — 2026-10-27 04:04–04:09 UTC

- Final harness exit0 on real pinned1.27.3: submitted actual work-branch commit through production HTTP201, verified protected snapshot exact SHA + reviewPR + SQL atomic success audit; replay200/same ID, changed SHA409CONFLICT; teacher revision, second attempt201, teacher pass, terminal409INVALID_STATE; app restart + expired deadline replays original key200, fresh late key409DEADLINE_EXPIRED. Exactly2 durable attempts. Uses temporary DB and fixture sessions, NOT verified app login.
- Current validation organization deletion204 and ephemeral administrator/token purge0. Exact prior failed harness fixture `httpcycle-1793073595470` also explicitly cleaned. Harness-only uniqueness/startup/shutdown bugs were fixed without product changes; no false all-green claim from the intermediate failed cleanup run.
- User-requested safe standalone preview now externally verified at `https://dowci-165-140-166-143.free.pinggy.net`: root, teacher courses, student assignments200 with actual demo marker; public POST405 and API/admin404. Actual underlying anonymous teacher/student401; fixture200. Read-only preview only, labelled; only allowlisted GETs, scripts stripped, forms disabled, no production credentials/PII. Original apps3000/3001/nginx untouched. App artifact and seeded DB isolated under `/tmp/gitlea-readonly-demo-20261027`, ports3197/3198 loopback. Free HTTPS tunnel expires about05:04UTC, app TTL4h. Parent/watchdog owns refresh/stop. No browser installed: browser-tool start failed, so no screenshot or browser-click E2E is claimed.
- New user priorities Windows+Linux+macOS launchers and urgent QR/auth have been passed to the sole actual Opus5.5 ClaudeCode orchestrator in `wt-windows-demo-launcher`, log `/tmp/gitlea-urgent-0407.jsonl`; no launcher commit or QR completion yet. Domain activation/login/session tests are primitives, not a real QR screen or verified identity login. Precise phase/status map is `docs/EXECUTION_STATUS.md`; full plan remains OPEN.

### Still-open acceptance

No full Phase4/MVP PASS. Durable semantic idempotency, populated upgrade and transactional submission audit now have green independent real SQLite/concurrency/restart/fault tests. Verified app identity login and full authenticated education flow remain gates; required PR/snapshot failure must not report successful submission. Normal revision/resubmission/terminal state policies cannot be bypassed by new keys. Earlier identity/course/material UI end-to-end gates remain; Phase5partial,6–7pending. Current active work/identities and watchdog nonduplication state are in workspace `state/pipeline.md`.
