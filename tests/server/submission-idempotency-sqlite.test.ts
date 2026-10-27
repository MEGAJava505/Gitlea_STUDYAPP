import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateDatabase, openSqliteDatabase } from '../../src/db/migrate';
import * as tables from '../../src/db/schema';
import * as relations from '../../src/db/relations';
import { AssignmentStateMachineImpl } from '../../src/domain/assignments/state-machine';
import { AuditLogWriterImpl } from '../../src/domain/audit';
import { PermissionCheckerImpl } from '../../src/domain/permissions';
import { DbAssignmentRepository } from '../../src/server/db-assignment-repository';
import type { AuditRepository } from '../../src/shared/contracts';
import { aid, FakeGitea, lid, principal, uid } from '../domain/fakes';

// Public seams: state machine, production assignment repository and audit writer.
// Only Gitea is fake; migrations, constraints, permissions and audit persistence are real.
describe('submission semantic idempotency with file-backed SQLite', () => {
  let directory: string;
  let databaseUrl: string;
  let connections: Database.Database[];
  let sqlite: Database.Database;
  let now: number;
  let gitea: FakeGitea;
  const teacher = uid('teacher');
  const student = uid('student');
  const assignmentId = aid('assignment');
  const linkId = lid('link');
  const input = (key = 'durable-key', sha = 'abc123') => ({
    actor: principal(student, ['student']), assignmentId, idempotencyKey: key, commitSha: sha,
  });

  function connect() {
    const connection = openSqliteDatabase(databaseUrl);
    connections.push(connection);
    return connection;
  }

  function services(connection = sqlite) {
    const repo = new DbAssignmentRepository(drizzle(connection, { schema: { ...tables, ...relations } }));
    // Production's SQL adapter is local to createProductionServices (not exported).
    // Use its exact append mapping with the production writer, not an in-memory audit fake.
    const auditRepository: AuditRepository = {
      async append(event) {
        connection.prepare('INSERT INTO audit_events (id, actor_id, event_type, target_type, target_id, payload, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(event.id, event.actorId, event.eventType, event.targetType, event.targetId,
            JSON.stringify(event.payload), event.createdAt);
        return event.id;
      },
    };
    const audit = new AuditLogWriterImpl({ audit: auditRepository, now: () => now });
    const permissions = new PermissionCheckerImpl({ resolver: repo, audit });
    const machine = new AssignmentStateMachineImpl({ repo, audit, permissions, gitea, now: () => now });
    return { repo, machine };
  }

  function events() {
    return sqlite.prepare('SELECT event_type AS eventType, target_id AS targetId, payload FROM audit_events ORDER BY rowid')
      .all() as Array<{ eventType: string; targetId: string; payload: string }>;
  }

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'submission-idempotency-'));
    databaseUrl = join(directory, 'database.sqlite');
    connections = [];
    await migrateDatabase(databaseUrl);
    sqlite = connect();
    now = 500;
    gitea = new FakeGitea();
    gitea.commits.add('abc123');
    gitea.commits.add('def456');
    for (const [index, id] of [teacher, student].entries()) {
      sqlite.prepare('INSERT INTO users (id, gitea_id, login, email, display_name) VALUES (?, ?, ?, ?, ?)')
        .run(id, index + 1, id, id + '@jdu.uz', id);
    }
    sqlite.prepare('INSERT INTO groups (id, code, name) VALUES (?, ?, ?)').run('group', 'CS-1', 'CS 1');
    sqlite.prepare('INSERT INTO courses (id, owner_id, slug, title) VALUES (?, ?, ?, ?)')
      .run('course', teacher, 'intro', 'Introduction');
    sqlite.prepare('INSERT INTO course_assignments (id, course_id, author_id, title, allow_resubmission) VALUES (?, ?, ?, ?, 1)')
      .run('course-assignment', 'course', teacher, 'Assignment');
    sqlite.prepare('INSERT INTO group_assignments (id, course_assignment_id, group_id, deadline, published_at) VALUES (?, ?, ?, ?, ?)')
      .run(assignmentId, 'course-assignment', 'group', 1_000, 100);
    sqlite.prepare('INSERT INTO repository_links (id, group_assignment_id, student_id, gitea_repository_id, full_name, is_private, status) VALUES (?, ?, ?, ?, ?, 1, ?)')
      .run(linkId, assignmentId, student, 10, 'org/student', 'in_progress');
  });

  afterEach(() => {
    for (const connection of connections) if (connection.open) connection.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('closes every connection and replays the persisted key after restart and deadline', async () => {
    const first = await services().machine.submit(input());
    sqlite.close();
    now = 1_001;
    sqlite = connect();
    const restarted = services();
    expect(await restarted.machine.submit(input())).toEqual({ submission: first.submission, alreadyExisted: true });
    expect(await restarted.repo.listSubmissions(linkId)).toEqual([first.submission]);
    expect(gitea.snapshots).toHaveLength(1);
    expect(events().map(e => e.eventType)).toEqual(['submission.created', 'submission.idempotent']);
    expect(events().every(e => e.targetId === first.submission.id)).toBe(true);
  });

  it('persists stable same-key changed-SHA 409 conflicts across reopen without remote work', async () => {
    const first = await services().machine.submit(input());
    for (let retry = 0; retry < 2; retry += 1) {
      sqlite.close();
      sqlite = connect();
      now = 1_001;
      await expect(services().machine.submit(input('durable-key', 'def456')))
        .rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
    }
    expect(await services().repo.listSubmissions(linkId)).toEqual([first.submission]);
    expect(gitea.snapshots).toHaveLength(1);
    expect(events().filter(e => e.eventType === 'submission.conflict')).toHaveLength(2);
    expect(JSON.parse(events()[1].payload)).toMatchObject({ commitSha: 'def456', idempotencyKey: 'durable-key' });
  });

  it('rejects a new key after deadline even when the same SHA was accepted earlier', async () => {
    const { machine, repo } = services();
    const first = await machine.submit(input());
    now = 1_001;
    await expect(machine.submit(input('late-key'))).rejects.toMatchObject({ code: 'DEADLINE_EXPIRED' });
    expect(await repo.listSubmissions(linkId)).toEqual([first.submission]);
    expect(gitea.snapshots).toHaveLength(1);
    expect(events().map(e => e.eventType)).toEqual(['submission.created']);
  });

  it('accepts a new key with the same SHA as attempt two after a permitted revision', async () => {
    const { machine, repo } = services();
    const first = await machine.submit(input());
    await machine.requestRevision({ actor: principal(teacher, ['teacher']), assignmentId,
      submissionId: first.submission.id, feedback: 'Please revise' });
    const second = await machine.submit(input('revision-key'));
    expect(second).toMatchObject({ alreadyExisted: false, submission: { attempt: 2, commitSha: 'abc123', idempotencyKey: 'revision-key' } });
    expect(second.submission.id).not.toBe(first.submission.id);
    expect(await repo.listSubmissions(linkId)).toHaveLength(2);
    expect(gitea.snapshots.map(s => s.protectedRef)).toEqual(['submission/1', 'submission/2']);
    expect(events().map(e => e.eventType)).toEqual(['submission.created', 'review.decision', 'submission.created']);
  });

  it('does not treat a fresh same-SHA key as replay while already submitted', async () => {
    const { machine, repo } = services();
    const first = await machine.submit(input());
    await expect(machine.submit(input('unapproved-second-attempt'))).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(await repo.listSubmissions(linkId)).toEqual([first.submission]);
    expect(gitea.snapshots).toHaveLength(1);
  });

  it('does not let a new key bypass forbidden resubmission policy after revision', async () => {
    const { machine, repo } = services();
    const first = await machine.submit(input());
    await machine.requestRevision({ actor: principal(teacher, ['teacher']), assignmentId,
      submissionId: first.submission.id, feedback: 'Please revise' });
    sqlite.prepare('UPDATE course_assignments SET allow_resubmission=0 WHERE id=?').run('course-assignment');
    await expect(machine.submit(input('forbidden-revision'))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await repo.listSubmissions(linkId)).toHaveLength(1);
    expect(gitea.snapshots).toHaveLength(1);
  });

  it.each(['pass', 'fail'] as const)('does not let a fresh key bypass terminal %s status', async decision => {
    const { machine, repo } = services();
    const first = await machine.submit(input());
    await machine[decision]({ actor: principal(teacher, ['teacher']), assignmentId,
      submissionId: first.submission.id, feedback: 'Final decision' });
    await expect(machine.submit(input('terminal-bypass'))).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(await repo.listSubmissions(linkId)).toHaveLength(1);
    expect(gitea.snapshots).toHaveLength(1);
  });

  it('deduplicates simultaneous requests using two independent connections and real audit writes', async () => {
    const other = connect();
    const first = services();
    const second = services(other);
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    gitea.hasCommit = async () => {
      // A separate connection can write while the request awaits the remote port.
      other.prepare('UPDATE repository_links SET status=status WHERE id=?').run(linkId);
      arrivals += 1;
      if (arrivals === 2) release();
      await barrier;
      return true;
    };
    const createSnapshot = gitea.createProtectedSnapshot.bind(gitea);
    gitea.createProtectedSnapshot = async request => {
      if (gitea.snapshots.length) throw new Error('ref already exists');
      return createSnapshot(request);
    };
    const results = await Promise.all([first.machine.submit(input()), second.machine.submit(input())]);
    expect(arrivals).toBe(2);
    expect(results[0].submission.id).toBe(results[1].submission.id);
    expect(results.map(r => r.alreadyExisted).sort()).toEqual([false, true]);
    expect(await first.repo.listSubmissions(linkId)).toHaveLength(1);
    expect(await second.repo.listSubmissions(linkId)).toEqual([results[0].submission]);
    expect(gitea.snapshots).toHaveLength(1);
    expect(events().map(e => e.eventType).sort()).toEqual(['submission.created', 'submission.idempotent']);
  });

  it('recovers an orphan protected snapshot after SQLite rejects the submission transaction', async () => {
    sqlite.exec("CREATE TRIGGER reject_submission_status BEFORE UPDATE OF status ON repository_links BEGIN SELECT RAISE(ABORT, 'injected DB failure'); END");
    const { machine, repo } = services();
    await expect(machine.submit(input())).rejects.toThrow('injected DB failure');
    expect(await repo.listSubmissions(linkId)).toEqual([]);
    expect(events()).toEqual([]);
    expect(gitea.snapshots).toHaveLength(1);
    sqlite.exec('DROP TRIGGER reject_submission_status');
    sqlite.close();
    sqlite = connect();
    const recovered = services();
    const result = await recovered.machine.submit(input());
    expect(result.submission).toMatchObject({ attempt: 1, idempotencyKey: 'durable-key', commitSha: 'abc123' });
    expect(await recovered.repo.listSubmissions(linkId)).toEqual([result.submission]);
    expect(gitea.snapshots).toHaveLength(1);
    expect(gitea.pullRequests).toHaveLength(1);
    expect(events().map(e => e.eventType)).toEqual(['submission.idempotent']);
  });

  it('retries a failed PR call after reopening without duplicating the orphan snapshot', async () => {
    gitea.failPullRequest = true;
    await expect(services().machine.submit(input())).rejects.toMatchObject({ code: 'INTEGRATION_ERROR' });
    expect(gitea.snapshots).toHaveLength(1);
    expect(events().map(e => e.eventType)).toEqual(['integration.error']);
    expect(JSON.parse(events()[0].payload)).toMatchObject({ reason: 'review_pull_request_failed' });
    sqlite.close();
    sqlite = connect();
    gitea.failPullRequest = false;
    const restarted = services();
    const retry = await restarted.machine.submit(input());
    expect(retry.submission.attempt).toBe(1);
    expect(await restarted.repo.listSubmissions(linkId)).toEqual([retry.submission]);
    expect(gitea.snapshots).toHaveLength(1);
    expect(gitea.pullRequests).toHaveLength(1);
    expect(await restarted.machine.submit(input())).toEqual({ submission: retry.submission, alreadyExisted: true });
  });

  it.todo('rolls back submission AND link status when audit_events INSERT fails: insertSubmission commits before awaited audit.append; no shared atomic commit seam yet');
  it.todo('retains a committed submission when PR creation fails: submit calls ensureReviewPullRequest BEFORE insertSubmission, contrary to approved post-commit PR boundary');
});
