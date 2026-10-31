import { and, asc, desc, eq, isNotNull, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { AssignmentStatus, NumericGrade, UserId } from '../shared/contracts';
import { type reviewDecisions, courseAssignments, groupAssignments, groupMembers, repositoryLinks, reviews, submissions } from '../db/schema';
import * as relations from '../db/relations';

type Db = BetterSQLite3Database<typeof relations>;

/** The stored review outcome ('revision_required' | 'passed' | 'failed'). */
type StoredReviewDecision = typeof reviewDecisions[number];

export interface StudentAssignmentSummary {
  id: string;
  title: string;
  deadline: number;
  status: AssignmentStatus | 'not_started';
}

/** A review surfaced to the student who owns the submission. */
export interface StudentReviewView {
  decision: StoredReviewDecision;
  feedback: string;
  grade: NumericGrade | null;
}

export interface StudentAttemptView {
  attempt: number;
  commitSha: string;
  submittedAt: number;
  status: AssignmentStatus;
  /** Active review for this attempt; null when it has not been reviewed. */
  review: StudentReviewView | null;
}

export interface StudentAssignmentDetail extends StudentAssignmentSummary {
  description: string;
  allowResubmission: boolean;
  repository: { fullName: string } | null;
  attempts: StudentAttemptView[];
}

/**
 * Read model for the Student Panel. Only published assignments of groups the
 * student is an active member of are visible; anything else is reported as
 * absent so other groups' assignments cannot be probed.
 */
export class StudentAssignmentsQuery {
  constructor(private readonly db: Db) {}

  async list(studentId: UserId): Promise<StudentAssignmentSummary[]> {
    return this.visible(studentId).orderBy(asc(groupAssignments.deadline)).all().map(toSummary);
  }

  async get(studentId: UserId, assignmentId: string): Promise<StudentAssignmentDetail | null> {
    const row = this.visible(studentId, assignmentId).get();
    if (!row) return null;
    const attemptRows = row.linkId
      ? this.db
        .select({
          attempt: submissions.attempt,
          commitSha: submissions.commitSha,
          submittedAt: submissions.submittedAt,
          status: submissions.status,
          reviewDecision: reviews.decision,
          reviewFeedback: reviews.feedback,
          reviewGrade: reviews.grade,
        })
        .from(submissions)
        .leftJoin(reviews, and(
          eq(reviews.submissionId, submissions.id),
          eq(reviews.isActive, true),
        ))
        .where(eq(submissions.repositoryLinkId, row.linkId))
        .orderBy(desc(submissions.attempt))
        .all()
      : [];
    const attempts: StudentAttemptView[] = attemptRows.map((r) => ({
      attempt: r.attempt,
      commitSha: r.commitSha,
      submittedAt: r.submittedAt,
      status: r.status,
      review: r.reviewDecision === null ? null : {
        decision: r.reviewDecision,
        feedback: r.reviewFeedback ?? '',
        grade: toNumericGrade(r.reviewGrade),
      },
    }));
    return {
      ...toSummary(row),
      description: row.description,
      allowResubmission: row.allowResubmission,
      repository: row.fullName ? { fullName: row.fullName } : null,
      attempts,
    };
  }

  private visible(studentId: UserId, assignmentId?: string) {
    return this.db
      .select({
        id: groupAssignments.id,
        title: courseAssignments.title,
        description: courseAssignments.description,
        allowResubmission: courseAssignments.allowResubmission,
        deadline: groupAssignments.deadline,
        linkId: repositoryLinks.id,
        fullName: repositoryLinks.fullName,
        linkStatus: repositoryLinks.status,
        latestStatus: sql<AssignmentStatus | null>`(SELECT status FROM submissions
          WHERE repository_link_id = ${repositoryLinks.id}
          ORDER BY attempt DESC LIMIT 1)`,
      })
      .from(groupAssignments)
      .innerJoin(courseAssignments, eq(groupAssignments.courseAssignmentId, courseAssignments.id))
      .innerJoin(groupMembers, and(
        eq(groupMembers.groupId, groupAssignments.groupId),
        eq(groupMembers.userId, studentId),
        eq(groupMembers.state, 'active'),
      ))
      .leftJoin(repositoryLinks, and(
        eq(repositoryLinks.groupAssignmentId, groupAssignments.id),
        eq(repositoryLinks.studentId, studentId),
      ))
      .where(and(
        isNotNull(groupAssignments.publishedAt),
        assignmentId === undefined ? undefined : eq(groupAssignments.id, assignmentId),
      ));
  }
}

function toSummary(row: {
  id: string; title: string; deadline: number | null;
  linkStatus: AssignmentStatus | null; latestStatus: AssignmentStatus | null;
}): StudentAssignmentSummary {
  // Reviews update attempts; a nonterminal link can lag behind them. Persistence
  // must synchronize the link upstream. Never undo a terminal link (in particular
  // the deadline sweeper's automatic failure) using an older attempt.
  const status = row.linkStatus === 'passed' || row.linkStatus === 'failed'
    ? row.linkStatus
    : row.latestStatus ?? row.linkStatus ?? 'not_started';
  return { id: row.id, title: row.title, deadline: row.deadline ?? 0, status };
}

/** Coerces a stored REAL grade into the 1–5 scale; null when absent or out of range. */
function toNumericGrade(value: number | null): NumericGrade | null {
  if (value === null || typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 5) return null;
  return value as NumericGrade;
}
