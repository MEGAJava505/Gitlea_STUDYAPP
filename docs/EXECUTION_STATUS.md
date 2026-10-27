# Execution Status — Gitlea STUDYAPP

Updated 2026-10-27 04:09 UTC. Recovery branch `agent/recovery-integration-20261026`; implementation `4cf6b7d`, handoff `deab918`, evidence `567722d`. Full plan remains OPEN; main not merged.

Legend: ✓ acceptance demonstrated for the stated scope; ◐ partial implementation or acceptance; ○ pending.

## Formal phases 0–7

- **0 ✓ Technical Gitea validation:** fresh pinned1.27.3 positive20/20, negative7/7; separate protected snapshot live6/6. Includes real Git push/protection, OAuth subject stability and PR comments. Reused existing disposable runtime, not a new cold Compose/TLS deployment.
- **1 ◐ Foundation:** Next/TypeScript/SQLite migrations, repeated seed, lint/typecheck/full suite and production build pass. Cold cross-platform Compose/HTTPS setup and launcher acceptance remain.
- **2 ◐ Identity & administration:** roles/session/group/import/activation/login domain primitives exist. Real local-app QR generation, activation routes/persistence/mail and verified OIDC login are NOT yet delivered. Unit tests are not a successful phone activation.
- **3 ◐ Courses & materials:** actual teacher create/lesson/assign/publish and student published-course pages delivered with real SQLite/page/API tests. Actual uploaded ZIP/PDF/markdown bytes, download/storage integration and full browser workflow remain.
- **4 ◐ Git assignments:** durable semantic key, transaction-bound submission+audit, protected SHA, PR prerequisite, deadline/revision/terminal guards implemented. Fresh production HTTP + real pinned Gitea fixture submit/review/restart cycle passes. Still not a student activated and logged in through the real application UI.
- **5 ◐ Review & grading:** real review PR and revision/pass/fail API state flow present; integrated inline-comment/grading UI and full academic workflow remain.
- **6 ○ Automatic tests & notifications:** isolated Python worker and complete in-app/Telegram/email delivery acceptance pending.
- **7 ○ Reliability & launch:** compensation, comprehensive user journey/security/operations gates pending. Current pinned Next15.1.3 emitted CVE-2025-66478 warning; maintained patched dependency regression is required before production launch.

## Independently verified current evidence

- Full suite358 passed,6 optional-live skipped,0 TODO;39 passed files. Separate live suite6/6 passed, so skipped default tests are not represented as live evidence.
- Current `npm run typecheck`, `npm run lint`, `npm run build`: PASS, `FINAL_RELEASE_EXIT=0`,10/10 static pages plus new dynamic course routes. Private pinned dependencies restored from offline cache after shared dependency artifacts disappeared (cause unproven).
- Fresh SQLite migration + seed twice PASS; populated legacy migration/repeated migration with references and immutable guards PASS.
- Real production HTTP on temporary port3196, real Gitea1.27.3: create snapshot + reviewPR + atomic success audit; same-key replay + stable changed-SHA409; teacher revision → second attempt → pass; terminal rejection; restart and post-deadline replay; fresh late key rejected. Exactly2 durable attempts. Harness exit0 and current fixture organization204/admin-token purge0; previous exact failed harness fixture cleaned. Uses isolated fixture sessions, NOT application-login acceptance.

## Runnable preview NOW

`https://dowci-165-140-166-143.free.pinggy.net`

- Public HTTPS root, `/teacher/courses`, `/student/assignments`: HTTP200 with actual Gitlea demo marker independently verified. POST405; API/admin paths404.
- Isolated standalone build and disposable seeded DB; no production credentials/PII. Original apps3000/3001 and nginx untouched.
- **Read-only preview**, explicitly labelled. Scripts removed, forms disabled, only allowlisted GET views forwarded; fixture role credentials remain server-side. Not a production deployment or working activation/login demo.
- Underlying app still requires authentication: anonymous student/teacher401; fixture sessions200. Does NOT disable production auth.
- Temporary free tunnel expires about05:04UTC; app artifact has four-hour TTL. Parent/watchdog owns refresh/stop if needed.
- Browser screenshot unavailable here: browser tool reports no supported installed browser; HTML/HTTP verified, not visual/browser-click E2E.

## QR/auth: precise answer

**QR activation is not end-to-end implemented yet.** `src/domain/activation.ts` can issue opaque QR/email tokens and specifies HMAC persistence, expiry/revocation, email/group binding and atomic one-time email consumption;30 domain tests pass. The shared group QR is intentionally reusable by the group, while the individual email activation link is one-time.

Missing: local QR matrix/image generator/rendered page, permissioned issuance route, production SQLite activation adapter, mail delivery adapter, public activation screen, phone scan/decode evidence and complete activation→verified login. There are no activation/QR/OIDC/login routes/pages under `src/app` in the integrated build.

`src/domain/login.ts` and `src/domain/auth/session.ts` have25 and6 domain tests; production session lookup and role checks work with fixture sessions. The development arbitrary-user-ID issuance hook is blocked403 in production. No verified app OIDC start/callback is wired. Historical Gitea OAuth validation does not establish application login.

## Active user-priority execution

Actual approved Opus5.5 ClaudeCode orchestrator in `wt-windows-demo-launcher`, current log `/tmp/gitlea-urgent-0407.jsonl`, owns early disjoint allocation plus launcher implementation. Latest instructions explicitly include Windows `.cmd`, Linux `start.sh`, executable macOS `Start.command`, prerequisite checks, preserved env/data, bounded health-before-browser, logs/errors; no destructive reset. Windows/macOS remain unverified unless actually tested. QR/activation is the urgent next lane; verified OIDC login is the other lane, maximum3 total. No launcher commit or QR completion is claimed before real delivery.
