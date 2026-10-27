# NEXT_IMPLEMENTATION_SLICE — Material Blob Pipeline and Verified OIDC Login

**Status:** Design orchestrator allocation only. Controller executes. ≤170 lines.
**Prior:** atomic audit+repo tx (3250cab/abf634b), teacher courses UI (531dc6d/c53cd72), durable QA (4cf6b7d/cc92118).
**Verified now:** 358 unit PASS, 6 optional live skipped, 0 TODO; typecheck/lint PASS; fresh migration+seed twice; snapshot live 6/6 PASS. Build rerun active after controller restored 425 pinned packages from offline cache (better-sqlite3 NAPI on SQLite 3.53.4). No phase PASS.

## Current gaps
Materials: `POST /api/v1/lessons/{lessonId}/materials` accepts caller-supplied `storedPath/sha256/size`, no bytes, no persistence, no download; `production-services.ts` has no materials service (B renders honest 503). Auth: session primitives only; no start/callback routes, no state/nonce, no provider verification.

## Lane A — Material Persistence, Blob Storage, Service Seam
**Model:** claude-opus-5-5 or claude-sonnet-5-5. **Sole owner of `src/server/production-services.ts`.**

Files: `src/db/schema.ts`; `src/server/db-materials-repository.ts` (new); `src/domain/materials/service.ts`; `src/server/ports/blob-storage.ts` (new); `src/server/blob-storage-filesystem.ts` (new); `src/domain/materials/zip.ts` (extend only if real-byte hardening needs it); `src/server/production-services.ts`; `tests/db/materials-repository.test.ts`; `tests/domain/materials-service.test.ts`.

Schema/migration: `materials` table (`id`, `lesson_id` FK, `filename`, `content_type`, `stored_path`, `size_bytes`, `sha256`, `uploaded_by` FK, timestamps), unique `(lesson_id, filename)`, nonempty/`sha256` hex checks; guarded `IF NOT EXISTS` migration; update `tests/db/idempotency-migration.test.ts` fixtures if required by schema additions.

BlobStorage port: `store(bytes: Uint8Array, expectedSha256: string): Promise<{storedPath: string}>`; `retrieve(storedPath: string): Promise<Uint8Array>` (internal to A only). Filesystem impl: content-addressed `data/materials/<sha256[0:2]>/<sha256>`, atomic temp+rename, `O_NOFOLLOW` semantics, rejects traversal/symlink targets, 50 MiB/file cap, idempotent on repeated SHA.

Real-byte archive validation (before persistence; never trust a client manifest): parse actual bytes with the existing `extractZipManifest` decompressor and enforce absolute/`..`/backslash paths, symlink entries (`externalAttributes` mode), nested archives, encrypted/data-descriptor entries, per-entry cap, **cumulative uncompressed total** and entry count, using `inflateRawSync maxOutputLength` so a bomb cannot expand. Reject before any store; store only validated bytes.

Public service contract (B consumes exactly this; `storedPath` never leaves A):
- `uploadBlob(input: {actor: SessionPrincipal; lessonId: string; filename: string; contentType: string; bytes: Uint8Array}): Promise<MaterialView>` — authorizes via existing `canManageLesson`, validates filename/contentType/size, ZIP-validates when `application/zip` or `.zip`, computes SHA-256 from bytes, stores, inserts row.
- `list(actor, lessonId): Promise<MaterialView[]>` — `MaterialView = {id, lessonId, filename, contentType, size, sha256, createdAt}` (no path).
- `openDownload(input: {actor; materialId}): Promise<{filename; contentType; size; sha256; bytes: Uint8Array}>` — authorizes (student: published lesson in enrolled group; teacher/admin: manage), reads blob, re-verifies SHA-256 against the row, throws `integration` on mismatch (no bytes returned).
- `attach()` removed from the public surface (metadata-only path deleted); update the existing route minimally in A only to call `uploadBlob`'s no-bytes guard or leave route edits to B — **A must not edit B-owned routes**; instead A exposes the service on `getServices().materials`.

Wiring: `production-services.ts` constructs `DbMaterialsRepository` + filesystem `BlobStorage` + `MaterialsService` and registers it under `materials`; absent storage root env → service omitted (existing 503 path stays honest).

Tests: byte upload round-trip exact SHA; wrong declared SHA rejected; ZIP traversal/symlink/bomb/entry-count/total-size rejected using constructed archives; concurrent same-SHA idempotent; `openDownload` returns exact bytes; unauthorized actor denied; download SHA mismatch throws.

## Lane B — Upload/Download HTTP and Existing-Page UI
**Model:** claude-opus-5-5 or claude-sonnet-5-5. **No `production-services.ts`, no schema, no deps.**

