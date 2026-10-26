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
