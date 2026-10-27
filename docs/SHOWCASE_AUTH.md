# Showcase activation and login

## What exists

- Authenticated authorized teacher/admin: `POST /api/v1/groups/{groupId}/activation-qr`, content-type application/json, body `{}`. Response201 includes a local SVG QR, activation URL and expiry. DELETE at the same path revokes its marker using JSON `{ "token": "<own-issued-marker>" }`. No external QR service receives tokens.
- QR URL opens `/activate#qr=...`; the form requests the imported university email. Public `POST /api/v1/activation/email` accepts `qrToken,email`. Group QR is intentionally reusable; individual email links expire and are atomic one-time claims.
- `/activate#email=...` offers token redemption with the imported Student ID through `POST /api/v1/activation/redeem`. Success does not mint a session: verified login is still required. Tokens are in URL fragments rather than server access-log queries.
- Login starts at `/api/auth/oidc/start` with optional local `returnTo`; callback is `/api/auth/oidc/callback`. Only existing mapped Gitea users are allowed. Provider role claims never grant local roles. SignedRS256, trustedJWKS, issuer/audience/expiry/nonce, random browser state, PKCES256 and durable replay protection are checked.

## Explicit configuration — no credentials committed

Set these in your private `.env`, not source files. Docker Compose forwards the variables into the app container.

- `APP_BASE_URL`: reachable public HTTPS origin for activation; localhost/IP URLs intentionally rejected.
- `ACTIVATION_HMAC_SECRET`: at least32 random bytes; persist across restarts, do not reuse passwords.
- OIDC: `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_CALLBACK_URL`, `OIDC_AUTHORIZATION_ENDPOINT`, `OIDC_TOKEN_ENDPOINT`, `OIDC_JWKS_URI`. All endpoints HTTPS; authorization/token/JWKS must have the issuer origin. Callback URL path must be exactly `/api/auth/oidc/callback`; register it with the provider. This strict adapter is not a promise that a given Gitea version exposes an RS256 OIDC issuer. Operator compatibility requires live validation.
- OIDC state is persisted in private `/data/studyapp/oidc-state` in the existing app-data volume. All worker processes must share this private filesystem, not independent replicas. Native runtime can use `OIDC_STATE_DIR`.

## Hard gates

**Production SMTP is NOT wired.** Email endpoint returns503 rather than fake success. The tested `ActivationMail.send({to,url})` injection port needs a production transport before an actual phone→email→activation demonstration. No public debug outbox or test passwords are provided.

Existing imported student/university-email/Gitea identity mapping is required. The flow creates no Gitea account and grants no teacher/admin privilege. No physical-phone/browser/live-provider acceptance is claimed.

Next15.1.3 security remediation remains mandatory before public writable deployment. Do not expose this stack publicly simply to make the QR reachable. Use unit/injected HTTP checks until security and operator configuration are accepted. Full plan remains open.
