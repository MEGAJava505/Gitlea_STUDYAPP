import { and, eq, isNotNull, max, or } from 'drizzle-orm';
import type { Db } from '../../db/client';
import {
  courseAssignments,
  courseGroups,
  courses,
  groupAssignments,
  groupMembers,
  groups,
  lessonPublications,
  lessons,
} from '../../db/schema';
import { hasRolePermission } from '../permissions';
import { errors, type Clock, type CourseId, type GroupId, type SessionPrincipal } from '../../shared/contracts';

interface CourseInput {
  actor: SessionPrincipal;
  title: string;
  slug: string;
  description?: string;
}

interface CoursePatch {
  title?: string;
  slug?: string;
  description?: string;
}

export class CourseService {
  constructor(private readonly deps: { db: Db; now: Clock }) {}

  async createCourse(input: CourseInput) {
    this.requireTeacher(input.actor);
    const slug = this.slug(input.slug);
    const title = this.text(input.title, 'title');
    const description = input.description === undefined ? '' : this.text(input.description, 'description', true);
    return this.deps.db.transaction((tx) => {
      if (tx.select().from(courses).where(eq(courses.slug, slug)).get()) throw errors.conflict('Course slug already exists');
      const now = this.deps.now();
      return tx.insert(courses).values({ slug, title, description, ownerId: input.actor.userId, createdAt: now, updatedAt: now }).returning().get();
    });
  }

  async updateCourse(actor: SessionPrincipal, courseId: CourseId, patch: CoursePatch) {
    this.requirePatch(patch);
    this.requireCanManage(await this.requireCourse(courseId), actor);
    const values: Partial<typeof courses.$inferInsert> = { updatedAt: this.deps.now() };
    if (patch.title !== undefined) values.title = this.text(patch.title, 'title');
    if (patch.description !== undefined) values.description = this.text(patch.description, 'description', true);
    if (patch.slug !== undefined) values.slug = this.slug(patch.slug);
    return this.deps.db.transaction((tx) => {
      if (values.slug && tx.select().from(courses).where(eq(courses.slug, values.slug)).all().some((row) => row.id !== courseId)) {
        throw errors.conflict('Course slug already exists');
      }
      const updated = tx.update(courses).set(values).where(eq(courses.id, courseId)).returning().get();
      if (!updated) throw errors.notFound('course');
      return updated;
    });
  }

  async publishCourse(actor: SessionPrincipal, courseId: CourseId) {
    const course = await this.requireCourse(courseId);
    this.requireCanManage(course, actor);
    if (course.publishedAt !== null) return course;
    return this.deps.db.update(courses).set({ publishedAt: this.deps.now(), updatedAt: this.deps.now() })
      .where(eq(courses.id, courseId)).returning().get();
  }

  async listLibrary(actor: SessionPrincipal) {
    const db = this.deps.db;
    if (this.isAdmin(actor)) return db.select().from(courses).all();
    if (actor.roles.includes('teacher')) {
      return db.select().from(courses).where(or(eq(courses.ownerId, actor.userId), isNotNull(courses.publishedAt))).all();
    }
    if (!actor.roles.includes('student')) throw errors.forbidden();
    return db.selectDistinct({ course: courses }).from(courses)
      .innerJoin(courseGroups, eq(courseGroups.courseId, courses.id))
      .innerJoin(groupMembers, eq(groupMembers.groupId, courseGroups.groupId))
      .where(and(eq(groupMembers.userId, actor.userId), eq(groupMembers.state, 'active'))).all().map((row) => row.course);
  }

  async assignCourseToGroup(actor: SessionPrincipal, courseId: CourseId, groupId: GroupId) {
    const course = await this.requireCourse(courseId);
    const group = await this.deps.db.select().from(groups).where(eq(groups.id, groupId)).get();
    if (!group) throw errors.notFound('group');
    if (!this.isAdmin(actor) && actor.userId !== course.ownerId) {
      if (!actor.roles.includes('teacher') || course.publishedAt === null || !(await this.teachesGroup(actor, groupId))) {
        throw errors.forbidden('Only the course owner, admin, or the group teacher can assign this course');
      }
    }
    return this.deps.db.transaction((tx) => {
      const existing = tx.select().from(courseGroups)
        .where(and(eq(courseGroups.courseId, courseId), eq(courseGroups.groupId, groupId))).get();
      if (existing) return existing;
      return tx.insert(courseGroups).values({ courseId, groupId, createdAt: this.deps.now() }).returning().get();
    });
  }

