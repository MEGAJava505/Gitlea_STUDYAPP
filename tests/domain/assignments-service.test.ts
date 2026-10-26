import { describe, expect, it } from 'vitest';
import { AssignmentService, type CourseAssignmentRecord, type PublishedAssignmentRecord } from '../../src/domain/assignments/service';
import { type GroupId, type SessionPrincipal, type UserId } from '../../src/shared/contracts';

const teacher: SessionPrincipal = { userId: 'teacher' as UserId, login: 't', displayName: 'T', roles: ['teacher'] };
const student: SessionPrincipal = { userId: 'student' as UserId, login: 's', displayName: 'S', roles: ['student'] };
class Repo {
  course = { id: 'course-1', ownerId: 'owner' as UserId, published: true };
  assignments: CourseAssignmentRecord[] = [];
  published: PublishedAssignmentRecord[] = [];
  async getCourse() { return this.course; }
  async insertCourseAssignment(input: Omit<CourseAssignmentRecord, 'id' | 'createdAt'>) { const row = { ...input, id: 'a1', createdAt: 0 }; this.assignments.push(row); return row; }
  async getCourseAssignment(id: string) { return this.assignments.find((a) => a.id === id) ?? null; }
  async publishAssignment(input: Omit<PublishedAssignmentRecord, 'id' | 'publishedAt'>) { const row = { ...input, id: 'p1', publishedAt: 1000 }; this.published.push(row); return row; }
  async getPublishedAssignment(id: string) { return this.published.find((a) => a.id === id) ?? null; }
  async listForStudent() { return this.published.map((publication) => ({ assignment: this.assignments[0] ?? { id: publication.assignmentId, courseId: 'course-1' as never, authorId: 'teacher' as UserId, title: 'A', description: '', allowResubmission: false, createdAt: 0 }, publication })); }
  async listForCourse() { return this.published.map((publication) => ({ assignment: this.assignments[0]!, publication })); }
  async canTeachGroup() { return true; }
  async isCourseAssignedToGroup() { return true; }
  async countSubmissions() { return 0; }
}

describe('assignment publication service', () => {
  it('creates and publishes an assignment with a deadline', async () => {
    const repo = new Repo();
    const service = new AssignmentService({ repo, now: () => 1000 });
    const created = await service.create({ actor: teacher, courseId: 'course-1' as never, title: 'Practice' });
    expect(created.title).toBe('Practice');
    const published = await service.publish({ actor: teacher, assignmentId: created.id, groupId: 'g1' as GroupId, deadline: 5000 });
    expect(published.deadline).toBe(5000);
  });

  it('computes upcoming/open/overdue student status', async () => {
    const repo = new Repo();
    repo.published = [{ id: 'p1', assignmentId: 'a1', groupId: 'g1' as GroupId, deadline: 2000, publishedAt: 1000 }];
    const service = new AssignmentService({ repo, now: () => 1500 });
    expect((await service.listForStudent(student))[0].status).toBe('open');
    repo.published[0].deadline = 1000;
    expect((await service.listForStudent(student))[0].status).toBe('overdue');
    repo.published[0].publishedAt = 3000;
    expect((await service.listForStudent(student))[0].status).toBe('upcoming');
  });

  it('blocks late new submissions but permits configured resubmission', async () => {
    const repo = new Repo();
    repo.published = [{ id: 'p1', assignmentId: 'a1', groupId: 'g1' as GroupId, deadline: 1000, publishedAt: 0 }];
    repo.assignments = [{ id: 'a1', courseId: 'course-1' as never, authorId: 'teacher' as UserId, title: 'A', description: '', allowResubmission: false, createdAt: 0 }];
    const service = new AssignmentService({ repo, now: () => 1001 });
    await expect(service.assertSubmissionAllowed('p1', student)).rejects.toMatchObject({ code: 'DEADLINE_EXPIRED' });
    repo.assignments[0] = { id: 'a1', courseId: 'course-1' as never, authorId: 'teacher' as UserId, title: 'A', description: '', allowResubmission: true, createdAt: 0 };
    await expect(service.assertSubmissionAllowed('p1', student)).resolves.toBeUndefined();
  });
});
