import { and, asc, desc, eq, isNotNull, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { AssignmentStatus, UserId } from '../shared/contracts';
import { courseAssignments, groupAssignments, groupMembers, repositoryLinks, submissions } from '../db/schema';
import * as relations from '../db/relations';

type Db = BetterSQLite3Database<typeof relations>;

export interface StudentAssignmentSummary {
  id: string;
  title: string;
  deadline: number;
  status: AssignmentStatus | 'not_started';
}

export interface StudentAssignmentDetail extends StudentAssignmentSummary {
  description: string;
  allowResubmission: boolean;
  repository: { fullName: string } | null;
  attempts: Array<{ attempt: number; commitSha: string; submittedAt: number; status: AssignmentStatus }>;
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
    const attempts = row.linkId
      ? this.db
        .select({
          attempt: submissions.attempt,
          commitSha: submissions.commitSha,
          submittedAt: submissions.submittedAt,
          status: submissions.status,
        })
        .from(submissions)
        .where(eq(submissions.repositoryLinkId, row.linkId))
        .orderBy(desc(submissions.attempt))
        .all()
      : [];
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
