# LEADER BRIEF — Local GitHub MVP (Gitlea_STUDYAPP)

You are the lead architect/orchestrator. Source of truth: PLAN_GITEA.md (read it fully, 1176 lines).
Repo is a fresh git repo: only PLAN_GITEA.md and README.md exist. Stack required: TypeScript, Next.js, React, SQLite, Drizzle ORM, Gitea, Docker Compose, reverse proxy, SMTP, Telegram Bot API, isolated Python test worker.

Your job in THIS run (do not implement product code yourself):
1. Read PLAN_GITEA.md and produce `docs/IMPL_PLAN.md` — a concrete implementation plan for Phase 0 (technical validation harness) and Phase 1 (foundation), with file paths, interfaces, verification commands, and completion criteria.
2. Split the executable work into exactly 3 tasks with DISJOINT file ownership (no two tasks touch the same file). Write:
   - `tasks/TASK_A.md` — project scaffold + infra: package.json, tsconfig, next config, docker-compose (app + gitea + proxy), .env.example, Makefile/scripts, CI skeleton.
   - `tasks/TASK_B.md` — data layer: Drizzle config, `src/db/schema.ts` (all entities from §15.4), migrations, seed, invariant tests (unique student id, unique email, attempt numbering, immutable commit SHA).
   - `tasks/TASK_C.md` — domain/API: identity & roles, auth/session primitives, permission checks, audit log writer, assignment/submission state machine, with unit tests (TDD, vitest).
3. Each task file must contain: exact goal, files owned, interfaces to export, required tests, commands to run, definition of done, and a note that the executor must NOT edit files outside its scope and must NOT edit PLAN_GITEA.md.
4. Choose a shared contract section in docs/IMPL_PLAN.md (types/paths/env var names) so the three tasks compose without conflicts.
5. Commit your docs with message `docs: implementation plan + task split`.

Rules: no network installs, no package installation, no touching product source. Keep total output focused. End with a short summary: chosen task split and any risks.
