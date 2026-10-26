import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../../src/db/schema';
import * as relations from '../../src/db/relations';
import { CourseService } from '../../src/domain/courses/service';
import { IdentityServiceImpl } from '../../src/domain/identity';
import { configureServices } from '../../src/server/auth-context';
import { GET as LIST_COURSES, POST as CREATE_COURSE } from '../../src/app/api/v1/courses/route';
import { PATCH as PATCH_COURSE } from '../../src/app/api/v1/courses/[courseId]/route';
import { POST as PUBLISH_COURSE } from '../../src/app/api/v1/courses/[courseId]/publish/route';
import { POST as ASSIGN_COURSE } from '../../src/app/api/v1/courses/[courseId]/assign/route';
import { GET as LIST_LESSONS, POST as CREATE_LESSON } from '../../src/app/api/v1/courses/[courseId]/lessons/route';
import { POST as REORDER_LESSONS } from '../../src/app/api/v1/courses/[courseId]/lessons/reorder/route';
import { PATCH as PATCH_LESSON } from '../../src/app/api/v1/lessons/[lessonId]/route';
import { POST as PUBLISH_LESSON } from '../../src/app/api/v1/lessons/[lessonId]/publish/route';
import { POST as CREATE_EXTRA } from '../../src/app/api/v1/courses/[courseId]/assignments/route';
import {
  InMemoryAuditRepository,
  InMemoryRoleRepository,
  InMemorySessionRepository,
  makeAuditWriter,
  makeSessionStore,
  uid,
} from '../domain/fakes';

let sqlite: Database.Database;
const tokens: Record<'teacher' | 'otherTeacher' | 'student' | 'studentB' | 'admin', string> = {
  teacher: '', otherTeacher: '', student: '', studentB: '', admin: '',
};
const now = () => 5_000;