Files: `src/app/api/v1/lessons/[lessonId]/materials/upload/route.ts` (new multipart POST); `src/app/api/v1/materials/[materialId]/download/route.ts` (new GET); `src/app/api/v1/lessons/[lessonId]/materials/route.ts` (existing, consumer rewrite); `src/app/(panels)/teacher/courses/material-list.tsx` (existing — add upload form + per-file download links); existing teacher course/lesson page from c53cd72 (locate, do not rename); existing student published-courses page from c53cd72 extended with materials links; `tests/api/material-upload.test.ts`; `tests/api/material-download.test.ts`.

Contract: upload route parses `multipart/form-data`, rejects >50 MiB and non-file bodies, calls `getServices().materials.uploadBlob(...)`, returns 201 `MaterialView`, 503 when service absent, stable 400/403 JSON. Download route calls `openDownload`, returns raw bytes with row `Content-Type` and `Content-Disposition: attachment; filename="<sanitized>"`, `X-Content-Type-Options: nosniff`, honors Range-off (full body only); 401/403/404 stable. UI: existing page gets a file input + submit + status, and each listed material gets a download anchor; student page links to the same download route. No `storedPath` construction in B.

Tests: multipart upload → download byte equality; unauthorized upload/download 403; oversized rejected; absent service 503; traversal filename rejected.

## Lane C — Verified OIDC Login (independent factory seam)
**Model:** claude-opus-5-5 or claude-sonnet-5-5. **Sole owner of `package.json`/`package-lock.json`** (only if a maintained library is needed). **Does not edit `production-services.ts`, `schema.ts`, or any A/B file.**

Files: `src/server/oidc-login-services.ts` (new factory, C's integration seam); `src/app/api/auth/oidc/start/route.ts`; `src/app/api/auth/oidc/callback/route.ts`; `src/domain/auth/oidc-verifier.ts`; `src/server/ports/oidc-provider.ts`; `src/server/gitea-oidc-adapter.ts`; `tests/domain/oidc-verifier.test.ts`; `tests/api/oidc-login.test.ts`.

Seam: `createOidcLoginServices(env, deps): {verifier, provider, sessions}` is exported from `oidc-login-services.ts` and consumed directly by C's routes; it reuses existing `SessionStore`/session repository and identity lookup. If shared wiring is ever needed, controller applies a one-line `production-services.ts` patch itself — C never touches it.

Start route: generate 32-byte CSPRNG `state` and `nonce`; set both in an httpOnly, Secure, SameSite=Lax cookie (Max-Age 600) plus a short-lived start marker; `302` to the provider authorization endpoint with `client_id`, `redirect_uri`, `response_type=code`, `scope=openid email profile`, `state`, `nonce`. No user id in any parameter.

Callback: reject without cookie or on `state` mismatch (constant-time compare); exchange `code` via `OidcProvider.exchangeCode`; verify the ID token with a maintained JOSE/OIDC library — signature via JWKS, `iss`, `aud`, `exp`, `nbf`, and `nonce` equality — then extract `sub`. Consume the cookie (single use) on every path. Map `sub`/`gitea_id` to an existing user **only**; unmapped subject → generic 403, never implicit account creation. On success create the existing session cookie and redirect to the app; on any failure generic error, no subject/id echoed.

`OidcProvider` port: `authorizationUrl`, `exchangeCode(code)`, `jwks()`; Gitea adapter reads `GITEA_OIDC_CLIENT_ID/SECRET/ISSUER` from env — absent → factory returns null and routes answer 503 (no secret in code, no config edits).

Tests: start sets random state+nonce and redirects; callback happy path creates session for a mapped user; state mismatch/replay/expired cookie rejected; nonce mismatch rejected; tampered/expired/wrong-issuer/wrong-audience token rejected; unmapped subject 403 with no user row created; 503 without env.

## Security gate (pinned; blocks launch and Phase 7)
Offline `npm ci` warned the current Next 15.1.3 is affected by CVE-2025-66478. **Do not upgrade in this doc-only run.** Acceptance of launch/Phase 7 requires a maintained patched Next upgrade plus full regression (typecheck, lint, unit, build, migration, live harness) under a single dedicated dependency-owner lane. B and A must not edit dependencies; C may add only the OIDC/JOSE library it needs.

## Acceptance separation
Implementation acceptance = lane tests green plus typecheck/lint/full suite with no new TODOs, controller-recorded. Browser evidence, operator-provided OIDC secrets/config, and phase gates remain separate; none of A/B/C closes a phase.
Still open: Phase 2 QR activation/email/two-panel, Phase 3 ZIP browse UI, Phase 4 authenticated submit cycle, Phase 5–7, dependency gate above. No full PASS.

**End.**
