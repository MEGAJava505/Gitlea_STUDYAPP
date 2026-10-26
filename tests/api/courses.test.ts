import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import * as schema from '../../src/db/schema';
import * as relations from '../../src/db/relations';
import { CourseService } from '../../src/domain/courses/service';
import { IdentityServiceImpl } from '../../src/domain/identity';
import { configureServices } from '../../src/server/auth-context';
import { GET, POST } from '../../src/app/api/v1/courses/route';
import { POST as POST_ASSIGN } from '../../src/app/api/v1/courses/[courseId]/assign/route';
import { InMemoryAuditRepository, InMemoryRoleRepository, InMemorySessionRepository, makeAuditWriter, makeSessionStore, uid } from '../domain/fakes';

let sqlite: Database.Database;
let teacherToken: string;
let studentToken: string;
const now = () => 5_000;
const request = (url: string, body?: unknown, token?: string) => new Request(new URL(url, 'http://localhost'), {
  method: body === undefined ? 'GET' : 'POST',
  headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { cookie: `session=${token}` } : {}) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const params = (courseId: string) => ({ params: Promise.resolve({ courseId }) });

beforeAll(async () => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema: { ...schema, ...relations } });
  migrate(db, { migrationsFolder: 'drizzle' });
  for (const [index, id] of ['teacher', 'student'].entries()) {
    db.insert(schema.users).values({ id, giteaId: index + 1, login: id, email: `${id}@example.com`, displayName: id }).run();
  }
  db.insert(schema.userRoles).values([{ userId: 'teacher', role: 'teacher' }, { userId: 'student', role: 'student' }]).run();
  db.insert(schema.groups).values({ id: 'class', code: 'class', name: 'Class' }).run();
  db.insert(schema.groupMembers).values({ groupId: 'class', userId: 'student' }).run();
  const roles = new InMemoryRoleRepository({
    users: [
      { id: uid('teacher'), login: 'teacher', email: 'teacher@example.com', displayName: 'teacher', giteaId: 1 },
      { id: uid('student'), login: 'student', email: 'student@example.com', displayName: 'student', giteaId: 2 },
    ],
    roles: [{ userId: uid('teacher'), role: 'teacher' }, { userId: uid('student'), role: 'student' }],
  });
  const audit = makeAuditWriter(new InMemoryAuditRepository(), now);
  const identities = new IdentityServiceImpl({ roles, audit });
  const sessions = makeSessionStore(new InMemorySessionRepository(), now);
  const teacherSession = await sessions.create({ userId: uid('teacher'), login: 'teacher', displayName: 'teacher', roles: ['teacher'] }, 60_000);
  const studentSession = await sessions.create({ userId: uid('student'), login: 'student', displayName: 'student', roles: ['student'] }, 60_000);
  teacherToken = teacherSession.token;
  studentToken = studentSession.token;
  configureServices({ sessions, identities, courses: new CourseService({ db, now }), audit });
});
afterAll(() => sqlite.close());

describe('course API', () => {
  it('requires authentication and creates a course for a teacher', async () => {
    expect((await GET(request('/api/v1/courses'))).status).toBe(401);
    const denied = await POST(request('/api/v1/courses', { title: 'No', slug: 'no' }, studentToken));
    expect(denied.status).toBe(403);
    const created = await POST(request('/api/v1/courses', { title: 'Python', slug: 'Python 101' }, teacherToken));
    expect(created.status).toBe(201);
    expect((await created.json()).course.slug).toBe('python-101');
  });

  it('maps unknown course assignment to a typed 404', async () => {
    const response = await POST_ASSIGN(request('/api/v1/courses/missing/assign', { groupId: 'class' }, teacherToken), params('missing'));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });
});
