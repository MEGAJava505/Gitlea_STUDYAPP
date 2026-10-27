import {
  type AssignmentId,
  type AuditEventType,
  type AuditLogWriter,
  type Clock,
  type GroupId,
  type RepositoryLinkId,
  type UserId,
} from '../../shared/contracts';

/**
 * A repository link whose published deadline has passed with no timely
 * submission, and therefore must be marked Failed automatically.
 */
export interface OverdueLink {
  linkId: RepositoryLinkId;
  studentId: UserId;
  assignmentId: AssignmentId;
  groupId: GroupId;
  deadline: number;
}

export interface DeadlineSweeperRepository {
  /** Links whose deadline has passed and that have no submission at all. */
  findOverdueWithoutSubmission(now: number): Promise<OverdueLink[]>;
  /** Links with a `revision_required` submission whose deadline has passed. */
  findOverdueRevisionRequired(now: number): Promise<OverdueLink[]>;
  markLinkFailed(linkId: RepositoryLinkId): Promise<void>;
}

export type DeadlineSweeperAudit = Pick<AuditLogWriter, 'append'>;

export interface SweepResult {
  /** Links moved to Failed because nothing was submitted before the deadline. */
  failedNoSubmission: number;
  /** Links moved to Failed because a revision was not resubmitted in time. */
  failedUnresolvedRevision: number;
}

/**
 * Automatic deadline enforcement (PLAN_GITEA.md §9.3).
 *
 * A student who has not submitted anything before the deadline is Failed.
 * A student whose work was returned for revision but who did not resubmit
 * before the deadline is also Failed. A timely Submitted work is never
 * touched — late review of an on-time submission does not auto-fail it.
 *
 * The sweep is idempotent: a link already in a terminal state is not selected
 * again, so repeated runs never double-count or resurrect a terminal status.
 */
export class DeadlineSweeper {
  constructor(
    private readonly deps: {
      repo: DeadlineSweeperRepository;
      audit: DeadlineSweeperAudit;
      now: Clock;
    },
  ) {}

  async sweep(): Promise<SweepResult> {
    const now = this.deps.now();
    const noSubmission = await this.deps.repo.findOverdueWithoutSubmission(now);
    const unresolved = await this.deps.repo.findOverdueRevisionRequired(now);

    for (const link of noSubmission) {
      await this.deps.repo.markLinkFailed(link.linkId);
      await this.audit('submission.auto_failed', link, 'no_submission');
    }
    for (const link of unresolved) {
      await this.deps.repo.markLinkFailed(link.linkId);
      await this.audit('submission.auto_failed', link, 'unresolved_revision');
    }

    return {
      failedNoSubmission: noSubmission.length,
      failedUnresolvedRevision: unresolved.length,
    };
  }

  private async audit(
    eventType: AuditEventType,
    link: OverdueLink,
    reason: string,
  ): Promise<void> {
    await this.deps.audit.append({
      actorId: null,
      eventType,
      targetType: 'repositoryLink',
      targetId: link.linkId,
      payload: {
        assignmentId: link.assignmentId,
        studentId: link.studentId,
        groupId: link.groupId,
        deadline: link.deadline,
        reason,
      },
    });
  }
}