function request(url: string, init: { method?: string; body?: unknown; token?: string } = {}) {
  const method = init.method ?? (init.body === undefined ? 'GET' : 'POST');
  return new Request(new URL(url, 'http://localhost'), {
    method,
    headers: {
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(init.token ? { cookie: `session=${init.token}` } : {}),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

const params = <T extends string>(key: T, value: string) => ({ params: Promise.resolve({ [key]: value }) });

async function createCourse(slug: string, title = 'Course') {
  const response = await CREATE_COURSE(request('/api/v1/courses', { body: { title, slug }, token: tokens.teacher }));
  expect(response.status).toBe(201);
  return (await response.json()).course as { id: string; slug: string; title: string; publishedAt: number | null };
}

async function createLesson(courseId: string, title: string) {
  const response = await CREATE_LESSON(
    request(`/api/v1/courses/${courseId}/lessons`, { body: { title }, token: tokens.teacher }),
    params('courseId', courseId),
  );
  expect(response.status).toBe(201);
  return (await response.json()).lesson as { id: string; title: string; position: number };
}

beforeAll(async () => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema: { ...schema, ...relations } });
  migrate(db, { migrationsFolder: 'drizzle' });

  const users = ['teacher', 'otherTeacher', 'student', 'studentB', 'admin'] as const;
  db.insert(schema.users).values(users.map((id, index) => ({
    id, giteaId: index + 1, login: id, email: `${id}@example.com`, displayName: id,
  }))).run();
  db.insert(schema.groups).values([
    { id: 'class', code: 'class', name: 'Class' },
    { id: 'other', code: 'other', name: 'Other' },
    { id: 'unassigned', code: 'unassigned', name: 'Unassigned' },
  ]).run();
  db.insert(schema.groupMembers).values([
    { groupId: 'class', userId: 'teacher' },
    { groupId: 'class', userId: 'student' },
    { groupId: 'other', userId: 'otherTeacher' },
    { groupId: 'other', userId: 'studentB' },
    { groupId: 'unassigned', userId: 'otherTeacher' },
  ]).run();

  const roles = new InMemoryRoleRepository({
    users: users.map((id) => ({ id: uid(id), login: id, email: `${id}@example.com`, displayName: id, giteaId: null })),
    roles: [
      { userId: uid('teacher'), role: 'teacher' },
      { userId: uid('otherTeacher'), role: 'teacher' },
      { userId: uid('student'), role: 'student' },
      { userId: uid('studentB'), role: 'student' },
      { userId: uid('admin'), role: 'admin' },
    ],
  });
  const sessions = makeSessionStore(new InMemorySessionRepository(), now);
  for (const id of users) {
    const session = await sessions.create({ userId: uid(id), login: id, displayName: id, roles: [] }, 60_000);
    tokens[id] = session.token;
  }
  const audit = makeAuditWriter(new InMemoryAuditRepository(), now);
  const identities = new IdentityServiceImpl({ roles, audit });
  configureServices({ sessions, identities, courses: new CourseService({ db, now }), audit });
});
afterAll(() => sqlite.close());

describe('course API authentication and creation', () => {
  it('rejects unauthenticated and student writers, and normalizes slugs', async () => {
    expect((await LIST_COURSES(request('/api/v1/courses'))).status).toBe(401);
    expect((await CREATE_COURSE(request('/api/v1/courses', { body: { title: 'No', slug: 'no' }, token: tokens.student }))).status).toBe(403);

    const created = await CREATE_COURSE(request('/api/v1/courses', { body: { title: 'Python', slug: 'Python 101' }, token: tokens.teacher }));
    expect(created.status).toBe(201);
    expect((await created.json()).course.slug).toBe('python-101');

    const duplicate = await CREATE_COURSE(request('/api/v1/courses', { body: { title: 'Again', slug: 'python-101' }, token: tokens.teacher }));
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ error: { code: 'CONFLICT' } });

    expect((await CREATE_COURSE(request('/api/v1/courses', { body: { title: 'Missing slug' }, token: tokens.teacher }))).status).toBe(400);
  });

  it('maps empty, unknown and forbidden updates to typed statuses', async () => {
    const course = await createCourse('update-target');
    expect((await PATCH_COURSE(request(`/api/v1/courses/${course.id}`, { method: 'PATCH', body: {}, token: tokens.teacher }), params('courseId', course.id))).status).toBe(400);
    expect((await PATCH_COURSE(request('/api/v1/courses/missing', { method: 'PATCH', body: { title: 'X' }, token: tokens.teacher }), params('courseId', 'missing'))).status).toBe(404);
    expect((await PATCH_COURSE(request(`/api/v1/courses/${course.id}`, { method: 'PATCH', body: { title: 'X' }, token: tokens.otherTeacher }), params('courseId', course.id))).status).toBe(403);
    expect((await PATCH_COURSE(request(`/api/v1/courses/${course.id}`, { method: 'PATCH', body: { title: 'X' }, token: tokens.student }), params('courseId', course.id))).status).toBe(403);

    const byAdmin = await PATCH_COURSE(request(`/api/v1/courses/${course.id}`, { method: 'PATCH', body: { title: 'Admin edit' }, token: tokens.admin }), params('courseId', course.id));
    expect(byAdmin.status).toBe(200);
    expect((await byAdmin.json()).course.title).toBe('Admin edit');

    const byOwner = await PATCH_COURSE(request(`/api/v1/courses/${course.id}`, { method: 'PATCH', body: { description: 'Owner edit' }, token: tokens.teacher }), params('courseId', course.id));
    expect((await byOwner.json()).course.description).toBe('Owner edit');
  });

  it('publishes idempotently and only for the author side', async () => {
    const course = await createCourse('publish-target');
    expect((await PUBLISH_COURSE(request(`/api/v1/courses/${course.id}/publish`, { token: tokens.student }), params('courseId', course.id))).status).toBe(403);
    expect((await PUBLISH_COURSE(request(`/api/v1/courses/${course.id}/publish`, { token: tokens.otherTeacher }), params('courseId', course.id))).status).toBe(403);

    const first = await PUBLISH_COURSE(request(`/api/v1/courses/${course.id}/publish`, { token: tokens.teacher }), params('courseId', course.id));
    expect(first.status).toBe(200);
    const publishedAt = (await first.json()).course.publishedAt;
    expect(publishedAt).toBe(now());
    const second = await PUBLISH_COURSE(request(`/api/v1/courses/${course.id}/publish`, { token: tokens.teacher }), params('courseId', course.id));
    expect((await second.json()).course.publishedAt).toBe(publishedAt);
  });
});

