import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { courses, courseGroups, groups, groupMembers, lessons, lessonPublications } from '../db/schema';
import { errors, type SessionPrincipal } from '../shared/contracts';

export async function teacherCourseDetails(actor: SessionPrincipal, courseId: string) {
  const { db } = await import('../db/client');
  return new TeacherCoursesQuery(db).get(actor, courseId);
}

/** Read-only projection. All mutations remain in CourseService. */
export class TeacherCoursesQuery {
  constructor(private readonly db: Db) {}

  get(actor: SessionPrincipal, courseId: string) {
    if (!actor.roles.includes('teacher')) throw errors.forbidden('Teacher access required');
    const course = this.db.select().from(courses).where(eq(courses.id, courseId)).get();
    if (!course) throw errors.notFound('course');
    if (course.ownerId !== actor.userId && !actor.roles.some(role => role === 'admin' || role === 'owner')) {
      throw errors.forbidden('Only the course owner or admin can manage this course');
    }
    const courseLessons = this.db.select().from(lessons).where(eq(lessons.courseId, courseId)).all()
      .sort((a, b) => a.position - b.position);
    const availableGroups = this.db.select({ group: groups }).from(groups)
      .innerJoin(groupMembers, eq(groupMembers.groupId, groups.id))
      .where(and(eq(groupMembers.userId, actor.userId), eq(groupMembers.state, 'active'))).all().map(row => row.group);
    const assignedGroups = this.db.select({ group: groups }).from(groups)
      .innerJoin(courseGroups, eq(courseGroups.groupId, groups.id)).where(eq(courseGroups.courseId, courseId)).all().map(row => row.group);
    const publications = this.db.select({ lessonId: lessonPublications.lessonId, groupId: lessonPublications.groupId })
      .from(lessonPublications).innerJoin(lessons, eq(lessons.id, lessonPublications.lessonId))
      .where(eq(lessons.courseId, courseId)).all();
    return { course, lessons: courseLessons, availableGroups, assignedGroups, publications };
  }
}
