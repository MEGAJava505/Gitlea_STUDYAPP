# Gitlea STUDYAPP — showcase

This is a runnable **work-in-progress demo snapshot**, not a finished MVP or production release. The full implementation plan continues separately. Never reset existing data to try this branch.

## Get the exact branch

```sh
git fetch origin
# First checkout, if no local showcase branch exists:
git switch --track origin/showcase
# If showcase already exists, use instead: git switch showcase
git pull --ff-only origin showcase
```

Save your local edits before switching. Do not use force/reset commands.

## Double-click / start

- **Windows:** install and start Docker Desktop (Linux containers, Compose v2), then double-click `Start-Gitlea.cmd`. It calls `scripts/launcher/start.ps1` and keeps errors visible. Native Windows execution is not yet verified.
- **Linux:** install/start Docker Engine + Compose v2 and install Bash/curl; run `chmod +x start.sh && ./start.sh`.
- **macOS:** install/start Docker Desktop; run `chmod +x start.sh Start.command`, then double-click `Start.command` (or `open Start.command`). ZIP downloads can lose executable bits; inspect trusted scripts and use Finder Open if quarantine requires confirmation. Do not disable system-wide security. Native macOS execution is not yet verified.

The launchers resolve their own directory, including paths containing spaces. Existing `.env`, credentials, configured ports and named volumes are preserved. No destructive cleanup/reset is performed.

If `.env` is absent, it is created from `.env.example` with fresh CSPRNG session/admin secrets and production mode; values are not printed. If an existing env is unsafe or lacks required explicit values, startup stops with an actionable error instead of overwriting it. Existing administrator passwords are never automatically reset.

Docker/Compose/engine prerequisites are checked first. The stack starts through the committed Compose file. Only an HTTP200 from the **application** `/api/health` opens the browser, with a bounded readiness wait. Logs are in `logs/launcher/`. First image download/build can take several minutes before readiness polling begins. `GITLEA_NO_BROWSER=1` suppresses browser opening for checks.

Default browser address is the `APP_BASE_URL` in your `.env` (normally `http://localhost:8080`). Resolve occupied ports in your own `.env`; do not stop unrelated applications. A phone cannot use your computer localhost address. Remote QR activation requires a configured reachable HTTPS base URL and completed identity/mail setup.

## What can be demonstrated now

- Actual application shell and role-protected student/teacher pages.
- Teacher course/lesson authoring and group/course/lesson publication services and UI.
- Student published-course and assignment views.
- Durable assignment semantic idempotency, protected Git SHA snapshots, review PR prerequisite, atomic submission/audit, revision/pass/fail and deadline handling (independently checked through real Gitea1.27.3 + production HTTP fixture sessions).

**Important:** this snapshot does not ship a public test-password login or automatically grant roles. Existing identity/SMTP/Gitea configuration must be supplied and verified. Placeholder tokens mean UI-only operation, not a working authenticated education journey.

## Optional temporary view-only preview

At 2026-10-27 04:09UTC, `https://dowci-165-140-166-143.free.pinggy.net` was externally checked on homepage, teacher courses and student assignments. The free tunnel expires about05:04UTC and may later be unavailable. It is an isolated fixture-only read-only SSR preview: scripts/forms/API mutations are blocked; it is **not** an activation/login demo. No production credentials/PII are used.

## Verified versus pending

- Baseline recovery unit suite:358 passed,6 optional-live skipped,0 TODO. Separate pinned-Gitea snapshot live suite6/6; Phase0positive20/negative7. Fresh database migration/seed twice and native production typecheck/lint/build passed.
- Linux launcher actually executed six safe mocked Docker/health/browser cases: CSPRNG env creation, preservation, bad-env refusal, engine failure, production-mode refusal, known-default-password refusal; paths with spaces and health-before-browser checked. `node scripts/launcher/check-linux.mjs "$PWD"` reproduces these non-destructive checks. Bash syntax and real quiet Compose config validation passed.
- Real isolated loopback-only Linux Docker startup compiled and generated all10 pages, but the bounded harness timed out during build tracing. Its isolated project was stopped successfully with volumes preserved. The initial compiler-hook failure was fixed using the bundled SQLite NAPI binary. No complete Docker-stack PASS is claimed.
- Windows/macOS execution and physical-phone/browser scan/activation are **unverified**.

## Current gaps — do not mistake primitives for completed flows

- Real local QR rendering, `/activate` forms, persisted shared QR markers, one-time email-token redemption, and verified OIDC start/callback routes are now integrated. See `docs/SHOWCASE_AUTH.md`. Production SMTP transport is still absent (email returns503); operator OIDC configuration, real browser login, phone scan and live email remain unverified. No full-auth/phone-readiness claim follows from unit tests.
- Actual upload/storage/download of ZIP/PDF/markdown materials remains incomplete.
- Full inline-review/grading UI, isolated Python worker, notifications and outage compensation remain open.
- Pinned Next15.1.3 emitted CVE-2025-66478 warning. A maintained patched upgrade and regression are required before production launch; do not expose this stack publicly.

Formal truthful phases: **0 technical validation ✓;1–5 partial;6–7 pending**. See `docs/EXECUTION_STATUS.md`, `docs/RECOVERY_VERIFICATION.md`, `docs/LAUNCHERS.md` and `PLAN_GITEA.md` for evidence and the remaining full plan.