  async createLesson(input: {
    actor: SessionPrincipal; courseId: CourseId; title: string; contentMetadata?: Record<string, unknown>;
  }) {
    const course = await this.requireCourse(input.courseId);
    this.requireCanManage(course, input.actor);
    const title = this.text(input.title, 'title');
    if (input.contentMetadata !== undefined && (!input.contentMetadata || typeof input.contentMetadata !== 'object' || Array.isArray(input.contentMetadata))) {
      throw errors.invalidInput('contentMetadata must be an object');
    }
    return this.deps.db.transaction((tx) => {
      const currentPosition = tx.select({ position: max(lessons.position) }).from(lessons)
        .where(eq(lessons.courseId, input.courseId)).get()?.position;
      const now = this.deps.now();
      return tx.insert(lessons).values({
        courseId: input.courseId,
        title,
        position: (currentPosition ?? -1) + 1,
        contentMetadata: input.contentMetadata ?? {},
        createdAt: now,
        updatedAt: now,
      }).returning().get();
    });
  }

  async updateLesson(input: {
    actor: SessionPrincipal; lessonId: string; title?: string; contentMetadata?: Record<string, unknown>;
  }) {
    const lesson = await this.requireLesson(input.lessonId);
    const course = await this.requireCourse(lesson.courseId);
    this.requireCanManage(course, input.actor);
    const values: Partial<typeof lessons.$inferInsert> = { updatedAt: this.deps.now() };
    if (input.title !== undefined) values.title = this.text(input.title, 'title');
    if (input.contentMetadata !== undefined) {
      if (!input.contentMetadata || typeof input.contentMetadata !== 'object' || Array.isArray(input.contentMetadata)) throw errors.invalidInput('contentMetadata must be an object');
      values.contentMetadata = input.contentMetadata;
    }
    if (Object.keys(values).length === 1) throw errors.invalidInput('At least one lesson field is required');
    return this.deps.db.update(lessons).set(values).where(eq(lessons.id, lesson.id)).returning().get();
  }

  async reorderLessons(actor: SessionPrincipal, courseId: CourseId, lessonIds: string[]) {
    const course = await this.requireCourse(courseId);
    this.requireCanManage(course, actor);
    if (!Array.isArray(lessonIds) || lessonIds.some((id) => typeof id !== 'string') || new Set(lessonIds).size !== lessonIds.length) {
      throw errors.invalidInput('lessonIds must contain unique lesson IDs');
    }
    return this.deps.db.transaction((tx) => {
      const current = tx.select().from(lessons).where(eq(lessons.courseId, courseId)).all();
      const existingIds = new Set(current.map((lesson) => lesson.id));
      if (current.length !== lessonIds.length || lessonIds.some((id) => !existingIds.has(id))) {
        throw errors.invalidInput('lessonIds must list every lesson in this course exactly once');
      }
      const offset = current.length + 1;
      for (const lesson of current) {
        tx.update(lessons).set({ position: lesson.position + offset, updatedAt: this.deps.now() }).where(eq(lessons.id, lesson.id)).run();
      }
      for (const [position, id] of lessonIds.entries()) {
        tx.update(lessons).set({ position, updatedAt: this.deps.now() }).where(eq(lessons.id, id)).run();
      }
      return tx.select().from(lessons).where(eq(lessons.courseId, courseId)).all().sort((a, b) => a.position - b.position);
    });
  }

  async publishLessonToGroup(actor: SessionPrincipal, lessonId: string, groupId: GroupId) {
    const lesson = await this.requireLesson(lessonId);
    const course = await this.requireCourse(lesson.courseId);
    const group = await this.deps.db.select().from(groups).where(eq(groups.id, groupId)).get();
    if (!group) throw errors.notFound('group');
    const assigned = await this.deps.db.select().from(courseGroups)
      .where(and(eq(courseGroups.courseId, course.id), eq(courseGroups.groupId, groupId))).get();
    if (!assigned) throw errors.invalidState('The course must be assigned to this group first');
    if (!this.isAdmin(actor) && actor.userId !== course.ownerId) {
      if (!actor.roles.includes('teacher') || course.publishedAt === null || !(await this.teachesGroup(actor, groupId))) {
        throw errors.forbidden('Only the course owner, admin, or the group teacher can publish this lesson');
      }
    }
    return this.deps.db.transaction((tx) => {
      const existing = tx.select().from(lessonPublications)
        .where(and(eq(lessonPublications.lessonId, lesson.id), eq(lessonPublications.groupId, groupId))).get();
      if (existing) return existing;
      const now = this.deps.now();
      return tx.insert(lessonPublications).values({ lessonId: lesson.id, groupId, publishedAt: now, createdAt: now, updatedAt: now }).returning().get();
    });
  }

