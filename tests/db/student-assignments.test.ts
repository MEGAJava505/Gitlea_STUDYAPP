import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateDatabase, openSqliteDatabase } from '../../src/db/migrate';
import { StudentAssignmentsQuery } from '../../src/server/student-assignments';
import * as tables from '../../src/db/schema';
import * as relations from '../../src/db/relations';
import type { UserId } from '../../src/shared/contracts';

describe('StudentAssignmentsQuery', () => {
  let directory: string;
  let sqlite: Database.Database;
  let query: StudentAssignmentsQuery;
  let nextGiteaId = 1;
  let groupA: string;
  let groupB: string;
  let course: string;
  let teacher: string;

  const user = (login: string) => {
    const id = randomUUID();
    sqlite.prepare('INSERT INTO users (id, gitea_id, login, email, display_name) VALUES (?, ?, ?, ?, ?)')
      .run(id, nextGiteaId++, login, `${login}@jdu.uz`, login);
    return id as UserId;
  };
  const member = (groupId: string, userId: string, state = 'active') =>
    sqlite.prepare('INSERT INTO group_members (id, group_id, user_id, state, left_at) VALUES (?, ?, ?, ?, ?)')
      .run(randomUUID(), groupId, userId, state, state === 'active' ? null : Date.now() + 1000);
  const assignment = (groupId: string, title: string, published = true) => {
    const ca = randomUUID();
    const ga = randomUUID();
    sqlite.prepare('INSERT INTO course_assignments (id, course_id, author_id, title, allow_resubmission) VALUES (?, ?, ?, ?, 1)')
      .run(ca, course, teacher, title);
    sqlite.prepare('INSERT INTO group_assignments (id, course_assignment_id, group_id, deadline, published_at) VALUES (?, ?, ?, ?, ?)')
      .run(ga, ca, groupId, 1_800_000_000_000, published ? 1_700_000_000_000 : null);
    return ga;
  };

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'local-github-student-assignments-'));
    const databaseUrl = join(directory, 'database.sqlite');
    await migrateDatabase(databaseUrl);
    sqlite = openSqliteDatabase(databaseUrl);
    teacher = user('teacher');
    groupA = randomUUID();
    groupB = randomUUID();
    course = randomUUID();
    sqlite.prepare('INSERT INTO groups (id, code, name) VALUES (?, ?, ?), (?, ?, ?)').run(groupA, 'A', 'A', groupB, 'B', 'B');
    sqlite.prepare('INSERT INTO courses (id, owner_id, slug, title) VALUES (?, ?, ?, ?)').run(course, teacher, 'c', 'Course');
    query = new StudentAssignmentsQuery(drizzle(sqlite, { schema: { ...tables, ...relations } }));
  });

  afterEach(() => {
    sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('lists only published assignments of the student\'s active groups', async () => {
    const student = user('jdu-1');
    member(groupA, student);
    const visible = assignment(groupA, 'Visible');
    const draft = assignment(groupA, 'Draft', false);
    const otherGroup = assignment(groupB, 'Other group');

    expect((await query.list(student)).map((a) => a.title)).toEqual(['Visible']);
    expect(await query.get(student, otherGroup)).toBeNull();
    expect(await query.get(student, draft)).toBeNull();
    expect((await query.get(student, visible))?.status).toBe('not_started');
  });

  it('hides assignments from inactive members', async () => {
    const student = user('jdu-2');
    member(groupA, student, 'inactive');
    const ga = assignment(groupA, 'A1');
    expect(await query.list(student)).toEqual([]);
    expect(await query.get(student, ga)).toBeNull();
  });

  it('returns only the student\'s own repository and attempts, newest first', async () => {
    const student = user('jdu-3');
    const classmate = user('jdu-4');
    member(groupA, student);
    member(groupA, classmate);
    const ga = assignment(groupA, 'A1');
    const link = randomUUID();
    sqlite.prepare(`INSERT INTO repository_links (id, group_assignment_id, student_id, gitea_repository_id, full_name, status)
      VALUES (?, ?, ?, ?, ?, 'revision_required')`).run(link, ga, student, 900, 'org/a1-jdu-3');
    for (const attempt of [1, 2]) {
      sqlite.prepare(`INSERT INTO submissions (id, repository_link_id, attempt, commit_sha, protected_ref, status, submitted_at, idempotency_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), link, attempt, String(attempt).repeat(40),
        `refs/heads/submission/${attempt}`, attempt === 1 ? 'revision_required' : 'submitted', 1_700_000_000_000 + attempt, `key-${attempt}`);
    }

    const mine = await query.get(student, ga);
    expect(mine?.status).toBe('submitted');
    expect((await query.list(student))[0].status).toBe('submitted');
    expect(mine?.repository).toEqual({ fullName: 'org/a1-jdu-3' });
    expect(mine?.attempts.map((a) => a.attempt)).toEqual([2, 1]);
    const theirs = await query.get(classmate, ga);
    expect(theirs?.repository).toBeNull();
    expect(theirs?.attempts).toEqual([]);
    expect((await query.list(classmate))[0].status).toBe('not_started');

    for (const status of ['revision_required', 'passed', 'failed']) {
      sqlite.prepare('UPDATE submissions SET status = ? WHERE repository_link_id = ? AND attempt = 2').run(status, link);
      expect((await query.get(student, ga))?.status).toBe(status);
      expect((await query.list(student))[0].status).toBe(status);
    }

    // An automatic deadline failure is authoritative even if an old attempt
    // still says revision_required; read-model repair must not reopen it.
    sqlite.prepare("UPDATE submissions SET status = 'revision_required' WHERE repository_link_id = ? AND attempt = 2").run(link);
    for (const terminal of ['failed', 'passed']) {
      sqlite.prepare('UPDATE repository_links SET status = ? WHERE id = ?').run(terminal, link);
      expect((await query.get(student, ga))?.status).toBe(terminal);
      expect((await query.list(student))[0].status).toBe(terminal);
    }
  });
});
