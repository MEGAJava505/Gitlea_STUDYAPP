# Demo launcher, QR activation and OIDC

Status: FULL PLAN OPEN. No phase PASS is claimed.
Owner: approved gpt-6-astra design/launcher orchestrator via Codex.
Controller writes the supplied launcher files exactly, verifies them and makes an early focused commit.
Maximum three executors: launcher/controller, QR, OIDC; one orchestrator coordinates.
No production launch until the Next.js 15.1.3 security gate is resolved.

## Launcher/controller lane
Owns Start-Gitlea.cmd, scripts/launcher/start.ps1, start.sh, Start.command,
docs/LAUNCHERS.md and this task document only.
Preserve existing .env, ports, data and unrelated work; no destructive Docker operations.
Verify Linux with safe Docker/health/browser mocks and quiet real Compose config validation.
Cover random secret creation, preservation, bad existing secrets, failures and health-before-browser.
Exercise paths with spaces and GITLEA_NO_BROWSER=1.
Do not launch the live host stack: ports 3000/3001 are owned by other applications.
Windows and macOS execution remain unverified until native checks are recorded.
Review diff and executable bits before the early launcher commit.
Append ignore entries only if absent; do not replace the unknown .gitignore.

## QR lane: first dependency commit, then activation delivery
Owns new activation_tokens schema, its migration and migration journal entries.
Keep the old activations table and existing data intact; it is too narrow for the new contract.
Owns src/server/activation-services.ts as an independent service factory.
Owns src/server/db-activation-repository.ts.
Owns src/app/api/v1/groups/[groupId]/activation-qr/route.ts.
Owns src/app/activate/** and src/app/api/v1/activation/**.
Owns QR tests only; use new files named activation-qr.* or activation-repository.*
in the repository's existing test locations, confirmed before dispatch.
SOLE package manifest and lockfile writer: add maintained qrcode, its types and jose.
Commit dependency additions first; controller integrates that commit before OIDC implementation.
Use local QR rendering; no external QR/token service and no token disclosure in image URLs.
Reuse the existing domain activation.ts contract; it already issues HMAC QR/email strings.
Existing 30 unit tests do not supply production routes, a DB adapter or QR images.
GROUP QR tokens are reusable; EMAIL tokens are single-use.
Preserve expiry/revocation and atomic activation under concurrent requests.
Teacher/admin issuance must be permissioned and group-scoped; add issuance/redemption rate limits.
Require configured public HTTPS APP_BASE_URL for remote QR; reject localhost/loopback destinations.
SMTP unconfigured: return 503 without leaking a token or claiming mail was sent.
Use a test-only injected outbox in tests; never expose a production outbox/token-debug endpoint.
Validate token storage against the existing contract; avoid raw-token logging and unnecessary storage.
Tests first: permissions, expiry, revocation, replay, atomic races, URL checks and SMTP absence.
Prove rendered QR resolves through the actual activation route and preserves GROUP reuse.

## OIDC lane: independent implementation after dependency integration
Owns src/server/oidc-login-services.ts.
Owns src/domain/auth/oidc-verifier.ts.
Owns src/server/gitea-oidc-adapter.ts.
Owns src/app/api/auth/oidc/start/route.ts and src/app/api/auth/oidc/callback/route.ts.
Owns OIDC tests only; use new oidc-* test files in existing test locations.
NO schema, existing production services, package manifest or lockfile writes.
Use jose from QR's integrated dependency commit; never add a competing dependency change.
Reuse existing getServices.sessions for local session creation.
Reject unmapped users; never auto-create an account from provider claims or email.
Verify JWT signature with trusted JWKS, allowed algorithms, issuer, audience, expiry and nonce.
Bind state to the initiating browser, expire it and consume it atomically once.
Use PKCE S256, fixed configured callback URLs and validated local return destinations.
Reject missing/replayed state, bad signatures, unknown keys and mismatched issuer/audience/nonce.
Test mapped login/session issuance, unmapped denial, expiry and callback replay.
Keep tokens, client secrets and authorization codes out of logs and error responses.

## Shared seam and integration order
Before either lane implements storage, inspect existing session/state capabilities read-only.
Agree a minimal server-state port: create browser-bound state and atomically consume before expiry.
OIDC owns the interface in oidc-login-services.ts; QR owns any required state migration/journal.
The controller serially integrates any concrete state adapter or coupled wiring after agreement.
Record exact coupled files before touching them; do not create overlapping writers.
Workers use separate agent/<lane> branches/worktrees and the existing repository test commands.
Do not alter activation domain contracts or shared getServices wiring without controller integration.
Each lane supplies focused regression tests, actual verification output and a reviewed diff.
Controller merges dependency commit, QR and OIDC in dependency order, resolving conflicts explicitly.
Then run shared tests/typecheck/build and a safe isolated activation/login integration scenario.
Verify one negative API case and response data, not only status or mocked unit results.
Review migrations, session cookies, token leakage, permissions, race handling and scope.
Record missing native/live checks honestly; do not turn pending checks into PASS.
QR, OIDC, SMTP delivery, native launchers and the security gate remain separate open acceptance items.
