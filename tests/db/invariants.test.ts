import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateDatabase, openSqliteDatabase } from '../../src/db/migrate';
import { seedDatabase } from '../../src/db/seed';

describe('SQLite data invariants', () => {
  let directory: string;
  let databaseUrl: string;
  let sqlite: Database.Database;
  let student: string;
  let teacher: string;
  let assignment: string;
  let repository: string;
  let nextGiteaId: number;

  const user = (login: string, email = `${login}@university.example`) => {
    const id = randomUUID();
    sqlite.prepare('INSERT INTO users (id, gitea_id, login, email, display_name) VALUES (?, ?, ?, ?, ?)')
      .run(id, nextGiteaId++, login, email, login);
    return id;
  };
  const link = (studentId: string, repositoryId: number) => {
    const id = randomUUID();
    sqlite.prepare(`INSERT INTO repository_links
      (id, group_assignment_id, student_id, gitea_repository_id, full_name, is_private)
      VALUES (?, ?, ?, ?, ?, 1)`).run(id, assignment, studentId, repositoryId, `class/repo-${repositoryId}`);
    return id;
  };
  const submit = (repositoryId: string, attempt: number, ref = `submission/${attempt}`) => {
    const id = randomUUID();
    sqlite.prepare(`INSERT INTO submissions
      (id, repository_link_id, attempt, commit_sha, protected_ref, status, submitted_at, idempotency_key)
      VALUES (?, ?, ?, ?, ?, 'submitted', 1700000000000, ?)`)
      .run(id, repositoryId, attempt, 'a'.repeat(40), ref, `key-${attempt}`);
    return id;
  };

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'local-github-db-'));
    databaseUrl = join(directory, 'database.sqlite');
    await migrateDatabase(databaseUrl);
    sqlite = openSqliteDatabase(databaseUrl);
    nextGiteaId = 1;
    student = user('student');
    teacher = user('teacher');
    const group = randomUUID();
    const course = randomUUID();
    const courseAssignment = randomUUID();
    assignment = randomUUID();
    sqlite.prepare('INSERT INTO groups (id, code, name) VALUES (?, ?, ?)').run(group, 'CS-1', 'CS 1');
    sqlite.prepare('INSERT INTO courses (id, owner_id, slug, title) VALUES (?, ?, ?, ?)')
      .run(course, teacher, 'intro', 'Introduction');
    sqlite.prepare('INSERT INTO course_assignments (id, course_id, author_id, title) VALUES (?, ?, ?, ?)')
      .run(courseAssignment, course, teacher, 'First assignment');
    sqlite.prepare('INSERT INTO group_assignments (id, course_assignment_id, group_id) VALUES (?, ?, ?)')
      .run(assignment, courseAssignment, group);
    repository = link(student, 1);
  });

  afterEach(() => {
    sqlite?.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it('rejects a duplicate Student ID', () => {
    const insert = sqlite.prepare(`INSERT INTO student_profiles
      (id, user_id, student_id, expected_email) VALUES (?, ?, ?, ?)`);
    insert.run(randomUUID(), student, 'S-001', 'student@university.example');
    expect(() => insert.run(randomUUID(), user('other'), 'S-001', 'other@university.example'))
      .toThrow(/UNIQUE constraint failed: student_profiles.student_id/);
  });

  it('rejects duplicate normalized user and expected university emails', () => {
    expect(() => user('duplicate', '  STUDENT@UNIVERSITY.EXAMPLE ')).toThrow(/UNIQUE constraint failed/);
    const other = user('other');
    const insert = sqlite.prepare(`INSERT INTO student_profiles
      (id, user_id, student_id, expected_email) VALUES (?, ?, ?, ?)`);
    insert.run(randomUUID(), student, 'S-001', '  PROFILE@UNIVERSITY.EXAMPLE ');
    expect(() => insert.run(randomUUID(), other, 'S-002', 'profile@university.example'))
      .toThrow(/UNIQUE constraint failed/);
  });

  it('prevents binding a university email to a different account across identity tables', () => {
    const other = user('other');
    expect(() => sqlite.prepare(`INSERT INTO student_profiles
      (id, user_id, student_id, expected_email) VALUES (?, ?, ?, ?)`)
      .run(randomUUID(), other, 'S-002', ' STUDENT@UNIVERSITY.EXAMPLE '))
      .toThrow(/email belongs to another account/);
    sqlite.prepare(`INSERT INTO student_profiles (id, user_id, student_id, expected_email)
      VALUES (?, ?, 'S-003', 'reserved@university.example')`).run(randomUUID(), student);
    expect(() => user('reserved')).toThrow(/email belongs to another account/);
    expect(() => sqlite.prepare('UPDATE users SET email = ? WHERE id = ?')
      .run(' RESERVED@UNIVERSITY.EXAMPLE ', other)).toThrow(/email belongs to another account/);
    const otherProfile = randomUUID();
    sqlite.prepare(`INSERT INTO student_profiles
      (id, user_id, student_id, expected_email) VALUES (?, ?, 'S-004', ?)`)
      .run(otherProfile, other, 'other@university.example');
    expect(() => sqlite.prepare('UPDATE student_profiles SET expected_email = ? WHERE id = ?')
      .run(' TEACHER@UNIVERSITY.EXAMPLE ', otherProfile)).toThrow(/email belongs to another account/);
  });

  it('numbers attempts independently per repository/student and forbids duplicate refs', () => {
    submit(repository, 1);
    submit(repository, 2);
    expect(() => submit(repository, 1, 'submission/duplicate')).toThrow(/UNIQUE constraint failed/);
    expect(() => submit(repository, 3, 'submission/2')).toThrow(/UNIQUE constraint failed/);
    expect(() => submit(repository, 0)).toThrow(/CHECK constraint failed/);
    const otherRepository = link(user('other'), 2);
    expect(() => submit(otherRepository, 1)).not.toThrow();
    expect(sqlite.prepare('SELECT attempt FROM submissions WHERE repository_link_id = ? ORDER BY attempt')
      .all(repository)).toEqual([{ attempt: 1 }, { attempt: 2 }]);
  });

  it('preserves the commit SHA when update, deletion, and REPLACE are attempted', () => {
    const submission = submit(repository, 1);
    expect(() => sqlite.prepare('UPDATE submissions SET commit_sha = ? WHERE id = ?')
      .run('b'.repeat(40), submission)).toThrow(/immutable/);
    expect(() => sqlite.prepare('DELETE FROM submissions WHERE id = ?').run(submission))
      .toThrow(/submissions cannot be deleted/);
    expect(() => sqlite.prepare(`INSERT OR REPLACE INTO submissions
      (id, repository_link_id, attempt, commit_sha, protected_ref, submitted_at, idempotency_key)
      VALUES (?, ?, 1, ?, 'submission/1', 1700000000000, 'key-1')`)
      .run(submission, repository, 'b'.repeat(40))).toThrow(/cannot be deleted/);
    expect(sqlite.prepare('SELECT commit_sha FROM submissions WHERE id = ?').get(submission))
      .toEqual({ commit_sha: 'a'.repeat(40) });
    expect(() => sqlite.prepare("UPDATE submissions SET status = 'passed' WHERE id = ?").run(submission))
      .not.toThrow();
  });

  it('allows only one active review per submission, preserving superseded reviews', () => {
    const submission = submit(repository, 1);
    const first = randomUUID();
    const insert = sqlite.prepare(`INSERT INTO reviews
      (id, submission_id, reviewer_id, decision, feedback, is_active) VALUES (?, ?, ?, 'passed', 'OK', ?)`);
    insert.run(first, submission, teacher, 1);
    expect(() => insert.run(randomUUID(), submission, teacher, 1)).toThrow(/UNIQUE constraint failed/);
    sqlite.prepare('UPDATE reviews SET is_active = 0 WHERE id = ?').run(first);
    expect(() => insert.run(randomUUID(), submission, teacher, 1)).not.toThrow();
    expect(() => sqlite.prepare('UPDATE reviews SET is_active = 1 WHERE id = ?').run(first))
      .toThrow(/UNIQUE constraint failed/);
    expect(sqlite.prepare('SELECT count(*) AS count FROM reviews WHERE submission_id = ?').get(submission))
      .toEqual({ count: 2 });
  });

  it('deduplicates notifications by recipient and key', () => {
    const insert = sqlite.prepare(`INSERT INTO notifications
      (id, recipient_id, event_type, deduplication_key, payload) VALUES (?, ?, 'reviewed', 'review:1', '{}')`);
    insert.run(randomUUID(), student);
    expect(() => insert.run(randomUUID(), student)).toThrow(/UNIQUE constraint failed/);
    expect(() => insert.run(randomUUID(), teacher)).not.toThrow();
  });

  it('enforces role/status literals, publication deadlines, and restrictive foreign keys', () => {
    expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(() => sqlite.prepare('INSERT INTO user_roles (id, user_id, role) VALUES (?, ?, ?)')
      .run(randomUUID(), student, 'superadmin')).toThrow(/CHECK constraint failed/);
    expect(() => sqlite.prepare('INSERT INTO user_roles (id, user_id, role) VALUES (?, ?, ?)')
      .run(randomUUID(), randomUUID(), 'student')).toThrow(/FOREIGN KEY constraint failed/);
    expect(() => sqlite.prepare('DELETE FROM users WHERE id = ?').run(student))
      .toThrow(/FOREIGN KEY constraint failed/);
    const submission = submit(repository, 1);
    expect(() => sqlite.prepare("UPDATE submissions SET status = 'unknown' WHERE id = ?").run(submission))
      .toThrow(/CHECK constraint failed/);
    expect(() => sqlite.prepare('UPDATE group_assignments SET published_at = 1700000000000 WHERE id = ?')
      .run(assignment)).toThrow(/CHECK constraint failed/);
  });

  it('rejects overlapping compensation intervals on insert and update', () => {
    const incident = randomUUID();
    sqlite.prepare("INSERT INTO outage_incidents (id, service, started_at) VALUES (?, 'gitea', 10)")
      .run(incident);
    const insert = sqlite.prepare(`INSERT INTO compensation_windows
      (id, outage_incident_id, starts_at, ends_at, reason) VALUES (?, ?, ?, ?, 'outage')`);
    insert.run(randomUUID(), incident, 10, 20);
    expect(() => insert.run(randomUUID(), incident, 15, 25)).toThrow(/overlapping compensation window/);
    const adjacent = randomUUID();
    expect(() => insert.run(adjacent, incident, 20, 30)).not.toThrow();
    expect(() => sqlite.prepare('UPDATE compensation_windows SET starts_at = 19 WHERE id = ?').run(adjacent))
      .toThrow(/overlapping compensation window/);
  });

  it('keeps the audit log append-only, including INSERT OR REPLACE', () => {
    const id = randomUUID();
    const insert = sqlite.prepare(`INSERT OR REPLACE INTO audit_events
      (id, actor_id, event_type, target_type, target_id, payload, occurred_at)
      VALUES (?, ?, 'login', 'user', ?, '{}', 1700000000000)`);
    insert.run(id, student, student);
    expect(() => sqlite.prepare("UPDATE audit_events SET event_type = 'changed' WHERE id = ?").run(id))
      .toThrow(/append-only/);
    expect(() => sqlite.prepare('DELETE FROM audit_events WHERE id = ?').run(id)).toThrow(/append-only/);
    expect(() => insert.run(id, student, student)).toThrow(/append-only/);
  });

  it('migrates and seeds repeatedly without changing any rows or violating foreign keys', async () => {
    await migrateDatabase(databaseUrl);
    await seedDatabase(databaseUrl);
    const tableNames = sqlite.prepare(`SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '__drizzle_migrations' ORDER BY name`).all() as { name: string }[];
    const snapshot = () => Object.fromEntries(tableNames.map(({ name }) => [name,
      sqlite.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
    const first = snapshot();
    await migrateDatabase(databaseUrl);
    await seedDatabase(databaseUrl);
    expect(snapshot()).toEqual(first);
    expect(sqlite.pragma('foreign_key_check')).toEqual([]);
    expect(tableNames).toHaveLength(24);
  });
});
