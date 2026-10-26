import { errors, type Clock, type CourseId, type GroupId, type SessionPrincipal, type UserId } from '../../shared/contracts';

export interface CourseAssignmentRecord {
  id: string;
  courseId: CourseId;
  authorId: UserId;
  title: string;
  description: string;
  allowResubmission: boolean;
  createdAt: number;
}

export interface PublishedAssignmentRecord {
  id: string;
  assignmentId: string;
  groupId: GroupId;
  deadline: number;
  publishedAt: number;
}

export type StudentAssignmentStatus = 'upcoming' | 'open' | 'overdue';
export interface StudentAssignment {
  assignment: CourseAssignmentRecord;
  publication: PublishedAssignmentRecord;
  status: StudentAssignmentStatus;
}

export interface AssignmentsRepository {
  getCourse(courseId: CourseId): Promise<{ id: CourseId; ownerId: UserId; published: boolean } | null>;
  insertCourseAssignment(input: Omit<CourseAssignmentRecord, 'id' | 'createdAt'>): Promise<CourseAssignmentRecord>;
  getCourseAssignment(assignmentId: string): Promise<CourseAssignmentRecord | null>;
  publishAssignment(input: Omit<PublishedAssignmentRecord, 'id' | 'publishedAt'>): Promise<PublishedAssignmentRecord>;
  getPublishedAssignment(publicationId: string): Promise<PublishedAssignmentRecord | null>;
  listForStudent(studentId: UserId, courseId?: CourseId): Promise<Array<{ assignment: CourseAssignmentRecord; publication: PublishedAssignmentRecord }>>;
  listForCourse(courseId: CourseId): Promise<Array<{ assignment: CourseAssignmentRecord; publication: PublishedAssignmentRecord | null }>>;
  canTeachGroup(teacherId: UserId, groupId: GroupId): Promise<boolean>;
  isCourseAssignedToGroup(courseId: CourseId, groupId: GroupId): Promise<boolean>;
  countSubmissions(assignmentId: string, studentId: UserId): Promise<number>;
}

export class AssignmentService {
  constructor(private readonly deps: { repo: AssignmentsRepository; now: Clock }) {}

  async create(input: { actor: SessionPrincipal; courseId: CourseId; title: string; description?: string; allowResubmission?: boolean }): Promise<CourseAssignmentRecord> {
    const course = await this.deps.repo.getCourse(input.courseId);
    if (!course) throw errors.notFound('course');
    if (!input.actor.roles.some((role) => ['teacher', 'admin', 'owner'].includes(role))) throw errors.forbidden('Teacher access required');
    if (!course.published) throw errors.invalidState('The course must be published before assignments can be created');
    const title = input.title.trim();
    const description = input.description?.trim() ?? '';
    if (!title) throw errors.invalidInput('title is required');
    if (typeof input.allowResubmission === 'boolean' === false && input.allowResubmission !== undefined) throw errors.invalidInput('allowResubmission must be a boolean');
    return this.deps.repo.insertCourseAssignment({
      courseId: course.id,
      authorId: input.actor.userId,
      title,
      description,
      allowResubmission: input.allowResubmission ?? false,
    });
  }

  async publish(input: { actor: SessionPrincipal; assignmentId: string; groupId: GroupId; deadline: number }): Promise<PublishedAssignmentRecord> {
    const assignment = await this.deps.repo.getCourseAssignment(input.assignmentId);
    if (!assignment) throw errors.notFound('assignment');
    const course = await this.deps.repo.getCourse(assignment.courseId);
    if (!course) throw errors.notFound('course');
    const admin = input.actor.roles.includes('admin') || input.actor.roles.includes('owner');
    const teachesGroup = input.actor.roles.includes('teacher') && await this.deps.repo.canTeachGroup(input.actor.userId, input.groupId);
    if (!admin && assignment.authorId !== input.actor.userId && !(course.ownerId === input.actor.userId && input.actor.roles.includes('teacher')) && !teachesGroup) {
      throw errors.forbidden('Only the assignment author, course owner, or group teacher may publish it');
    }
    if (!Number.isSafeInteger(input.deadline) || input.deadline < 0) throw errors.invalidInput('deadline must be a UTC epoch millisecond value');
    if (!(await this.deps.repo.isCourseAssignedToGroup(course.id, input.groupId))) throw errors.invalidState('The course must be assigned to this group first');
    return this.deps.repo.publishAssignment({ assignmentId: assignment.id, groupId: input.groupId, deadline: input.deadline });
  }

  async listForStudent(actor: SessionPrincipal, courseId?: CourseId): Promise<StudentAssignment[]> {
    if (!actor.roles.includes('student')) throw errors.forbidden('Student access required');
    const rows = await this.deps.repo.listForStudent(actor.userId, courseId);
    const now = this.deps.now();
    return rows.map(({ assignment, publication }) => ({
      assignment,
      publication,
      status: now < publication.publishedAt ? 'upcoming' : now <= publication.deadline ? 'open' : 'overdue',
    }));
  }

  async listForCourse(actor: SessionPrincipal, courseId: CourseId) {
    const course = await this.deps.repo.getCourse(courseId);
    if (!course) throw errors.notFound('course');
    const canRead = actor.roles.includes('admin') || actor.roles.includes('owner') || actor.userId === course.ownerId ||
      (actor.roles.includes('teacher') && await this.deps.repo.canTeachGroup(actor.userId, '___' as GroupId));
    if (!canRead) throw errors.forbidden();
    return this.deps.repo.listForCourse(courseId);
  }

  async assertSubmissionAllowed(publicationId: string, actor: SessionPrincipal): Promise<void> {
    const publication = await this.deps.repo.getPublishedAssignment(publicationId);
    if (!publication) throw errors.notFound('assignment publication');
    const assignment = await this.deps.repo.getCourseAssignment(publication.assignmentId);
    if (!assignment) throw errors.notFound('assignment');
    if (this.deps.now() <= publication.deadline) return;
    if (!assignment.allowResubmission) throw errors.deadlineExpired();
  }
}
