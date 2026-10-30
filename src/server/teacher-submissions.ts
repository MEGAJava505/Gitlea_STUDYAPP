import { and, desc, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { AssignmentStatus, NumericGrade, UserId } from '../shared/contracts';
import { type reviewDecisions, courseAssignments, groupAssignments, groups, repositoryLinks, reviews, submissions, users } from '../db/schema';
import * as relations from '../db/relations';

type Db = BetterSQLite3Database<typeof relations>;

/** The stored review outcome ('revision_required' | 'passed' | 'failed'). */
type StoredReviewDecision = typeof reviewDecisions[number];

/** A submission row on the teacher review surface, with its active review if any. */
export interface TeacherSubmissionView {
  submissionId: string;
  attempt: number;
  commitSha: string;
  submittedAt: number;
  status: AssignmentStatus;
  student: { id: UserId; displayName: string };
  group: { id: string; name: string };
  review: { decision: StoredReviewDecision; feedback: string; grade: NumericGrade | null } | null;
}

/**
 * Read model for the Teacher review panel. Lists submissions for a published
 * group assignment the requesting teacher is responsible for. A teacher who is
 * not the assignment author sees nothing (matches the review permission in
 * src/domain/permissions.ts: only the assigned teacher may act on submissions).
 */
export class TeacherSubmissionsQuery {
  constructor(private readonly db: Db) {}

  /**
   * Returns the assignment title/group context and its submissions, or null
   * when the assignment does not exist or `actor` is not its responsible teacher.
   */
  async forAssignment(
    assignmentId: string,
    actor: UserId,
  ): Promise<{ title: string; group: { id: string; name: string } } | null> {
    const meta = this.db
      .select({
        id: groupAssignments.id,
        title: courseAssignments.title,
        authorId: courseAssignments.authorId,
        publishedAt: groupAssignments.publishedAt,
        groupId: groupAssignments.groupId,
        groupName: groups.name,
      })
      .from(groupAssignments)
      .innerJoin(courseAssignments, eq(groupAssignments.courseAssignmentId, courseAssignments.id))
      .innerJoin(groups, eq(groups.id, groupAssignments.groupId))
      .where(eq(groupAssignments.id, assignmentId))
      .get();
    if (!meta || meta.authorId !== actor || meta.publishedAt === null) return null;
    return { title: meta.title, group: { id: meta.groupId, name: meta.groupName } };
  }

  async listSubmissions(assignmentId: string, actor: UserId): Promise<TeacherSubmissionView[]> {
    const meta = await this.forAssignment(assignmentId, actor);
    if (!meta) return [];

    const rows = this.db
      .select({
        submissionId: submissions.id,
        attempt: submissions.attempt,
        commitSha: submissions.commitSha,
        submittedAt: submissions.submittedAt,
        status: submissions.status,
        studentId: users.id,
        studentName: users.displayName,
        groupId: groups.id,
        groupName: groups.name,
        reviewDecision: reviews.decision,
        reviewFeedback: reviews.feedback,
        reviewGrade: reviews.grade,
      })
      .from(submissions)
      .innerJoin(repositoryLinks, eq(repositoryLinks.id, submissions.repositoryLinkId))
      .innerJoin(groupAssignments, eq(groupAssignments.id, repositoryLinks.groupAssignmentId))
      .innerJoin(groups, eq(groups.id, groupAssignments.groupId))
      .innerJoin(users, eq(users.id, repositoryLinks.studentId))
      .leftJoin(reviews, and(eq(reviews.submissionId, submissions.id), eq(reviews.isActive, true)))
      .where(eq(repositoryLinks.groupAssignmentId, assignmentId))
      .orderBy(desc(submissions.submittedAt))
      .all();

    return rows.map((r) => ({
      submissionId: r.submissionId,
      attempt: r.attempt,
      commitSha: r.commitSha,
      submittedAt: r.submittedAt,
      status: r.status,
      student: { id: r.studentId as UserId, displayName: r.studentName },
      group: { id: r.groupId, name: r.groupName },
      review: r.reviewDecision === null ? null : {
        decision: r.reviewDecision,
        feedback: r.reviewFeedback ?? '',
        grade: toNumericGrade(r.reviewGrade),
      },
    }));
  }
}

/** Coerces a stored REAL grade into the 1–5 scale; null when absent or out of range. */
function toNumericGrade(value: number | null): NumericGrade | null {
  if (value === null || typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 5) return null;
  return value as NumericGrade;
}