describe('course assignment API', () => {
  it('assigns idempotently and enforces ownership and teaching rules', async () => {
    const course = await createCourse('assign-target');
    expect((await ASSIGN_COURSE(request(`/api/v1/courses/${course.id}/assign`, { body: {}, token: tokens.teacher }), params('courseId', course.id))).status).toBe(400);
    expect((await ASSIGN_COURSE(request('/api/v1/courses/missing/assign', { body: { groupId: 'class' }, token: tokens.teacher }), params('courseId', 'missing'))).status).toBe(404);

    await PUBLISH_COURSE(request(`/api/v1/courses/${course.id}/publish`, { token: tokens.teacher }), params('courseId', course.id));
    expect((await ASSIGN_COURSE(request(`/api/v1/courses/${course.id}/assign`, { body: { groupId: 'class' }, token: tokens.otherTeacher }), params('courseId', course.id))).status).toBe(403);
    expect((await ASSIGN_COURSE(request(`/api/v1/courses/${course.id}/assign`, { body: { groupId: 'other' }, token: tokens.otherTeacher }), params('courseId', course.id))).status).toBe(201);

    const first = await ASSIGN_COURSE(request(`/api/v1/courses/${course.id}/assign`, { body: { groupId: 'class' }, token: tokens.teacher }), params('courseId', course.id));
    const second = await ASSIGN_COURSE(request(`/api/v1/courses/${course.id}/assign`, { body: { groupId: 'class' }, token: tokens.teacher }), params('courseId', course.id));
    expect(first.status).toBe(201);
    expect((await second.json()).assignment.id).toBe((await first.json()).assignment.id);
  });
});

describe('lesson API', () => {
  it('creates, edits and reorders lessons with author-only access', async () => {
    const course = await createCourse('lesson-crud');
    expect((await CREATE_LESSON(request(`/api/v1/courses/${course.id}/lessons`, { body: { title: 'No' }, token: tokens.student }), params('courseId', course.id))).status).toBe(403);
    expect((await CREATE_LESSON(request(`/api/v1/courses/${course.id}/lessons`, { body: {}, token: tokens.teacher }), params('courseId', course.id))).status).toBe(400);

    const first = await createLesson(course.id, 'First');
    const second = await createLesson(course.id, 'Second');
    expect((await PATCH_LESSON(request(`/api/v1/lessons/${first.id}`, { method: 'PATCH', body: { title: 'Nope' }, token: tokens.otherTeacher }), params('lessonId', first.id))).status).toBe(403);
    expect((await PATCH_LESSON(request('/api/v1/lessons/missing', { method: 'PATCH', body: { title: 'Nope' }, token: tokens.teacher }), params('lessonId', 'missing'))).status).toBe(404);

    const edited = await PATCH_LESSON(request(`/api/v1/lessons/${first.id}`, { method: 'PATCH', body: { title: 'First edited' }, token: tokens.teacher }), params('lessonId', first.id));
    expect(edited.status).toBe(200);
    expect((await edited.json()).lesson.title).toBe('First edited');

    expect((await REORDER_LESSONS(request(`/api/v1/courses/${course.id}/lessons/reorder`, { body: {}, token: tokens.teacher }), params('courseId', course.id))).status).toBe(400);
    expect((await REORDER_LESSONS(request(`/api/v1/courses/${course.id}/lessons/reorder`, { body: { lessonIds: [first.id] }, token: tokens.teacher }), params('courseId', course.id))).status).toBe(400);
    const reordered = await REORDER_LESSONS(
      request(`/api/v1/courses/${course.id}/lessons/reorder`, { body: { lessonIds: [second.id, first.id] }, token: tokens.teacher }),
      params('courseId', course.id),
    );
    expect((await reordered.json()).lessons.map((lesson: { title: string; position: number }) => [lesson.title, lesson.position]))
      .toEqual([['Second', 0], ['First edited', 1]]);
  });

  it('publishes per group and only exposes published lessons to that group', async () => {
    const course = await createCourse('lesson-publication');
    const lessonA = await createLesson(course.id, 'Lesson A');
    const lessonB = await createLesson(course.id, 'Lesson B');
    await PUBLISH_COURSE(request(`/api/v1/courses/${course.id}/publish`, { token: tokens.teacher }), params('courseId', course.id));

    expect((await PUBLISH_LESSON(request(`/api/v1/lessons/${lessonA.id}/publish`, { body: { groupId: 'class' }, token: tokens.teacher }), params('lessonId', lessonA.id))).status).toBe(409);
    await ASSIGN_COURSE(request(`/api/v1/courses/${course.id}/assign`, { body: { groupId: 'class' }, token: tokens.teacher }), params('courseId', course.id));
    await ASSIGN_COURSE(request(`/api/v1/courses/${course.id}/assign`, { body: { groupId: 'other' }, token: tokens.teacher }), params('courseId', course.id));

    expect((await PUBLISH_LESSON(request(`/api/v1/lessons/${lessonA.id}/publish`, { body: { groupId: 'class' }, token: tokens.otherTeacher }), params('lessonId', lessonA.id))).status).toBe(403);
    expect((await PUBLISH_LESSON(request('/api/v1/lessons/missing/publish', { body: { groupId: 'class' }, token: tokens.teacher }), params('lessonId', 'missing'))).status).toBe(404);

    const first = await PUBLISH_LESSON(request(`/api/v1/lessons/${lessonA.id}/publish`, { body: { groupId: 'class' }, token: tokens.teacher }), params('lessonId', lessonA.id));
    const retry = await PUBLISH_LESSON(request(`/api/v1/lessons/${lessonA.id}/publish`, { body: { groupId: 'class' }, token: tokens.teacher }), params('lessonId', lessonA.id));
    expect(first.status).toBe(201);
    expect((await retry.json()).publication.id).toBe((await first.json()).publication.id);
    expect((await PUBLISH_LESSON(request(`/api/v1/lessons/${lessonB.id}/publish`, { body: { groupId: 'other' }, token: tokens.teacher }), params('lessonId', lessonB.id))).status).toBe(201);

    const classLessons = await LIST_LESSONS(request(`/api/v1/courses/${course.id}/lessons`, { token: tokens.student }), params('courseId', course.id));
    expect((await classLessons.json()).lessons.map((lesson: { title: string }) => lesson.title)).toEqual(['Lesson A']);
    const otherLessons = await LIST_LESSONS(request(`/api/v1/courses/${course.id}/lessons`, { token: tokens.studentB }), params('courseId', course.id));
    expect((await otherLessons.json()).lessons.map((lesson: { title: string }) => lesson.title)).toEqual(['Lesson B']);
    expect((await LIST_LESSONS(request(`/api/v1/courses/${course.id}/lessons`, { token: tokens.admin }), params('courseId', course.id))).status).toBe(403);
  });
});

