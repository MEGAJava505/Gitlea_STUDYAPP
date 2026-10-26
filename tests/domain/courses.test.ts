import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../../src/db/schema';
import * as relations from '../../src/db/relations';
import { CourseService } from '../../src/domain/courses/service';
import type { SessionPrincipal } from '../../src/shared/contracts';

export const actor = (name: string, roles: SessionPrincipal['roles']): SessionPrincipal => ({
  userId: name as SessionPrincipal['userId'], login: name, displayName: name, roles,
});
const author = actor('author', ['teacher']);
const teacher = actor('teacher', ['teacher']);
const student = actor('student', ['student']);
let sqlite: Database.Database;
let service: CourseService;
beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema: { ...schema, ...relations } });
  migrate(db, { migrationsFolder: 'drizzle' });
  ['author', 'teacher', 'student', 'admin', 'owner', 'studentB', 'studentC'].forEach((id, i) => {
    db.insert(schema.users).values({ id, giteaId: i + 1, login: id, email: `${id}@example.com`, displayName: id }).run();
  });
  db.insert(schema.groups).values([{ id: 'a', code: 'a', name: 'A' }, { id: 'b', code: 'b', name: 'B' }, { id: 'c', code: 'c', name: 'C' }]).run();
  db.insert(schema.groupMembers).values([
    { groupId: 'a', userId: 'teacher' }, { groupId: 'a', userId: 'student' },
    { groupId: 'b', userId: 'studentB' }, { groupId: 'c', userId: 'studentC' },
  ]).run();
  service = new CourseService({ db, now: () => 1000 });
});
afterEach(() => sqlite.close());

describe('course library', () => {
  it('normalizes slugs, assigns ownership, and rejects slug conflicts', async () => {
    const course = await service.createCourse({ actor: author, title: 'Intro', slug: ' Intro Python! ' });
    expect(course).toMatchObject({ slug: 'intro-python', ownerId: 'author', createdAt: 1000 });
    expect((await service.listLibrary(author)).map((row) => row.id)).toEqual([course.id]);
    expect(await service.listLibrary(teacher)).toEqual([]);
    await expect(service.createCourse({ actor: author, title: 'Duplicate', slug: 'intro-python' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(service.createCourse({ actor: student, title: 'No', slug: 'no' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});


describe('course permissions and publication', () => {
  it('restricts original edits to owner or admin', async () => {
    const course = await service.createCourse({ actor: author, title: 'Intro', slug: 'intro' });
    await expect(service.updateCourse(teacher, course.id, { title: 'Changed' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const admin = actor('admin', ['admin']);
    const owner = actor('owner', ['owner']);
    expect((await service.updateCourse(admin, course.id, { title: 'Changed' })).title).toBe('Changed');
    expect((await service.updateCourse(owner, course.id, { description: 'Owner' })).description).toBe('Owner');
    await expect(service.publishCourse(student, course.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(service.publishCourse(teacher, course.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await service.publishCourse(author, course.id)).publishedAt).toBe(1000);
    expect((await service.publishCourse(owner, course.id)).publishedAt).toBe(1000);
  });

  it('assigns a published course idempotently only for the group teacher', async () => {
    const course = await service.createCourse({ actor: author, title: 'Intro', slug: 'intro' });
    await expect(service.assignCourseToGroup(teacher, course.id, 'a' as never)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await service.publishCourse(author, course.id);
    await expect(service.assignCourseToGroup(teacher, course.id, 'b' as never)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const first = await service.assignCourseToGroup(teacher, course.id, 'a' as never);
    const second = await service.assignCourseToGroup(teacher, course.id, 'a' as never);
    expect(second.id).toBe(first.id);
    expect((await service.listLibrary(student)).map((row) => row.id)).toEqual([course.id]);
  });

  it('publishes lessons per group and exposes only assigned-group lessons to students', async () => {
    const course = await service.createCourse({ actor: author, title: 'Intro', slug: 'intro' });
    const lesson = await service.createLesson({ actor: author, courseId: course.id, title: 'One' });
    const unpublished = await service.createLesson({ actor: author, courseId: course.id, title: 'Draft' });
    await service.assignCourseToGroup(author, course.id, 'a' as never);
    await service.assignCourseToGroup(author, course.id, 'b' as never);
    await service.publishLessonToGroup(author, lesson.id, 'a' as never);
    const firstPublication = await service.publishLessonToGroup(author, lesson.id, 'a' as never);
    const retryPublication = await service.publishLessonToGroup(author, lesson.id, 'a' as never);
    expect(retryPublication.id).toBe(firstPublication.id);
    expect((await service.listPublishedLessonsForStudent(student, course.id)).map((row) => row.id)).toEqual([lesson.id]);
    expect(await service.listPublishedLessonsForStudent(actor('studentB', ['student']), course.id)).toEqual([]);
    expect(await service.listPublishedLessonsForStudent(actor('studentC', ['student']), course.id)).toEqual([]);
    expect(await service.listPublishedLessonsForStudent(student, course.id)).not.toContainEqual(expect.objectContaining({ id: unpublished.id }));
    await expect(service.publishLessonToGroup(actor('otherTeacher', ['teacher']), lesson.id, 'a' as never)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(service.publishLessonToGroup(author, lesson.id, 'c' as never)).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('keeps extra assignments scoped to the teaching group and does not change the course', async () => {
    const course = await service.createCourse({ actor: author, title: 'Intro', slug: 'intro' });
    await service.publishCourse(author, course.id);
    await service.assignCourseToGroup(author, course.id, 'a' as never);
    const assignment = await service.createExtraAssignment({
      actor: teacher, courseId: course.id, groupId: 'a' as never, title: 'Practice', deadline: 2000, published: true,
    });
    expect(assignment.groupAssignment).toMatchObject({ groupId: 'a', deadline: 2000, publishedAt: 1000 });
    expect((await service.listLibrary(author)).map((row) => row.id)).toEqual([course.id]);
    await expect(service.createExtraAssignment({ actor: teacher, courseId: course.id, groupId: 'a' as never, title: 'No deadline', published: true }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(service.createExtraAssignment({ actor: teacher, courseId: course.id, groupId: 'a' as never, title: 'Bad deadline', deadline: 1.5 }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(service.createExtraAssignment({ actor: teacher, courseId: course.id, groupId: 'b' as never, title: 'Other' }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});


describe('lesson ordering', () => {
  it('reorders all lessons into dense positions and rejects incomplete orders', async () => {
    const course = await service.createCourse({ actor: author, title: 'Intro', slug: 'intro' });
    const first = await service.createLesson({ actor: author, courseId: course.id, title: 'First' });
    const second = await service.createLesson({ actor: author, courseId: course.id, title: 'Second' });
    const third = await service.createLesson({ actor: author, courseId: course.id, title: 'Third' });
    await expect(service.reorderLessons(author, course.id, [third.id, first.id])).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const rows = await service.reorderLessons(author, course.id, [third.id, first.id, second.id]);
    expect(rows.map(({ title, position }) => [title, position])).toEqual([['Third', 0], ['First', 1], ['Second', 2]]);
  });
});
