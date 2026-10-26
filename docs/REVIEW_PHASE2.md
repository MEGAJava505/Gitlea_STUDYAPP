# Phase 2 review — blocked

Reviewed `main...HEAD` on `agent/phase2`:

- Base: `10b1b03d3d91e7e88a53c76c8eb5ad2e5d9804fa`.
- HEAD: `d74689f95f4b5bd3e0b992d396b92233b0d0e648`.
- `git diff main...HEAD --stat`: `16 files changed, 1367 insertions(+)`.
- Requirements: `PLAN_GITEA.md` §§3, 4, 5, 14, 16.2; shared contracts and review gates in `docs/IMPL_PLAN.md`.

## Standards

1. **P1 — New panel pages cannot run with the application service wiring.** `src/app/(panels)/admin/page.tsx:7`, `src/app/(panels)/student/page.tsx:7`, and `src/app/(panels)/teacher/page.tsx:7` call `getServices()`. The container starts null at `src/server/auth-context.ts:70`; `:78` throws when unconfigured. There is no production call to `configureServices`; its only caller is `tests/api/assignment-routes.test.ts:79`. All three new routes returned HTTP 500 in the live check below. The missing bootstrap already exists on `main`, but these new pages depend on it and cannot meet the requested working-panel result. `tests/api/panels.test.ts:82` exercises helpers, not page rendering. Supplied AGENTS.md §6 requires a real web scenario; `docs/IMPL_PLAN.md:125` requires integrated live checks. Wire production services and verify authorized access plus an unauthenticated/forbidden response through the actual pages.

2. **P2 — Group audit events bypass the shared event contract.** `src/domain/groups/service.ts:96` casts four `group.*` event names to `AuditInput['eventType']`, although none belongs to `AuditEventType` at `src/shared/contracts.ts:200`. This introduces runtime values excluded by the declared shared contract. `docs/IMPL_PLAN.md:112` identifies the shared service types, and `:125` requires review of undocumented contract changes. Add the event literals to the shared contract and remove the assertion. No persistence rejection is claimed: this is a demonstrated contract mismatch.

## Spec

1. **P1 — Successful activation has no audit event.** At `src/domain/activation.ts:92`, `repository.activate()` changes the account to active; `:96` returns without writing an audit event. Only the conflict path at `:99` calls the audit writer. §16.2 requires “Активация аккаунтов и конфликтные попытки.” A direct call with an injected recording audit writer produced `activationState: "active"` and `auditEvents: []`. The repository contract also does not require an activation audit. Record successful activation as part of the mutation and add an assertion for it; existing success tests do not cover this requirement.

2. **P1 — Import accepts identities the authentication services cannot use.** `src/domain/groups/import.ts:100` checks only whether Student ID and email are nonempty; `:113` returns the row as valid. A direct call accepted `abc,not-an-email` with no errors. §4.1 requires “проверяет дубликаты и корректность идентификаторов”; §4.3 specifies university email. The new login code accepts numeric IDs only, and activation accepts `@jdu.uz` addresses only. Validate these fields before marking rows usable. The import also lacks the §4.3 calculation of expected email from Student ID and first-name initial.

3. **P2 — Repeat imports reject every existing student instead of matching records.** `src/domain/groups/import.ts:104` emits `existing_student_id` for every existing ID, and `:113` excludes that row from the result. A direct call with an unchanged existing student produced an empty `rows` array and an error. §5.2 requires previews of “Уже существующие студенты” and “Изменённые данные,” matched by Student ID. `tests/domain/groups-import.test.ts:18` explicitly expects blanket rejection. Classify existing/changed records for preview rather than treating the existence of an ID as an invalid row. No destructive deletion behavior was found.

## Command results

All four requested checks ran against the reviewed HEAD and exited 0:

```text
$ ./node_modules/.bin/tsc --noEmit
(no output)

$ ./node_modules/.bin/next lint
✔ No ESLint warnings or errors

$ ./node_modules/.bin/vitest run
 Test Files  13 passed (13)
      Tests  149 passed (149)
   Start at  05:25:11
   Duration  14.09s (transform 1.93s, setup 0ms, collect 7.03s, tests 4.26s, environment 29ms, prepare 5.93s)

$ ./node_modules/.bin/next build
   ▲ Next.js 15.1.3
 ✓ Compiled successfully
 ✓ Generating static pages (9/9)
```

`git diff main...HEAD --check` exited 0 with no output.

Live HTTP check: started `./node_modules/.bin/next start -p 3187`, then requested `/student`, `/teacher`, and `/admin` using `curl -i --max-time 5`. Each curl exited 0 and each response contained:

```text
HTTP/1.1 500 Internal Server Error
```

The server logged the following error once for each page:

```text
 ⨯ Error: Application services are not configured
```

The server also warned:

```text
 ⚠ "next start" does not work with "output: standalone" configuration. Use "node .next/standalone/server.js" instead.
```

It nevertheless reached Ready and handled the HTTP requests above. After stopping it, the recommended standalone entry point was attempted with `PORT=3188 HOSTNAME=127.0.0.1 node .next/standalone/server.js`. It exited 1:

```text
Error: Cannot find module '../../lib/get-network-host'
Require stack:
- /home/agent/.openclaw/workspace/wt-phase2/.next/Gitlea_STUDYAPP/node_modules/next/dist/server/lib/start-server.js
- /home/agent/.openclaw/workspace/wt-phase2/.next/standalone/server.js
```

This standalone packaging/runtime failure is recorded as a verification limit; it is not attributed to the new source changes.

An inline `tsx --input-type=module` probe imported the production parser and activation service. The activation probe injected a repository returning successful activation and a recording audit writer; it did not test database atomicity. Exit 0, exact output:

```text
invalid import: {"rows":[{"row":2,"studentId":"abc","email":"not-an-email","cells":{"Student ID":"abc","Email":"not-an-email"}}],"errors":[],"warnings":[]}
repeat import: {"rows":[],"errors":[{"row":2,"code":"existing_student_id","message":"Student ID already exists"}],"warnings":[]}
activation: {"activationState":"active","auditEvents":[]}
```

## Other reviewed behavior and limits

- Password generation uses crypto randomness, seven lowercase-letter/digit characters in the required 3/4 compositions, shuffling, and HMAC reservation. Global reservation is delegated to a repository interface; no production adapter is included.
- Activation distinguishes the reusable shared group QR from single-use email links. Expiry, revocation, matching, replay conflicts and conflict audit have passing tests. Atomic consumption and concurrent activation are implemented in the test fake and required by the repository contract, not verified against a production adapter.
- Panel role checks are server-side, permit combined roles, and permit Owner/Admin access to the admin panel. Admin page markup contains no owner-only sensitive data. Working authenticated navigation was not verified because service bootstrap is absent.
- New activation/login/group domain services have no production callers or adapters in this checkout. Group mutations and QR issuance also have no implemented application authorization boundary; QR issuance explicitly delegates authorization to its caller. This is an integration gap, not a demonstrated remotely reachable authorization bypass.
- The diff adds files only. No skipped tests, weakened existing tests, committed secrets/tokens, swallowed errors, debug logging, client-side authorization, or demonstrated unrelated scope expansion were found.

Standards: 2 findings; highest severity P1, unusable panel routes. Spec: 3 findings; highest severity P1, missing successful-activation audit and invalid import identities.

Merge SHA: none created. Push: not attempted. Branch remains `agent/phase2`.