describe('extra assignment API', () => {
  it('scopes extra assignments to the caller group without mutating the course', async () => {
    const course = await createCourse('extra-assignments');
    await PUBLISH_COURSE(request(`/api/v1/courses/${course.id}/publish`, { token: tokens.teacher }), params('courseId', course.id));
    for (const groupId of ['class', 'other']) {
      expect((await ASSIGN_COURSE(request(`/api/v1/courses/${course.id}/assign`, { body: { groupId }, token: tokens.teacher }), params('courseId', course.id))).status).toBe(201);
    }

    const extra = (body: Record<string, unknown>, token: string) =>
      CREATE_EXTRA(request(`/api/v1/courses/${course.id}/assignments`, { body, token }), params('courseId', course.id));

    expect((await extra({ groupId: 'other', title: 'Owner extra' }, tokens.teacher)).status).toBe(403);
    expect((await extra({ groupId: 'other', title: 'Student extra' }, tokens.student)).status).toBe(403);
    expect((await extra({ groupId: 'class', title: 'Wrong group' }, tokens.otherTeacher)).status).toBe(403);
    expect((await extra({ groupId: 'other', title: 'Published without deadline', published: true }, tokens.otherTeacher)).status).toBe(400);
    expect((await extra({ groupId: 'missing', title: 'Missing group' }, tokens.otherTeacher)).status).toBe(404);
    expect((await extra({ groupId: 'unassigned', title: 'Unassigned group' }, tokens.otherTeacher)).status).toBe(409);

    const created = await extra({ groupId: 'other', title: 'Practice', deadline: 9_000, published: true }, tokens.otherTeacher);
    expect(created.status).toBe(201);
    const body = await created.json();
    expect(body.assignment.groupAssignment).toMatchObject({ groupId: 'other', deadline: 9_000, publishedAt: now() });
    expect(body.assignment.courseAssignment).toMatchObject({ courseId: course.id, authorId: 'otherTeacher' });

    const library = await LIST_COURSES(request('/api/v1/courses', { token: tokens.teacher }));
    expect((await library.json()).courses.map((row: { id: string }) => row.id)).toContain(course.id);
  });
});
