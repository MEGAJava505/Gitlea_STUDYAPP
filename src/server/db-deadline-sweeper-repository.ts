import { and, eq, isNotNull, isNull, lt, notInArray, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  type OverdueLink,
  type DeadlineSweeperRepository,
} from '../domain/assignments/deadline-sweeper';
import {
  type AssignmentId,
  type GroupId,
  type RepositoryLinkId,
  type UserId,
} from '../shared/contracts';
import { groupAssignments, repositoryLinks, submissions } from '../db/schema';
import * as relations from '../db/relations';

type Db = BetterSQLite3Database<typeof relations>;

/**
 * SQLite-backed DeadlineSweeperRepository. Selects repository links whose
 * published deadline has passed and that either have no submission at all or
 * only an unresolved revision_required, then marks them Failed. Terminal and
 * timely-submitted links are never selected, so the sweep is idempotent.
 */
export class DbDeadlineSweeperRepository implements DeadlineSweeperRepository {
  constructor(private readonly db: Db) {}

  async findOverdueWithoutSubmission(now: number): Promise<OverdueLink[]> {
    return this.overdueSelect(now)
      .where(and(this.overdueConditions(now), isNull(submissions.id)))
      .all()
      .map(toOverdueLink);
  }

  async findOverdueRevisionRequired(now: number): Promise<OverdueLink[]> {
    // Links that DO have at least one submission, but the latest submission is
    // revision_required — i.e. the student was asked to fix it and did not
    // resubmit before the deadline.
    return this.overdueSelect(now)
      .where(
        and(
          this.overdueConditions(now),
          isNotNull(submissions.id),
          inLatestSubmissionIsRevisionRequired(),
        ),
      )
      .all()
      .map(toOverdueLink);
  }

  async markLinkFailed(linkId: RepositoryLinkId, now = Date.now()): Promise<boolean> {
    // A candidate can become stale while remote submission work finishes.
    // Recheck eligibility in the UPDATE itself, not only in the selection pass.
    const result = this.db.update(repositoryLinks).set({ status: 'failed' }).where(and(
      eq(repositoryLinks.id, linkId),
      notInArray(repositoryLinks.status, ['passed', 'failed']),
      sql`EXISTS (SELECT 1 FROM group_assignments ga
        WHERE ga.id = ${repositoryLinks.groupAssignmentId}
          AND ga.published_at IS NOT NULL AND ga.deadline < ${now})`,
      sql`COALESCE((SELECT s.status FROM submissions s
        WHERE s.repository_link_id = ${repositoryLinks.id}
        ORDER BY s.attempt DESC LIMIT 1), 'in_progress') IN ('in_progress', 'revision_required')`,
    )).run();
    return result.changes > 0;
  }

  /**
   * Shared select for overdue links. Joins the published group assignment and
   * left-joins submissions so callers can distinguish "no submission" from
   * "has a submission".
   */
  private overdueSelect(_now: number) {
    return this.db
      .select({
        linkId: repositoryLinks.id,
        studentId: repositoryLinks.studentId,
        assignmentId: repositoryLinks.groupAssignmentId,
        groupId: groupAssignments.groupId,
        deadline: groupAssignments.deadline,
      })
      .from(repositoryLinks)
      .innerJoin(groupAssignments, eq(repositoryLinks.groupAssignmentId, groupAssignments.id))
      .leftJoin(submissions, eq(submissions.repositoryLinkId, repositoryLinks.id));
  }

  /** Conditions shared by every overdue query. */
  private overdueConditions(now: number) {
    return and(
      isNotNull(groupAssignments.publishedAt),
      isNotNull(groupAssignments.deadline),
      lt(groupAssignments.deadline, now),
      // Never resurrect a terminal link.
      notInArray(repositoryLinks.status, ['passed', 'failed']),
    );
  }
}

/**
 * Restricts to links whose most recent submission (by attempt) has status
 * revision_required. Implemented with a SQLite correlated sub-select.
 */
function inLatestSubmissionIsRevisionRequired() {
  return sql`${submissions.id} = (
    SELECT s2.id FROM submissions s2
    WHERE s2.repository_link_id = ${repositoryLinks.id}
    ORDER BY s2.attempt DESC
    LIMIT 1
  ) AND ${submissions.status} = 'revision_required'`;
}

function toOverdueLink(row: {
  linkId: string;
  studentId: string;
  assignmentId: string;
  groupId: string;
  deadline: number | null;
}): OverdueLink {
  return {
    linkId: row.linkId as RepositoryLinkId,
    studentId: row.studentId as UserId,
    assignmentId: row.assignmentId as AssignmentId,
    groupId: row.groupId as GroupId,
    deadline: row.deadline ?? 0,
  };
}
