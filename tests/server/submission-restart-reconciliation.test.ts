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
describe('submission audit failure and restart reconciliation with file-backed SQLite', () => {
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
    directory = mkdtempSync(join(tmpdir(), 'submission-reconciliation-'));
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

  // These trigger failures exercise the existing public submit port, not an invented
  // transaction interface. SQL assertions are the explicitly approved durability seam.
  function rejectAudit(eventType: string) {
    sqlite.exec(`CREATE TRIGGER reject_submission_audit BEFORE INSERT ON audit_events
      WHEN NEW.event_type = '${eventType}'
      BEGIN SELECT RAISE(ABORT, 'injected audit INSERT failure'); END`);
  }

  function linkStatus(connection = sqlite) {
    return connection.prepare('SELECT status FROM repository_links WHERE id=?').get(linkId);
  }

  it.each([false, true])('rolls back row and link on audit INSERT failure (orphan snapshot=%s), then retries after restart', async orphan => {
    if (orphan) await gitea.createProtectedSnapshot({ repoFullName: 'org/student', attempt: 1, commitSha: 'abc123' });
    rejectAudit(orphan ? 'submission.idempotent' : 'submission.created');
    const observer = connect();
    await expect(services().machine.submit(input())).rejects.toThrow('injected audit INSERT failure');
    // Soft checks let the recovery half run even on the known pre-Lane-A defect.
    expect.soft(await services(observer).repo.listSubmissions(linkId)).toEqual([]);
    expect.soft(linkStatus(observer)).toEqual({ status: 'in_progress' });
    expect(events()).toEqual([]);
    expect(gitea.snapshots).toHaveLength(1);
    expect(gitea.pullRequests).toHaveLength(1);
    sqlite.exec('DROP TRIGGER reject_submission_audit');
    for (const connection of connections) if (connection.open) connection.close();
    sqlite = connect();
    const restarted = services();
    const recovered = await restarted.machine.submit(input());
    expect(recovered).toMatchObject({ alreadyExisted: true, submission: {
      attempt: 1, commitSha: 'abc123', idempotencyKey: 'durable-key', protectedRef: 'submission/1',
    } });
    expect(await restarted.repo.listSubmissions(linkId)).toEqual([recovered.submission]);
    expect(linkStatus()).toEqual({ status: 'submitted' });
    expect(gitea.snapshots).toHaveLength(1);
    expect(gitea.pullRequests).toHaveLength(1);
    expect(events().map(event => event.eventType)).toEqual(['submission.idempotent']);
    expect(events()[0].targetId).toBe(recovered.submission.id);
  });

  it.each([
    { eventType: 'submission.idempotent', sha: 'abc123' },
    { eventType: 'submission.conflict', sha: 'def456' },
  ])('propagates $eventType audit INSERT failure without mutating the durable winner', async ({ eventType, sha }) => {
    const accepted = await services().machine.submit(input());
    rejectAudit(eventType);
    sqlite.close();
    sqlite = connect();
    now = 1_001;
    const restarted = services();
    // Audit failure currently precedes either replay success or semantic 409.
    await expect(restarted.machine.submit(input('durable-key', sha))).rejects.toThrow('injected audit INSERT failure');
    expect(await restarted.repo.listSubmissions(linkId)).toEqual([accepted.submission]);
    expect(linkStatus()).toEqual({ status: 'submitted' });
    expect(events().map(event => event.eventType)).toEqual(['submission.created']);
    expect(gitea.snapshots).toHaveLength(1);
    expect(gitea.pullRequests).toHaveLength(1);
    sqlite.exec('DROP TRIGGER reject_submission_audit');
    if (sha === 'abc123') {
      expect(await restarted.machine.submit(input())).toEqual({ submission: accepted.submission, alreadyExisted: true });
    } else {
      await expect(restarted.machine.submit(input('durable-key', sha))).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
    }
    expect(events().map(event => event.eventType)).toEqual(['submission.created', eventType]);
    expect(events()[1].targetId).toBe(accepted.submission.id);
    expect(await restarted.repo.listSubmissions(linkId)).toEqual([accepted.submission]);
  });

  it('reconciles snapshot and remotely created PR after a lost PR response, observed through a second connection', async () => {
    const observer = connect();
    const ensureReviewPullRequest = gitea.ensureReviewPullRequest.bind(gitea);
    let loseResponse = true;
    gitea.ensureReviewPullRequest = async request => {
      const result = await ensureReviewPullRequest(request);
      if (loseResponse) throw new Error('PR created remotely but response lost');
      return result;
    };
    await expect(services().machine.submit(input())).rejects.toMatchObject({ code: 'INTEGRATION_ERROR' });
    expect(await services(observer).repo.listSubmissions(linkId)).toEqual([]);
    expect(linkStatus(observer)).toEqual({ status: 'in_progress' });
    expect(events().map(event => event.eventType)).toEqual(['integration.error']);
    expect(JSON.parse(events()[0].payload)).toMatchObject({ reason: 'review_pull_request_failed' });
    expect(gitea.snapshots).toHaveLength(1);
    expect(gitea.pullRequests).toHaveLength(1);
    for (const connection of connections) if (connection.open) connection.close();
    sqlite = connect();
    loseResponse = false;
    const restarted = services();
    const recovered = await restarted.machine.submit(input());
    expect(recovered).toMatchObject({ alreadyExisted: true, submission: { attempt: 1, commitSha: 'abc123' } });
    expect(await restarted.repo.listSubmissions(linkId)).toEqual([recovered.submission]);
    expect(linkStatus()).toEqual({ status: 'submitted' });
    expect(gitea.snapshots).toHaveLength(1);
    expect(gitea.pullRequests).toHaveLength(1);
    expect(events().map(event => event.eventType)).toEqual(['integration.error', 'submission.idempotent']);
  });
});
