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
import { AssignmentStateMachineImpl } from '../../src/domain/assignments/state-machine';
import { FakeGitea, makeAuditWriter, InMemoryAuditRepository, principal, uid, aid } from '../domain/fakes';
import type { RepositoryLinkId } from '../../src/shared/contracts';

const lid = (s: string) => s as RepositoryLinkId;

describe('submission audit atomicity', () => {
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

  it('commits one durable success audit and keeps replay/conflict on the ordinary audit port', async () => {
    const student = user('created-student');
    const linkId = lid(link(student));
    const gitea = new FakeGitea();
    gitea.commits.add('abc123');
    const ordinaryAudit = new InMemoryAuditRepository();
    const machine = new AssignmentStateMachineImpl({ repo, gitea,
      audit: makeAuditWriter(ordinaryAudit, () => NOW),
      permissions: { assert: async () => {}, can: async () => true }, now: () => 1699999999000 });
    const input = { actor: principal(uid(student), ['student']), assignmentId: aid(assignmentId),
      commitSha: 'abc123', idempotencyKey: 'created-key' };
    const first = await machine.submit(input);
    expect(first.alreadyExisted).toBe(false);
    expect(await machine.submit(input)).toEqual({ submission: first.submission, alreadyExisted: true });
    await expect(machine.submit({ ...input, commitSha: 'different-sha' })).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
    expect(sqlite.prepare('SELECT actor_id AS actorId, event_type AS eventType, target_type AS targetType, target_id AS targetId, payload FROM audit_events').all()).toEqual([{
      actorId: student, eventType: 'submission.created', targetType: 'submission', targetId: first.submission.id,
      payload: JSON.stringify({ attempt: 1, commitSha: 'abc123', protectedRef: 'submission/1' }),
    }]);
    expect(ordinaryAudit.events.map((e) => e.eventType)).toEqual(['submission.idempotent', 'submission.conflict']);
    await expect(repo.listSubmissions(linkId)).resolves.toHaveLength(1);
  });

  it.each(['snapshot', 'reviewPR'] as const)('never persists submission or success audit when %s fails', async (failure) => {
    const student = user('prerequisite-student');
    const linkId = lid(link(student));
    const gitea = new FakeGitea();
    gitea.commits.add('abc123');
    gitea.failSnapshot = failure === 'snapshot';
    gitea.failPullRequest = failure === 'reviewPR';
    const machine = new AssignmentStateMachineImpl({ repo, gitea,
      audit: makeAuditWriter(new InMemoryAuditRepository(), () => NOW),
      permissions: { assert: async () => {}, can: async () => true }, now: () => 1699999999000 });
    await expect(machine.submit({ actor: principal(uid(student), ['student']), assignmentId: aid(assignmentId),
      commitSha: 'abc123', idempotencyKey: 'prerequisite-key' })).rejects.toMatchObject({ code: 'INTEGRATION_ERROR' });
    await expect(repo.listSubmissions(linkId)).resolves.toEqual([]);
    expect(sqlite.prepare('SELECT status FROM repository_links WHERE id=?').get(linkId)).toEqual({ status: 'in_progress' });
    expect(sqlite.prepare('SELECT count(*) AS n FROM audit_events').get()).toEqual({ n: 0 });
  });

  it('rolls back submission and link when success audit INSERT fails, then converges on retry', async () => {
    const student = user('atomic-student');
    const linkId = lid(link(student));
    const gitea = new FakeGitea();
    gitea.commits.add('abc123');
    // Replay/conflict events use the ordinary audit port; successful persistence
    // must use the repository's transaction-bound audit path.
    const audit = makeAuditWriter(new InMemoryAuditRepository(), () => NOW);
    const machine = new AssignmentStateMachineImpl({ repo, gitea, audit,
      permissions: { assert: async () => {}, can: async () => true },
      now: () => 1699999999000 });
    const input = { actor: principal(uid(student), ['student']), assignmentId: aid(assignmentId),
      commitSha: 'abc123', idempotencyKey: 'atomic-key' };
    sqlite.exec("CREATE TRIGGER reject_submission_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'audit rejected'); END");
    await expect(machine.submit(input)).rejects.toThrow('audit rejected');
    await expect(repo.getSubmissionByIdempotencyKey(linkId, 'atomic-key')).resolves.toBeNull();
    expect(sqlite.prepare('SELECT status FROM repository_links WHERE id=?').get(linkId)).toEqual({ status: 'in_progress' });
    expect(sqlite.prepare('SELECT count(*) AS n FROM audit_events').get()).toEqual({ n: 0 });
    expect(gitea.snapshots).toHaveLength(1);
    expect(gitea.pullRequests).toHaveLength(1);

    sqlite.exec('DROP TRIGGER reject_submission_audit');
    const results = await Promise.all([machine.submit(input), machine.submit(input)]);
    expect(results[0]!.submission.id).toBe(results[1]!.submission.id);
    await expect(repo.listSubmissions(linkId)).resolves.toHaveLength(1);
    expect(sqlite.prepare('SELECT status FROM repository_links WHERE id=?').get(linkId)).toEqual({ status: 'submitted' });
    const events = sqlite.prepare('SELECT target_id AS targetId, event_type AS eventType, payload FROM audit_events').all();
    expect(events).toEqual([{ targetId: results[0]!.submission.id, eventType: 'submission.idempotent',
      payload: JSON.stringify({ attempt: 1, commitSha: 'abc123', protectedRef: 'submission/1' }) }]);
    expect(gitea.snapshots).toHaveLength(1);
    expect(gitea.pullRequests).toHaveLength(1);
  });
});
