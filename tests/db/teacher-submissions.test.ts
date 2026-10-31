import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateDatabase, openSqliteDatabase } from '../../src/db/migrate';
import { TeacherSubmissionsQuery } from '../../src/server/teacher-submissions';
import * as tables from '../../src/db/schema';
import * as relations from '../../src/db/relations';
import type { UserId } from '../../src/shared/contracts';

describe('TeacherSubmissionsQuery', () => {
  let directory: string;
  let sqlite: Database.Database;
  let query: TeacherSubmissionsQuery;
  let nextGiteaId = 1;
  let group: string;
  let course: string;
  let teacher: string;
  let otherTeacher: string;
  let ga: string;

  const user = (login: string) => {
    const id = randomUUID();
    sqlite.prepare('INSERT INTO users (id, gitea_id, login, email, display_name) VALUES (?, ?, ?, ?, ?)')
      .run(id, nextGiteaId++, login, `${login}@jdu.uz`, login);
    return id as UserId;
  };

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'local-github-teacher-submissions-'));
    const databaseUrl = join(directory, 'database.sqlite');
    await migrateDatabase(databaseUrl);
    sqlite = openSqliteDatabase(databaseUrl);
    teacher = user('teacher');
    otherTeacher = user('other');
    group = randomUUID();
    course = randomUUID();
    sqlite.prepare('INSERT INTO groups (id, code, name) VALUES (?, ?, ?)').run(group, 'G', 'Group G');
    sqlite.prepare('INSERT INTO courses (id, owner_id, slug, title) VALUES (?, ?, ?, ?)').run(course, teacher, 'c', 'Course');

    const ca = randomUUID();
    sqlite.prepare('INSERT INTO course_assignments (id, course_id, author_id, title, allow_resubmission) VALUES (?, ?, ?, ?, 1)')
      .run(ca, course, teacher, 'A1');
    ga = randomUUID();
    sqlite.prepare('INSERT INTO group_assignments (id, course_assignment_id, group_id, deadline, published_at) VALUES (?, ?, ?, ?, ?)')
      .run(ga, ca, group, 1_800_000_000_000, 1_700_000_000_000);

    query = new TeacherSubmissionsQuery(drizzle(sqlite, { schema: { ...tables, ...relations } }));
  });

  afterEach(() => {
    sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const linkFor = (studentId: UserId, repoId: number) => {
    const id = randomUUID();
    sqlite.prepare(`INSERT INTO repository_links (id, group_assignment_id, student_id, gitea_repository_id, full_name, status)
      VALUES (?, ?, ?, ?, ?, 'submitted')`).run(id, ga, studentId, repoId, `org/a1-${repoId}`);
    return id;
  };
  const submission = (linkId: string, attempt: number, status: string, sha: string, submittedAt: number) => {
    const id = randomUUID();
    sqlite.prepare(`INSERT INTO submissions (id, repository_link_id, attempt, commit_sha, protected_ref, status, submitted_at, idempotency_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, linkId, attempt, sha, `refs/heads/s/${attempt}`, status, submittedAt, `k-${attempt}-${linkId}`);
    return id;
  };

  it('returns null for a teacher who is not the assignment author', async () => {
    const student = user('jdu-1');
    const link = linkFor(student, 100);
    submission(link, 1, 'submitted', 'a'.repeat(40), 1_700_000_000_000);
    expect(await query.forAssignment(ga, otherTeacher)).toBeNull();
    expect(await query.listSubmissions(ga, otherTeacher)).toEqual([]);
  });

  it('lists submissions newest first with student and group, joining the active review', async () => {
    const alice = user('alice');
    const bob = user('bob');
    const aliceLink = linkFor(alice, 101);
    const bobLink = linkFor(bob, 102);
    const aliceSub = submission(aliceLink, 1, 'revision_required', '1'.repeat(40), 1_700_000_000_100);
    submission(bobLink, 1, 'submitted', '2'.repeat(40), 1_700_000_000_300);
    // Alice's later attempt is newest and carries an active passed review with grade 5.
    const aliceSub2 = submission(aliceLink, 2, 'passed', '3'.repeat(40), 1_700_000_000_500);
    sqlite.prepare(`INSERT INTO reviews (id, submission_id, reviewer_id, decision, feedback, grade, is_active, created_at, updated_at)
      VALUES (?, ?, ?, 'passed', 'Great', 5, 1, 1, 1)`).run(randomUUID(), aliceSub2, teacher);
    // An inactive (superseded) review on attempt 1 must not surface.
    sqlite.prepare(`INSERT INTO reviews (id, submission_id, reviewer_id, decision, feedback, grade, is_active, created_at, updated_at)
      VALUES (?, ?, ?, 'revision_required', 'fix', NULL, 0, 0, 0)`).run(randomUUID(), aliceSub, teacher);

    const rows = await query.listSubmissions(ga, teacher);
    expect(rows.map((r) => r.student.displayName)).toEqual(['alice', 'bob', 'alice']);
    expect(rows[0].attempt).toBe(2);
    expect(rows[0].status).toBe('passed');
    expect(rows[0].review).toEqual({ decision: 'passed', feedback: 'Great', grade: 5 });
    expect(rows[1].review).toBeNull();
    expect(rows[2].review).toBeNull();
    expect(rows.every((r) => r.group.name === 'Group G')).toBe(true);
  });

  it('coerces only integer grades 1–5 and drops out-of-range values', async () => {
    const student = user('carol');
    const link = linkFor(student, 103);
    const sub = submission(link, 1, 'failed', 'f'.repeat(40), 1_700_000_000_900);
    sqlite.prepare(`INSERT INTO reviews (id, submission_id, reviewer_id, decision, feedback, grade, is_active, created_at, updated_at)
      VALUES (?, ?, ?, 'failed', 'no', 0, 1, 1, 1)`).run(randomUUID(), sub, teacher);
    expect((await query.listSubmissions(ga, teacher))[0].review?.grade).toBeNull();
    sqlite.prepare('UPDATE reviews SET grade = 7 WHERE submission_id = ?').run(sub);
    expect((await query.listSubmissions(ga, teacher))[0].review?.grade).toBeNull();
    sqlite.prepare('UPDATE reviews SET grade = 2 WHERE submission_id = ?').run(sub);
    expect((await query.listSubmissions(ga, teacher))[0].review?.grade).toBe(2);
  });

  it('returns empty for an unpublished assignment even for the author', async () => {
    sqlite.prepare('UPDATE group_assignments SET published_at = NULL WHERE id = ?').run(ga);
    expect(await query.forAssignment(ga, teacher)).toBeNull();
    expect(await query.listSubmissions(ga, teacher)).toEqual([]);
  });
});
