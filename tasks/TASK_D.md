# TASK D — Phase 3 slice 1: courses, lessons, per-group publication (backend)

Scope: backend services, API routes and tests for `PLAN_GITEA.md` §6 and §7 (excluding file/ZIP storage). No UI work in this slice.

## Must implement

1. **Course service** (`src/domain/courses/`, exported through the same pattern as `src/domain/groups/`):
   - `createCourse`: teacher/admin/owner only; slug normalized `[a-z0-9-]`, unique; owner = creator.
   - `updateCourse`, `publishCourse`: only the course owner, admin, or owner-with-admin-powers (reuse `src/domain/permissions.ts`). Other teachers get a typed `forbidden` error.
   - `listLibrary`: courses visible to a teacher (own + published), and for a student only courses assigned to their groups.
   - `assignCourseToGroup`: the course owner, admin/owner, or a teacher assigning a published course to a group they teach. Idempotent on `(courseId, groupId)`.
2. **Lessons**:
   - Author/admin/owner create, edit, reorder lessons; positions stay dense and unique per course.
   - `publishLessonToGroup`: per-group and idempotent; publishing to group A must not expose the lesson to group B (use `lesson_publications`).
   - Student-facing read returns only published lessons for the student's groups.
3. **Extra assignments** (§6.4): a teacher using someone else's course may create `course_assignments` + `group_assignments` scoped to their own group only; must not mutate the course or other groups. Enforce deadline/published pairing already in the schema.
4. **API routes** under `src/app/api/v1/courses/` (list, create, update/publish, assign group), `.../lessons/` (create, update, publish), and extra assignments. Reuse `src/server/auth-context.ts`; return JSON, typed errors mapped to 400/403/404/409; never leak tokens.
5. **Tests** in `tests/domain/courses.test.ts` and `tests/api/courses.test.ts`:
   - permission matrix for edit/publish (owner, other teacher, admin, student)
   - publication isolation between two groups
   - student visibility only for assigned+published lessons
   - extra assignment isolation (own group only, course untouched)
   - slug conflict and idempotent assign/publish

## Constraints

- Reuse existing tables in `src/db/schema.ts`; do **not** edit `src/db/schema.ts`, `drizzle/`, or existing migrations. If a column is genuinely missing, report it instead of changing the schema.
- No new npm dependencies. No network installs.
- Follow existing service style: `Db` + injected `clock` for deterministic tests; typed result/error objects, no throwing raw strings.
- Keep existing 151 tests green: `npm run typecheck`, `npm run lint`, `npm run test:unit` must all pass.
- Commit on the current branch (`agent/phase3`) as soon as the first coherent green slice exists, then continue. Message: `feat(courses): course library, lesson publication, extra assignments`.
- Finish with a final line `PHASE3_SLICE1_DONE=<sha>` and a short summary of files added, test counts, and anything deferred to slice 2 (materials/ZIP/UI).
