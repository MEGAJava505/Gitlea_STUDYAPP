# Phase 6 remainder — bounded implementation

Base: `126a4d6`. Source of requirements: `PLAN_GITEA.md` sections 12, 13 and Phase 6 (unchanged).

Goal: implement external notification delivery and an isolated Python runtime on the existing notification preferences and test-definition service. Main is never merged by this run.

Current state: in-app notifications are persisted and deduplicated; external preferences default off. Test definitions validate and store Python bundles; no runtime exists.

Independent tasks (separate worktrees/branches, model `gpt-6.1-sol`):
1. `agent/channels-1022`: secure voluntary Telegram binding, Email opt-in delivery, persistent channel deduplication, application integration. Own notification services/routes/storage and shared composition files. Prove with focused transport, binding and preference tests.
2. `agent/worker-1022`: bounded Docker Python executor for fixed snapshots, safe outputs and cleanup. Own new runtime/CLI/tests only. No shared composition/schema changes. Prove restrictions and failure handling with injected process execution; student code never runs on the host.
3. Orchestrator: review both diffs, integrate reviewed commits into `agent/phase6-watch-1022`, run actual `tsc --noEmit`, `vitest run`, lint and build, write full outputs and SHAs to `/tmp/gitlea-watch-1022-report.md`, push branch.

Verification precedes implementation via failing focused tests. Each worker makes an early tested commit. Final checks run on the integrated tree. A separate reviewer checks security and integration boundaries.

Limits: no main merge, native Gitea 3101/3102, Docker volumes, secrets or plan changes. Dependencies come from `/tmp/gitlea-deps-0715/node_modules`. No real user notification is sent. Runtime remains disabled until container isolation is verified. Real SMTP/Telegram delivery and Docker isolation require an authorized configured environment and must be reported as unverified here. No Phase 6 completion claim without all acceptance criteria.

Review risks: Telegram token reuse/expiry/account takeover; channel retries duplicating messages; hidden test leaks; host mount/shell injection; timeout cleanup and resource limits. Unfinished integration must be listed explicitly.
