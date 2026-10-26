import { beforeAll, describe, expect, it } from 'vitest';
import { configureServices } from '../../src/server/auth-context';
import { POST as POST_MATERIAL, GET as GET_MATERIALS } from '../../src/app/api/v1/lessons/[lessonId]/materials/route';
import { POST as POST_ASSIGNMENT, GET as GET_ASSIGNMENTS } from '../../src/app/api/v1/courses/[courseId]/assignments/route';
import { POST as POST_PUBLISH } from '../../src/app/api/v1/assignments/[assignmentId]/publish/route';
import { IdentityServiceImpl } from '../../src/domain/identity';
import { InMemoryAuditRepository, InMemoryRoleRepository, InMemorySessionRepository, makeAuditWriter, makeSessionStore, uid } from '../domain/fakes';

const now = () => 5_000;
const tokens: Record<'teacher' | 'student', string> = { teacher: '', student: '' };
const material = {
  id: 'material-1', lessonId: 'lesson-1', filename: 'slides.pdf', contentType: 'application/pdf',
  storedPath: '/materials/material-1', size: 42, sha256: 'a'.repeat(64), createdAt: now(),
};
const assignment = {
  id: 'assignment-1', courseId: 'course-1', authorId: 'teacher', title: 'Practice', description: '',
  allowResubmission: false, createdAt: now(),
};
const publication = { id: 'publication-1', assignmentId: 'assignment-1', groupId: 'group-1', deadline: 9_000, publishedAt: now() };

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

beforeAll(async () => {
  const roles = new InMemoryRoleRepository({
    users: [
      { id: uid('teacher'), login: 'teacher', email: 'teacher@example.com', displayName: 'Teacher', giteaId: null },
      { id: uid('student'), login: 'student', email: 'student@example.com', displayName: 'Student', giteaId: null },
    ],
    roles: [{ userId: uid('teacher'), role: 'teacher' }, { userId: uid('student'), role: 'student' }],
  });
  const sessions = makeSessionStore(new InMemorySessionRepository(), now);
  tokens.teacher = (await sessions.create({ userId: uid('teacher'), login: 'teacher', displayName: 'Teacher', roles: ['teacher'] }, 60_000)).token;
  tokens.student = (await sessions.create({ userId: uid('student'), login: 'student', displayName: 'Student', roles: ['student'] }, 60_000)).token;
  const audit = makeAuditWriter(new InMemoryAuditRepository(), now);
  const identities = new IdentityServiceImpl({ roles, audit });

  const materials = {
    attach: async (input: unknown) => { expect(input).toMatchObject({ lessonId: 'lesson-1', filename: 'slides.pdf', actor: { userId: 'teacher' } }); return material; },
    list: async (actor: { userId: string }, lessonId: string) => { expect(actor.userId).toBe('student'); expect(lessonId).toBe('lesson-1'); return [material]; },
  };
  const assignmentService = {
    create: async (input: unknown) => { expect(input).toMatchObject({ courseId: 'course-1', title: 'Practice', actor: { userId: 'teacher' } }); return assignment; },
    listForCourse: async (actor: { userId: string }, courseId: string) => { expect(actor.userId).toBe('teacher'); expect(courseId).toBe('course-1'); return [{ assignment, publication }]; },
    listForStudent: async (actor: { userId: string }, courseId?: string) => { expect(actor.userId).toBe('student'); expect(courseId).toBe('course-1'); return [{ assignment, publication, status: 'open' }]; },
    publish: async (input: unknown) => { expect(input).toMatchObject({ assignmentId: 'assignment-1', groupId: 'group-1', deadline: 9_000, actor: { userId: 'teacher' } }); return publication; },
  };

  configureServices({ sessions, identities, audit, materials, assignmentService } as Parameters<typeof configureServices>[0]);
});

describe('materials and assignment API', () => {
  it('POST /lessons/:lessonId/materials attaches metadata for an authenticated teacher', async () => {
    const res = await POST_MATERIAL(request('/api/v1/lessons/lesson-1/materials', {
      body: { filename: 'slides.pdf', contentType: 'application/pdf', storedPath: '/materials/material-1', size: 42, sha256: 'a'.repeat(64) },
      token: tokens.teacher,
    }), params('lessonId', 'lesson-1'));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ material });
  });

  it('GET /lessons/:lessonId/materials lists materials for an authenticated student', async () => {
    const res = await GET_MATERIALS(request('/api/v1/lessons/lesson-1/materials', { token: tokens.student }), params('lessonId', 'lesson-1'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ materials: [material] });
  });

  it('POST /courses/:courseId/assignments creates a course assignment', async () => {
    const res = await POST_ASSIGNMENT(request('/api/v1/courses/course-1/assignments', {
      body: { title: 'Practice', description: '', allowResubmission: false }, token: tokens.teacher,
    }), params('courseId', 'course-1'));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ assignment });
  });

  it('GET /courses/:courseId/assignments lists course assignments for a teacher', async () => {
    const res = await GET_ASSIGNMENTS(request('/api/v1/courses/course-1/assignments', { token: tokens.teacher }), params('courseId', 'course-1'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ assignments: [{ assignment, publication }] });
  });

  it('GET /courses/:courseId/assignments gives students computed assignment status', async () => {
    const res = await GET_ASSIGNMENTS(request('/api/v1/courses/course-1/assignments', { token: tokens.student }), params('courseId', 'course-1'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ assignments: [{ assignment, publication, status: 'open' }] });
  });

  it('POST /assignments/:assignmentId/publish publishes to a group with a deadline', async () => {
    const res = await POST_PUBLISH(request('/api/v1/assignments/assignment-1/publish', {
      body: { groupId: 'group-1', deadline: 9_000 }, token: tokens.teacher,
    }), params('assignmentId', 'assignment-1'));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ publication });
  });

  it('rejects unauthenticated writes', async () => {
    const res = await POST_ASSIGNMENT(request('/api/v1/courses/course-1/assignments', { body: { title: 'Practice' } }), params('courseId', 'course-1'));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('UNAUTHENTICATED');
  });
});
