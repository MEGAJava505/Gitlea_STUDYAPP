import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateDatabase, openSqliteDatabase } from '../../src/db/migrate';
import { DbProvisioningRepository } from '../../src/server/db-provisioning-repository';
import * as tables from '../../src/db/schema';
import * as relations from '../../src/db/relations';
import type { AssignmentId, UserId } from '../../src/shared/contracts';

const aid = (s: string) => s as AssignmentId;
const uid = (s: string) => s as UserId;

describe('DbProvisioningRepository', () => {
  let directory: string;
  let sqlite: Database.Database;
  let nextGiteaId: number;
  let teacher: string;
  let course: string;
  let groupId: string;
  let repo: DbProvisioningRepository;

  const user = (login: string) => {
    const id = randomUUID();
    sqlite.prepare('INSERT INTO users (id, gitea_id, login, email, display_name) VALUES (?, ?, ?, ?, ?)')
      .run(id, nextGiteaId++, login, `${login}@jdu.uz`, login);
    return id;
  };

  const group = (code: string) => {
    const id = randomUUID();
    sqlite.prepare('INSERT INTO groups (id, code, name) VALUES (?, ?, ?)').run(id, code, code);
    return id;
  };

  const member = (gid: string, userId: string, state: 'active' | 'inactive') => {
    sqlite.prepare('INSERT INTO group_members (id, group_id, user_id, state, left_at) VALUES (?, ?, ?, ?, ?)')
      .run(randomUUID(), gid, userId, state, state === 'inactive' ? Date.now() + 1000 : null);
  };

  const assignment = (opts: { template?: [string | null, string | null]; publishedAt?: number | null } = {}) => {
    const courseAssignment = randomUUID();
    const [owner, repoName] = opts.template ?? [null, null];
    sqlite.prepare(`INSERT INTO course_assignments (id, course_id, author_id, title, template_owner, template_repo)
      VALUES (?, ?, ?, ?, ?, ?)`).run(courseAssignment, course, teacher, 'Assignment', owner, repoName);
    const id = randomUUID();
    const publishedAt = opts.publishedAt === undefined ? 1700000000000 : opts.publishedAt;
    sqlite.prepare(`INSERT INTO group_assignments (id, course_assignment_id, group_id, deadline, published_at)
      VALUES (?, ?, ?, ?, ?)`).run(id, courseAssignment, groupId, 1800000000000, publishedAt);
    return aid(id);
  };

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'local-github-provisioning-'));
    const databaseUrl = join(directory, 'database.sqlite');
    await migrateDatabase(databaseUrl);
    sqlite = openSqliteDatabase(databaseUrl);
    nextGiteaId = 1;
    teacher = user('teacher');
    course = randomUUID();
    sqlite.prepare('INSERT INTO courses (id, owner_id, slug, title) VALUES (?, ?, ?, ?)')
      .run(course, teacher, 'intro', 'Introduction');
    groupId = group('CS-1');
    repo = new DbProvisioningRepository(drizzle(sqlite, { schema: { ...tables, ...relations } }));
  });

  afterEach(() => {
    sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('returns null for an unknown assignment', async () => {
    expect(await repo.getPublishedAssignment(aid(randomUUID()))).toBeNull();
  });

  it('returns the template only when both owner and repo are set', async () => {
    const withTemplate = assignment({ template: ['templates', 'hello-world'] });
    const withoutTemplate = assignment();
    const partial = assignment({ template: ['templates', null] });

    expect(await repo.getPublishedAssignment(withTemplate)).toEqual({
      id: withTemplate,
      groupId,
      publishedAt: 1700000000000,
      template: { owner: 'templates', repo: 'hello-world' },
    });
    expect((await repo.getPublishedAssignment(withoutTemplate))?.template).toBeNull();
    expect((await repo.getPublishedAssignment(partial))?.template).toBeNull();
  });

  it('reports publishedAt null for an unpublished assignment', async () => {
    const id = assignment({ template: ['templates', 'hello-world'], publishedAt: null });
    expect((await repo.getPublishedAssignment(id))?.publishedAt).toBeNull();
  });

  it('isAssignedToStudent requires an active membership in the assignment group', async () => {
    const id = assignment();
    const active = user('active');
    const inactive = user('inactive');
    const outsider = user('outsider');
    const nonMember = user('nonmember');
    member(groupId, active, 'active');
    member(groupId, inactive, 'inactive');
    member(group('CS-2'), outsider, 'active');

    expect(await repo.isAssignedToStudent(id, uid(active))).toBe(true);
    expect(await repo.isAssignedToStudent(id, uid(inactive))).toBe(false);
    expect(await repo.isAssignedToStudent(id, uid(outsider))).toBe(false);
    expect(await repo.isAssignedToStudent(id, uid(nonMember))).toBe(false);
    expect(await repo.isAssignedToStudent(aid(randomUUID()), uid(active))).toBe(false);
  });

  it('inserts a repository link and reads it back', async () => {
    const id = assignment({ template: ['templates', 'hello-world'] });
    const student = uid(user('student'));
    expect(await repo.getRepositoryLink(id, student)).toBeNull();

    const inserted = await repo.insertRepositoryLink({
      groupAssignmentId: id,
      studentId: student,
      giteaRepoFullName: 'org/hello-world-student',
      giteaRepoId: 4242,
      isPrivate: true,
    });
    expect(inserted).toEqual({
      id: expect.any(String),
      groupAssignmentId: id,
      studentId: student,
      giteaRepoFullName: 'org/hello-world-student',
      giteaRepoId: 4242,
      isPrivate: true,
    });
    expect(await repo.getRepositoryLink(id, student)).toEqual(inserted);
    const row = sqlite.prepare('SELECT full_name, gitea_repository_id, status FROM repository_links WHERE id = ?')
      .get(inserted.id) as { full_name: string; gitea_repository_id: number; status: string };
    expect(row).toEqual({ full_name: 'org/hello-world-student', gitea_repository_id: 4242, status: 'in_progress' });
  });
});
