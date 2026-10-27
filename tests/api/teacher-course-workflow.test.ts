import React from 'react';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as schema from '../../src/db/schema';
import * as relations from '../../src/db/relations';
import { CourseService } from '../../src/domain/courses/service';
import { IdentityServiceImpl } from '../../src/domain/identity';
import { configureServices } from '../../src/server/auth-context';
import { TeacherCoursesQuery } from '../../src/server/teacher-courses';
import { POST as createCourse } from '../../src/app/api/v1/courses/route';
import { POST as createLesson } from '../../src/app/api/v1/courses/[courseId]/lessons/route';
import { POST as assignCourse } from '../../src/app/api/v1/courses/[courseId]/assign/route';
import { POST as publishCourse } from '../../src/app/api/v1/courses/[courseId]/publish/route';
import { POST as publishLesson } from '../../src/app/api/v1/lessons/[lessonId]/publish/route';
import { GET as listMaterials, POST as attachMaterial } from '../../src/app/api/v1/lessons/[lessonId]/materials/route';
import { InMemoryAuditRepository, InMemoryRoleRepository, InMemorySessionRepository, makeAuditWriter, makeSessionStore, uid } from '../domain/fakes';
import type { SessionPrincipal } from '../../src/shared/contracts';

const state = vi.hoisted(() => ({ cookie: '', db: null as unknown }));
vi.mock('next/headers', () => ({ headers: async () => new Headers({ cookie: state.cookie }) }));
vi.mock('next/navigation', () => ({
  notFound: () => { throw new Error('NOT_FOUND'); }, unauthorized: () => { throw new Error('UNAUTHORIZED'); },
  forbidden: () => { throw new Error('FORBIDDEN'); }, useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock('../../src/db/client', () => ({ get db() { return state.db; } }));
import LibraryPage from '../../src/app/(panels)/teacher/courses/page';
import NewPage from '../../src/app/(panels)/teacher/courses/new/page';
import LessonsPage from '../../src/app/(panels)/teacher/courses/[courseId]/lessons/page';
import MaterialsPage from '../../src/app/(panels)/teacher/courses/[courseId]/lessons/[lessonId]/materials/page';
import StudentPage from '../../src/app/(panels)/student/courses/[courseId]/page';
import StudentLibrary from '../../src/app/(panels)/student/courses/page';

const directory = mkdtempSync(join(tmpdir(), 'teacher-workflow-'));
const sqlite = new Database(join(directory, 'workflow.sqlite'));
sqlite.pragma('foreign_keys = ON');
const db = drizzle(sqlite, { schema: { ...schema, ...relations } });
const now = () => 5000;
const tokens: Record<string, string> = {};
const actors = Object.fromEntries(['teacher', 'other', 'student', 'outsider'].map(id => [id, {
  userId: uid(id), login: id, displayName: id, roles: [id === 'teacher' || id === 'other' ? 'teacher' : 'student'],
}])) as Record<string, SessionPrincipal>;
const request = (actor: string, body?: unknown) => new Request('http://localhost/api', {
  method: body === undefined ? 'GET' : 'POST', headers: { cookie: 'session=' + tokens[actor], 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const courseParams = (courseId: string) => ({ params: Promise.resolve({ courseId }) });
const lessonParams = (lessonId: string) => ({ params: Promise.resolve({ lessonId }) });
const as = (actor: string) => { state.cookie = 'session=' + tokens[actor]; };
beforeAll(async () => {
  vi.stubGlobal('React', React);
  migrate(db, { migrationsFolder: 'drizzle' }); state.db = db;
  const ids = Object.keys(actors);
  db.insert(schema.users).values(ids.map((id, index) => ({ id, login: id, giteaId: index + 1, email: id + '@example.test', displayName: id }))).run();
  db.insert(schema.groups).values({ id: 'class', code: 'class', name: 'Class One' }).run();
  db.insert(schema.groupMembers).values([{ groupId: 'class', userId: 'teacher' }, { groupId: 'class', userId: 'student' }]).run();
  const roles = new InMemoryRoleRepository({
    users: ids.map(id => ({ id: uid(id), login: id, email: id + '@example.test', displayName: id, giteaId: null })),
    roles: ids.map(id => ({ userId: uid(id), role: actors[id]!.roles[0]! })),
  });
  const audit = makeAuditWriter(new InMemoryAuditRepository(), now);
  const sessions = makeSessionStore(new InMemorySessionRepository(), now);
  for (const id of ids) tokens[id] = (await sessions.create(actors[id]!, 60_000)).token;
  configureServices({ sessions, identities: new IdentityServiceImpl({ roles, audit }), audit, courses: new CourseService({ db, now }) });
});
afterAll(() => { sqlite.close(); rmSync(directory, { recursive: true, force: true }); vi.unstubAllGlobals(); });

describe('teacher course workflow with real migrated SQLite and authenticated server pages', () => {
  it('creates, appends lessons, assigns, publishes and shows only published lessons to members', async () => {
    as('teacher');
    expect(renderToStaticMarkup(await NewPage())).toContain('name="slug"');
    expect(renderToStaticMarkup(await LibraryPage())).toContain('Create course');
    const created = await createCourse(request('teacher', { title: 'Python course', slug: 'Python 101', description: 'Learn together' }));
    expect(created.status).toBe(201);
    const { course } = await created.json();
    expect(course).toMatchObject({ ownerId: 'teacher', slug: 'python-101' });
    const lessonResponse = await createLesson(request('teacher', { title: 'Visible lesson' }), courseParams(course.id));
    expect(lessonResponse.status).toBe(201);
    const { lesson } = await lessonResponse.json();
    const hiddenResponse = await createLesson(request('teacher', { title: 'Hidden draft lesson' }), courseParams(course.id));
    expect(hiddenResponse.status).toBe(201);
    expect((await hiddenResponse.json()).lesson.position).toBe(1);
    expect((await assignCourse(request('teacher', { groupId: 'class' }), courseParams(course.id))).status).toBe(201);
    const manage = renderToStaticMarkup(await LessonsPage(courseParams(course.id)));
    expect(manage).toContain('Class One'); expect(manage).toContain('Hidden draft lesson');
    expect(manage).toContain('Publish lesson to group'); expect(manage).toContain('Browse materials');
    const projection = new TeacherCoursesQuery(db).get(actors.teacher!, course.id);
    expect(projection.lessons.map(row => row.title)).toEqual(['Visible lesson', 'Hidden draft lesson']);
    as('student');
    const before = renderToStaticMarkup(await StudentPage(courseParams(course.id)));
    expect(before).toContain('No published lessons yet.'); expect(before).not.toContain('Hidden draft lesson');
    expect((await publishCourse(request('teacher', {}), courseParams(course.id))).status).toBe(200);
    expect((await publishLesson(request('teacher', { groupId: 'class' }), lessonParams(lesson.id))).status).toBe(201);
    const after = renderToStaticMarkup(await StudentPage(courseParams(course.id)));
    expect(after).toContain('Visible lesson'); expect(after).not.toContain('Hidden draft lesson');
    expect(renderToStaticMarkup(await StudentLibrary())).toContain('Python course');
    as('teacher');
    const materialHtml = renderToStaticMarkup(await MaterialsPage({ params: Promise.resolve({ courseId: course.id, lessonId: lesson.id }) }));
    expect(materialHtml).toContain('type="file"');
    expect(materialHtml).toContain('Upload material');
    expect(materialHtml).not.toContain('File upload and download are not available yet.');
    // Workflow fixture does not configure MATERIALS_STORAGE_ROOT / materials service → API stays unavailable.
    expect((await listMaterials(request('student'), lessonParams(lesson.id))).status).toBe(503);
    expect((await attachMaterial(request('teacher', { filename: 'slides.pdf', contentType: 'application/pdf', storedPath: '/fake', size: 5, sha256: 'a'.repeat(64) }), lessonParams(lesson.id))).status).toBe(400);
    as('other');
    expect((await publishLesson(request('other', { groupId: 'class' }), lessonParams(lesson.id))).status).toBe(403);
    expect((await assignCourse(request('other', { groupId: 'class' }), courseParams(course.id))).status).toBe(403);
    await expect(LessonsPage(courseParams(course.id))).rejects.toThrow('FORBIDDEN');
    expect((await createLesson(request('other', { title: 'Intrusion' }), courseParams(course.id))).status).toBe(403);
    await expect(MaterialsPage({ params: Promise.resolve({ courseId: course.id, lessonId: lesson.id }) })).rejects.toThrow('FORBIDDEN');
    as('teacher');
    await expect(LessonsPage(courseParams('missing'))).rejects.toThrow('NOT_FOUND');
    await expect(MaterialsPage({ params: Promise.resolve({ courseId: course.id, lessonId: 'missing' }) })).rejects.toThrow('NOT_FOUND');
    as('outsider'); await expect(StudentPage(courseParams(course.id))).rejects.toThrow('NOT_FOUND');
    as('student'); await expect(LibraryPage()).rejects.toThrow('FORBIDDEN');
    state.cookie = ''; await expect(NewPage()).rejects.toThrow('UNAUTHORIZED');
  });

  it('rejects malformed course fields without a server error', async () => {
    for (const body of [{ title: {}, slug: 'bad' }, { title: 'Bad', slug: 'bad', description: 3 }, { title: ' ', slug: 'blank' }]) {
      expect((await createCourse(request('teacher', body))).status).toBe(400);
    }
  });
});
