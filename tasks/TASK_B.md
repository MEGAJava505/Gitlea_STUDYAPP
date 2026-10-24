# TASK_B - Drizzle data layer

## Exact goal

Implement the SQLite/Drizzle foundation for every entity named in PLAN_GITEA.md section 15.4. Add constraints, indexes, migration SQL, and deterministic seed data for Phase 1. Prove the required invariants with database tests; do not implement HTTP handlers, authentication policy, or assignment business transitions.

## Files owned

Only these paths may be created or edited by this task:

    drizzle.config.ts
    src/db/client.ts
    src/db/schema.ts
    src/db/relations.ts
    src/db/migrate.ts
    src/db/seed.ts
    drizzle/**
    scripts/seed.ts
    tests/db/**

The executor must not edit files outside this list and must not edit PLAN_GITEA.md. In particular, do not edit package.json, src/shared/**, src/domain/**, src/server/**, src/app/**, or Task C tests. Use the scripts and dependency versions supplied by Task A.

## Interfaces to export

- drizzle.config.ts points Drizzle Kit at src/db/schema.ts, DATABASE_URL, and the drizzle/ output directory.
- src/db/client.ts exports db and type Db, with SQLite foreign keys enabled for every connection.
- src/db/schema.ts exports table definitions, enum-like literal checks, and inferred select/insert types for all of: users, userRoles, studentProfiles, activations, groups, groupMembers, courses, courseGroups, lessons, lessonPublications, courseAssignments, groupAssignments, repositoryLinks, submissions, reviews, testDefinitions, testRuns, notifications, notificationPreferences, outageIncidents, compensationWindows, auditEvents, and systemSettings.
- src/db/migrate.ts exports an idempotent migrateDatabase(databaseUrl?: string): Promise<void>.
- src/db/seed.ts exports seedDatabase(databaseUrl?: string): Promise<void>; seed rows are deterministic and safe to run twice.
- scripts/seed.ts is a thin executable wrapper for the package db:seed script and must not contain schema definitions.

## Schema contract

Use opaque UUID text IDs and UTC epoch-millisecond timestamps. Include created/updated timestamps where the entity can change. The minimum columns and constraints are:

- User: Gitea external ID, login, email, display name; unique Gitea ID, login, and normalized email.
- UserRole: user ID, exact role (student, teacher, admin, owner); unique user/role pair.
- StudentProfile: user ID, unique Student ID, expected university email, activation state; unique user and normalized expected email.
- Activation: student/user reference, token HMAC, expiry, used timestamp, created timestamp; unique active token HMAC.
- Group: code and name; unique code.
- GroupMember: group/user references, membership state and dates; unique group/user pair.
- Course: owner reference, slug, title, description, publication timestamp; unique slug.
- CourseGroup: course/group references; unique pair.
- Lesson: course reference, position, title, content metadata; unique course/position.
- LessonPublication: lesson/group references and published timestamp; unique lesson/group pair.
- CourseAssignment: course and author references, title/description, resubmission policy, created timestamp.
- GroupAssignment: course-assignment/group references, deadline, publication timestamp; unique course-assignment/group pair and a check that deadline is not null once published.
- RepositoryLink: group-assignment/student references, Gitea repository ID/full name, private flag; unique assignment/student and Gitea repository identity.
- Submission: repository link, positive attempt number, non-null commit SHA, protected ref, status, submitted timestamp; unique repository-link/attempt and unique repository-link/ref. Add a migration trigger or equivalent guard that rejects changing or deleting the stored commit SHA for an existing submission.
- Review: submission/reviewer references, decision, feedback, optional numeric grade, created/updated timestamps; one active review per submission.
- TestDefinition: group-assignment reference, name, source reference, visible/hidden mode, created timestamp.
- TestRun: test-definition/submission references, status, output metadata, started/completed timestamps; unique definition/submission/run key for idempotent reruns.
- Notification: recipient, event type, deduplication key, payload, read timestamp, created timestamp; unique recipient/deduplication key.
- NotificationPreference: user, channel, enabled flag; unique user/channel.
- OutageIncident: service, start/end timestamps, confirmation flag, details.
- CompensationWindow: outage reference, start/end timestamps, reason; no overlapping window for one incident.
- AuditEvent: actor, event/target type and ID, structured payload, UTC timestamp; append-only table with indexes for actor, target, and time.
- SystemSetting: unique key, value, updated timestamp; no duplicate keys.

Foreign keys must be explicit and restrictive by default; use cascade only for join rows whose parent deletion is already forbidden by the domain.

## Required tests (write invariant tests before implementation)

tests/db/invariants.test.ts must use a temporary SQLite database and cover:

1. Two student profiles with the same Student ID fail with the database unique constraint.
2. Two users or student profiles with the same normalized university email fail with the database unique constraint.
3. Attempt numbers 1 and 2 succeed for one student/assignment, a duplicate attempt number fails, and numbering is independent for another student.
4. Updating or deleting a submission commitSha fails, and the original SHA remains readable.
5. Seed and migration calls are idempotent and foreign-key violations fail.
6. A notification dedupe key cannot create duplicate rows for the same recipient.

Tests must assert the error or behavior rather than swallowing exceptions. A deliberately broken schema or trigger must make the relevant test fail before implementation is written.

## Commands to run

    npm run typecheck
    npm run test:unit -- tests/db
    npm run db:generate
    npm run db:migrate
    npm run db:seed
    npm run db:seed

The second seed invocation must succeed without adding duplicate rows. Inspect generated SQL and run the invariant suite against a fresh temporary database. Do not run a package installation or edit Task A scripts to work around a failure.

## Definition of done

- Every section 15.4 entity is represented in src/db/schema.ts, has migration SQL under drizzle/**, and is covered by relations or documented as intentionally relationless.
- The four required invariants have database-enforced checks and red/green tests.
- Migrations apply to a new SQLite file and are idempotent through the exported migration function.
- Seed data is deterministic, contains no real credentials, and can run twice.
- Typecheck and database tests pass with no skipped assertions.
- The diff contains no API/domain code, secrets, generated runtime artifacts, or edits outside the ownership list.
