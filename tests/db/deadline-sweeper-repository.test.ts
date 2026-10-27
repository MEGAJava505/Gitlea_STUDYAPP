import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateDatabase, openSqliteDatabase } from '../../src/db/migrate';
import { DbDeadlineSweeperRepository } from '../../src/server/db-deadline-sweeper-repository';
import * as tables from '../../src/db/schema';
import * as relations from '../../src/db/relations';
import type { RepositoryLinkId } from '../../src/shared/contracts';

const lid = (s: string) => s as RepositoryLinkId;

describe('DbDeadlineSweeperRepository', () => {
  let directory: string;
  let databaseUrl: string;
  let sqlite: Database.Database;
  let groupId: string;
  let assignmentId: string;
  let nextGiteaId: number;
  let repo: DbDeadlineSweeperRepository;
  const NOW = 1700000100000; // deadline used below is 1700000000000 (already past)

  const user = (login: string) => {
    const id = randomUUID();
    sqlite.prepare('INSERT INTO users (id, gitea_id, login, email, display_name) VALUES (?, ?, ?, ?, ?)')
      .run(id, nextGiteaId++, login, `${login}@jdu.uz`, login);
    return id;
  };

  const link = (studentId: string, status = 'in_progress') => {
    const id = randomUUID();
    sqlite.prepare(`INSERT INTO repository_links
      (id, group_assignment_id, student_id, gitea_repository_id, full_name, is_private, status)
      VALUES (?, ?, ?, ?, ?, 1, ?)`)
      .run(id, assignmentId, studentId, nextGiteaId++, `org/repo-${randomUUID().slice(0, 8)}`, status);
    return id;
  };

  const submit = (linkId: string, attempt: number, status: string, submittedAt: number) => {
    sqlite.prepare(`INSERT INTO submissions
      (id, repository_link_id, attempt, commit_sha, protected_ref, status, submitted_at, idempotency_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), linkId, attempt, 'a'.repeat(40), `submission/${attempt}`, status, submittedAt, `key-${attempt}`);
  };

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'local-github-sweeper-'));
    databaseUrl = join(directory, 'database.sqlite');
    await migrateDatabase(databaseUrl);
    sqlite = openSqliteDatabase(databaseUrl);
    nextGiteaId = 1;
    const teacher = user('teacher');
    groupId = randomUUID();
    const course = randomUUID();
    const courseAssignment = randomUUID();
    assignmentId = randomUUID();
    sqlite.prepare('INSERT INTO groups (id, code, name) VALUES (?, ?, ?)').run(groupId, 'CS-1', 'CS 1');
    sqlite.prepare('INSERT INTO courses (id, owner_id, slug, title) VALUES (?, ?, ?, ?)')
      .run(course, teacher, 'intro', 'Introduction');
    sqlite.prepare('INSERT INTO course_assignments (id, course_id, author_id, title) VALUES (?, ?, ?, ?)')
      .run(courseAssignment, course, teacher, 'First assignment');
    // Deadline already in the past relative to NOW.
    sqlite.prepare(`INSERT INTO group_assignments (id, course_assignment_id, group_id, deadline, published_at)
      VALUES (?, ?, ?, ?, ?)`)
      .run(assignmentId, courseAssignment, groupId, 1700000000000, 1699999000000);
    const db = drizzle(sqlite, { schema: { ...tables, ...relations } });
    repo = new DbDeadlineSweeperRepository(db);
  });

  afterEach(() => {
    sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('selects overdue links with no submission and ignores future/timely ones', async () => {
    const s1 = user('s1'); // overdue, no submission
    const s2 = user('s2'); // overdue but already submitted on time
    const l1 = link(s1);
    const l2 = link(s2);
    submit(l2, 1, 'submitted', 1699999900000); // submitted before deadline

    const result = await repo.findOverdueWithoutSubmission(NOW);
    expect(result.map((r) => r.linkId)).toEqual([l1]);
    expect(result[0].studentId).toBe(s1);
    expect(result[0].assignmentId).toBe(assignmentId);
    expect(result[0].groupId).toBe(groupId);
  });

  it('selects overdue links whose latest submission is revision_required', async () => {
    const s1 = user('s1'); // revision_required, never resubmitted
    const s2 = user('s2'); // submitted (waiting review — must NOT auto-fail)
    const s3 = user('s3'); // already passed
    const l1 = link(s1);
    const l2 = link(s2);
    const l3 = link(s3, 'passed');
    submit(l1, 1, 'revision_required', 1699999800000);
    submit(l2, 1, 'submitted', 1699999900000);
    submit(l3, 1, 'passed', 1699999900000);

    const result = await repo.findOverdueRevisionRequired(NOW);
    expect(result.map((r) => r.linkId)).toEqual([l1]);
  });

  it('never selects a link already in a terminal state (idempotent sweep)', async () => {
    const s1 = user('s1');
    const l1 = link(s1, 'failed'); // already failed
    submit(l1, 1, 'revision_required', 1699999800000);

    expect(await repo.findOverdueWithoutSubmission(NOW)).toEqual([]);
    expect(await repo.findOverdueRevisionRequired(NOW)).toEqual([]);
  });

  it('rechecks a stale no-submission candidate and preserves timely work', async () => {
    const l1 = link(user('s1'));
    expect((await repo.findOverdueWithoutSubmission(NOW)).map((r) => r.linkId)).toEqual([l1]);
    submit(l1, 1, 'submitted', 1699999900000);
    sqlite.prepare("UPDATE repository_links SET status = 'submitted' WHERE id = ?").run(l1);
    await repo.markLinkFailed(lid(l1));
    const row = sqlite.prepare('SELECT status FROM repository_links WHERE id = ?').get(l1) as { status: string };
    expect(row.status).toBe('submitted');
    expect(await repo.findOverdueRevisionRequired(NOW)).toEqual([]);
  });

  it('preserves a newer submitted attempt when a revision candidate becomes stale', async () => {
    const l1 = link(user('s1'), 'revision_required');
    submit(l1, 1, 'revision_required', 1699999900000);
    expect((await repo.findOverdueRevisionRequired(NOW)).map((r) => r.linkId)).toEqual([l1]);
    // Attempt number, not timestamp, determines the latest attempt.
    submit(l1, 2, 'submitted', 1699999800000);
    sqlite.prepare("UPDATE repository_links SET status = 'submitted' WHERE id = ?").run(l1);
    expect(await repo.markLinkFailed(lid(l1), NOW)).toBe(false);
    expect(await repo.findOverdueRevisionRequired(NOW)).toEqual([]);
    expect((sqlite.prepare('SELECT status FROM repository_links WHERE id = ?').get(l1) as {status: string}).status).toBe('submitted');
  });

  it('rechecks publication, deadline, and terminal status when marking', async () => {
    const l1 = link(user('s1'));
    expect(await repo.markLinkFailed(lid(l1), 1700000000000)).toBe(false);
    sqlite.prepare('UPDATE group_assignments SET published_at = NULL WHERE id = ?').run(assignmentId);
    expect(await repo.markLinkFailed(lid(l1), NOW)).toBe(false);
    sqlite.prepare('UPDATE group_assignments SET published_at = 1699999000000 WHERE id = ?').run(assignmentId);
    sqlite.prepare("UPDATE repository_links SET status = 'passed' WHERE id = ?").run(l1);
    expect(await repo.markLinkFailed(lid(l1), NOW)).toBe(false);
    expect((sqlite.prepare('SELECT status FROM repository_links WHERE id = ?').get(l1) as {status: string}).status).toBe('passed');
  });

  it('markLinkFailed flips the link status', async () => {
    const s1 = user('s1');
    const l1 = link(s1);
    await repo.markLinkFailed(lid(l1));
    const row = sqlite.prepare('SELECT status FROM repository_links WHERE id = ?').get(l1) as { status: string };
    expect(row.status).toBe('failed');
  });

  it('an unpublished assignment is never selected', async () => {
    // Re-point the assignment at an unpublished group_assignment in a new group
    // (the group_assignments pair is unique per course+group).
    const s1 = user('s1');
    const unpublished = randomUUID();
    const unpublishedGroup = randomUUID();
    const courseAssignment = sqlite.prepare('SELECT course_assignment_id FROM group_assignments WHERE id = ?')
      .get(assignmentId) as { course_assignment_id: string };
    sqlite.prepare('INSERT INTO groups (id, code, name) VALUES (?, ?, ?)').run(unpublishedGroup, 'CS-2', 'CS 2');
    sqlite.prepare(
      'INSERT INTO group_assignments (id, course_assignment_id, group_id, deadline, published_at) VALUES (?, ?, ?, ?, NULL)',
    ).run(unpublished, courseAssignment.course_assignment_id, unpublishedGroup, 1700000000000);
    sqlite.prepare(
      'INSERT INTO repository_links (id, group_assignment_id, student_id, gitea_repository_id, full_name, is_private, status) VALUES (?, ?, ?, ?, ?, 1, ?)',
    ).run(randomUUID(), unpublished, s1, nextGiteaId++, 'org/unpub', 'in_progress');

    expect(await repo.findOverdueWithoutSubmission(NOW)).toEqual([]);
    expect(await repo.findOverdueRevisionRequired(NOW)).toEqual([]);
  });
});