  async listPublishedLessonsForStudent(actor: SessionPrincipal, courseId: CourseId) {
    if (!actor.roles.includes('student')) throw errors.forbidden('Student access required');
    await this.requireCourse(courseId);
    return this.deps.db.selectDistinct({ lesson: lessons }).from(lessons)
      .innerJoin(lessonPublications, eq(lessonPublications.lessonId, lessons.id))
      .innerJoin(groupMembers, eq(groupMembers.groupId, lessonPublications.groupId))
      .innerJoin(courseGroups, and(eq(courseGroups.groupId, lessonPublications.groupId), eq(courseGroups.courseId, lessons.courseId)))
      .where(and(eq(lessons.courseId, courseId), eq(groupMembers.userId, actor.userId), eq(groupMembers.state, 'active')))
      .all().map((row) => row.lesson).sort((a, b) => a.position - b.position);
  }

  async createExtraAssignment(input: {
    actor: SessionPrincipal; courseId: CourseId; groupId: GroupId; title: string; description?: string;
    allowResubmission?: boolean; deadline?: number | null; published?: boolean;
  }) {
    const course = await this.requireCourse(input.courseId);
    if (this.isAdmin(input.actor) || input.actor.userId === course.ownerId || !input.actor.roles.includes('teacher')) {
      throw errors.forbidden('An extra assignment is only available to a teacher using another author’s course');
    }
    if (course.publishedAt === null) throw errors.invalidState('The course must be published before it can be used');
    if (!(await this.teachesGroup(input.actor, input.groupId))) throw errors.forbidden('You may only create assignments for your own group');
    const group = await this.deps.db.select().from(groups).where(eq(groups.id, input.groupId)).get();
    if (!group) throw errors.notFound('group');
    const assigned = await this.deps.db.select().from(courseGroups)
      .where(and(eq(courseGroups.courseId, input.courseId), eq(courseGroups.groupId, input.groupId))).get();
    if (!assigned) throw errors.invalidState('The course must be assigned to this group first');
    const title = this.text(input.title, 'title');
    const description = input.description === undefined ? '' : this.text(input.description, 'description', true);
    const deadline = input.deadline ?? null;
    const published = input.published ?? false;
    if (deadline !== null && (!Number.isSafeInteger(deadline) || deadline < 0)) throw errors.invalidInput('deadline must be a UTC epoch millisecond value');
    if (published && deadline === null) throw errors.invalidInput('A published assignment requires a deadline');
    return this.deps.db.transaction((tx) => {
      const now = this.deps.now();
      const courseAssignment = tx.insert(courseAssignments).values({
        courseId: input.courseId,
        authorId: input.actor.userId,
        title,
        description,
        allowResubmission: input.allowResubmission ?? false,
        createdAt: now,
        updatedAt: now,
      }).returning().get();
      const groupAssignment = tx.insert(groupAssignments).values({
        courseAssignmentId: courseAssignment.id,
        groupId: input.groupId,
        deadline,
        publishedAt: published ? now : null,
        createdAt: now,
        updatedAt: now,
      }).returning().get();
      return { courseAssignment, groupAssignment };
    });
  }

  private isAdmin(actor: SessionPrincipal) {
    return hasRolePermission(actor.roles, 'identity:grant_role');
  }

  private requireTeacher(actor: SessionPrincipal) {
    if (!actor.roles.includes('teacher') && !this.isAdmin(actor)) throw errors.forbidden('Teacher access required');
  }

  private requireCanManage(course: typeof courses.$inferSelect, actor: SessionPrincipal) {
    if (!this.isAdmin(actor) && actor.userId !== course.ownerId) throw errors.forbidden('Only the course owner or admin can edit the original course');
  }

  private async requireCourse(courseId: string) {
    const course = await this.deps.db.select().from(courses).where(eq(courses.id, courseId)).get();
    if (!course) throw errors.notFound('course');
    return course;
  }

  private async requireLesson(lessonId: string) {
    const lesson = await this.deps.db.select().from(lessons).where(eq(lessons.id, lessonId)).get();
    if (!lesson) throw errors.notFound('lesson');
    return lesson;
  }

  private async teachesGroup(actor: SessionPrincipal, groupId: GroupId) {
    if (!actor.roles.includes('teacher')) return false;
    return Boolean(await this.deps.db.select().from(groupMembers).where(and(
      eq(groupMembers.groupId, groupId), eq(groupMembers.userId, actor.userId), eq(groupMembers.state, 'active'),
    )).get());
  }

  private requirePatch(patch: CoursePatch) {
    if (Object.keys(patch).length === 0 || Object.values(patch).some((value) => value === undefined)) {
      throw errors.invalidInput('At least one course field is required');
    }
  }

  private text(value: string, field: string, allowEmpty = false) {
    if (typeof value !== 'string' || (!allowEmpty && !value.trim())) throw errors.invalidInput(`${field} is required`);
    return value.trim();
  }

  private slug(value: string) {
    const slug = this.text(value, 'slug').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (!slug) throw errors.invalidInput('slug must contain ASCII letters or digits');
    return slug;
  }
}

export const CourseServiceImpl = CourseService;
