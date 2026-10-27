# Local demo launchers

Status: implementation supplied for controller verification. Full plan OPEN. No Windows or macOS execution has been verified. Linux mock and Compose checks remain pending until the controller runs them. QR activation is not implemented by these launchers.

## Prerequisites and entry points

- Windows: install and start Docker Desktop with Linux containers and Compose v2. Double-click `Start-Gitlea.cmd`; errors pause the window. Windows PowerShell 5.1 is supported.
- macOS: install and start Docker Desktop; double-click executable `Start.command`. If macOS blocks execution, review the downloaded files and allow them using the normal OS security controls.
- Linux: install Docker Engine, Compose v2, Bash and curl; start Docker and give your account permission to use it. Run `./start.sh`, or select Run in Terminal in a file manager that supports executable scripts. Desktop policies can require explicitly enabling executable-file launching; universal Linux double-click behavior cannot be guaranteed by a shell script.
- POSIX files `start.sh` and `Start.command` must retain their executable bits. No Node installation is needed on the host.

Run from any directory, including paths containing spaces. `GITLEA_NO_BROWSER=1` suppresses browser launch, including in Linux CI.

## Configuration and data

The launcher checks Docker CLI, Compose v2 and the running engine. If `.env` is absent, it copies `.env.example`, replaces only NODE_ENV, SESSION_SECRET and GITEA_ADMIN_PASSWORD, and generates each secret from 32 OS-random bytes. NODE_ENV becomes production for application runtime behavior; this is not production deployment approval. New POSIX `.env` files have mode 600. Concurrent creation never overwrites an existing `.env`.

Existing `.env`, ports and volumes are preserved. Missing/placeholder/short SESSION_SECRET or GITEA_ADMIN_PASSWORD stops startup with an actionable message. Existing session secrets require at least 32 characters; administrators must establish that they were generated from at least 32 random bytes. Existing administrator passwords require at least 16 characters. These checks detect obvious unsafe values, not actual entropy. Generate replacements in a password manager and edit `.env` privately. Session-secret rotation invalidates sessions. An existing Gitea administrator password may need a separate supported password change; editing `.env` does not promise to rotate persisted credentials.

The launcher reads only explicit, single-line known dotenv values. It never sources or evaluates `.env`. Simple quoted literals and trailing comments are accepted; interpolation and escapes in validated keys are rejected. Inherited validated configuration variables are rejected to avoid Compose silently overriding those `.env` values. Other inherited Compose settings retain Docker's normal precedence: launch from a clean environment when diagnosing configuration.

Keep APP_BASE_URL pointed at the public application proxy, with its configured port. Default application URL is `http://localhost:8080`; Gitea defaults to host HTTP 3000 and SSH 2222, proxy HTTP 8080 and HTTPS 8443. Existing configured ports are not changed. The app has no direct host port. Port conflicts must be resolved explicitly by the operator; launchers do not stop unrelated applications.

Startup runs `docker compose --env-file .env config --quiet`, then `docker compose --env-file .env up -d --build app gitea proxy`. It never runs down, volume removal, prune or reset. Volumes app-data, gitea-data, caddy-data and caddy-config remain intact. Missing-image/build work can take longer than the subsequent health deadline.

## Readiness, auth and security

After Compose succeeds, poll APP_BASE_URL plus `/api/health` for at most 300 seconds, with bounded individual requests. Only HTTP 200 opens a browser. Redirects are not followed, TLS verification is not bypassed, and proxy `/health` is not an application readiness signal. Network/OS scheduling can add small overhead to the deadline. A failed health check leaves containers and data available for diagnosis.

UI readiness does not prove QR activation, provisioning, OIDC login or email delivery. Placeholder/unset Gitea API token, OAuth/OIDC credentials or SMTP settings mean UI-only operation. The launchers explicitly warn about this; they do not invent OAuth variable names or certify an auth configuration. Follow the existing `.env.example` and verify actual auth flows separately. SMTP_HOST=smtp.local is an unconfigured demo value.

SECURITY GATE OPEN: the current Next.js 15.1.3 dependency needs security review and remediation before production launch or public exposure. A successful launcher run does not close that gate. Use a trusted local demo environment; inspect Docker binding/firewall settings before running because published ports may be reachable from other machines.

## Diagnosis and verification

Timestamped command output is in `logs/launcher/`. Configuration is validated without printing expanded Compose configuration; secrets and health response bodies are not deliberately printed. Treat build/service logs as potentially sensitive and review them before sharing.

For service diagnostics, run `docker compose --env-file .env logs --tail 100 app gitea proxy`. Check Docker Desktop/engine status, available configured ports, APP_BASE_URL and Gitea health. The launcher does not collect or upload these logs.

Controller verification must include Bash syntax, actual Linux execution with safe Docker/curl/browser mocks, secret creation and unchanged-existing-file assertions, unsafe-secret rejection, Compose failure, non-200/redirect/timeout behavior, browser ordering, and paths containing spaces. Run real Compose config validation only with isolated generated demo configuration and quiet output. Do not start the live host stack: ports 3000/3001 belong to other applications. Mock validation does not prove a live deployment. Windows PowerShell and macOS double-click checks remain explicit open items until performed on those platforms.

## Controller verification receipt — 2026-10-27

The launcher/design artifacts were authored by actual gpt-6-astra through Codex as complete file payloads because that provider route exposed no filesystem tools; the technical controller applied them. Linux Bash execution passed six non-destructive mocked Docker/health/browser cases, including a directory containing spaces, new CSPRNG env, unchanged existing env, engine refusal, production-only refusal and known-development-password refusal. Browser opening was checked after app health. Run `node scripts/launcher/check-linux.mjs "$PWD"`; `bash -n start.sh`, `bash -n Start.command` and real `docker compose --env-file .env.example config --quiet` also pass.

Red-capable checks found and fixed acceptance of existing `NODE_ENV=development`, the known Compose development password, and a PowerShell function named Docker recursively invoking itself. Windows/macOS runtime execution remains UNVERIFIED; static review is not a native test. Existing env files are never rewritten.

Inspected Compose bootstrap also expanded container credentials prematurely and recreated an existing administrator on every restart. Container variables are now escaped through Compose and bootstrap skips an existing nonempty SQLite DB; existing accounts/data are not reset. The application image uses Node24 (better-sqlite313 requires >=22), the committed lockfile, explicit migration files and a secret-excluding Docker context. A separate real Linux Docker launch/restart check is in progress; no full-stack or native Windows/macOS PASS is claimed here.
