import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateDatabase, openSqliteDatabase } from '../../src/db/migrate';
import { DbAssignmentRepository } from '../../src/server/db-assignment-repository';
import * as tables from '../../src/db/schema';
import * as relations from '../../src/db/relations';
import type { RepositoryLinkId } from '../../src/shared/contracts';

const lid = (s: string) => s as RepositoryLinkId;

describe('DbAssignmentRepository', () => {
  let directory: string;
  let databaseUrl: string;
  let sqlite: Database.Database;
  let groupId: string;
  let assignmentId: string;
  let nextGiteaId: number;
  let repo: DbAssignmentRepository;
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

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'local-github-assignment-'));
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
    repo = new DbAssignmentRepository(db);
  });

  afterEach(() => {
    sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it.each(['revision_required', 'passed', 'failed'] as const)('synchronizes the latest review status %s to the repository link', async (status) => {
    const linkId = lid(link(user('s1')));
    const submission = await repo.insertSubmission({
      repositoryLinkId: linkId, attempt: 1, commitSha: 'abc123',
      protectedRef: 'submission/1', status: 'submitted', submittedAt: NOW - 200000,
    });
    await repo.updateSubmissionStatus(submission.id, status);
    await expect(repo.getSubmission(submission.id)).resolves.toMatchObject({ status });
    const row = sqlite.prepare('SELECT status FROM repository_links WHERE id = ?').get(linkId) as { status: string };
    expect(row.status).toBe(status);
  });
  it('does not let a historical review replace the latest attempt status', async () => {
    const linkId = lid(link(user('s1')));
    const first = await repo.insertSubmission({ repositoryLinkId: linkId, attempt: 1,
      commitSha: 'abc123', protectedRef: 'submission/1', status: 'revision_required', submittedAt: NOW - 200000 });
    await repo.insertSubmission({ repositoryLinkId: linkId, attempt: 2,
      commitSha: 'def456', protectedRef: 'submission/2', status: 'submitted', submittedAt: NOW - 100000 });
    await repo.updateSubmissionStatus(first.id, 'failed');
    await expect(repo.getSubmission(first.id)).resolves.toMatchObject({ status: 'failed' });
    expect((sqlite.prepare('SELECT status FROM repository_links WHERE id = ?').get(linkId) as {status: string}).status).toBe('submitted');
  });

  it('rolls back review status if link status synchronization fails', async () => {
    const linkId = lid(link(user('s1')));
    const submission = await repo.insertSubmission({ repositoryLinkId: linkId, attempt: 1,
      commitSha: 'abc123', protectedRef: 'submission/1', status: 'submitted', submittedAt: NOW - 200000 });
    sqlite.exec("CREATE TRIGGER reject_link_status BEFORE UPDATE OF status ON repository_links BEGIN SELECT RAISE(ABORT, 'status rejected'); END");
    await expect(repo.updateSubmissionStatus(submission.id, 'passed')).rejects.toThrow('status rejected');
    await expect(repo.getSubmission(submission.id)).resolves.toMatchObject({ status: 'submitted' });
  });

  it('rolls back submission creation if link status synchronization fails', async () => {
    const linkId = lid(link(user('s1')));
    sqlite.exec("CREATE TRIGGER reject_link_status BEFORE UPDATE OF status ON repository_links BEGIN SELECT RAISE(ABORT, 'status rejected'); END");
    await expect(repo.insertSubmission({ repositoryLinkId: linkId, attempt: 1,
      commitSha: 'abc123', protectedRef: 'submission/1', status: 'submitted', submittedAt: NOW - 200000 })).rejects.toThrow('status rejected');
    await expect(repo.listSubmissions(linkId)).resolves.toEqual([]);
  });
});
