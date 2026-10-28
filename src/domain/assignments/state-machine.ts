import {
  AssignmentId,
  AssignmentRepository,
  AssignmentStateMachine,
  AssignmentStatus,
  AssignmentView,
  AuditLogWriter,
  Clock,
  InlineComment,
  NumericGrade,
  PermissionChecker,
  RepositoryLinkId,
  RepositoryLinkRecord,
  RequestRevisionInput,
  ReviewInput,
  ReviewResult,
  SubmissionId,
  SubmissionRecord,
  SubmitInput,
  SubmitResult,
  errors,
} from '../../shared/contracts';
import { GiteaSubmissionPort } from '../../server/ports/gitea-submissions';

/**
 * Exact state machine from TASK_C:
 *
 *   in_progress       -> submitted
 *   submitted         -> revision_required | passed | failed
 *   revision_required -> submitted | failed
 *   passed, failed    -> (terminal)
 *
 * Layered constraints (server time is authoritative):
 *  - submit requires an unexpired deadline and a real remote commit.
 *  - revision_required may not be issued after the deadline.
 *  - after the deadline a timely submitted work may only become passed/failed.
 *  - resubmission from revision_required is only allowed by policy.
 */
export const TRANSITIONS: Readonly<Record<AssignmentStatus, readonly AssignmentStatus[]>> = {
  in_progress: ['submitted'],
  submitted: ['revision_required', 'passed', 'failed'],
  revision_required: ['submitted', 'failed'],
  passed: [],
  failed: [],
};

export function canTransition(from: AssignmentStatus, to: AssignmentStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

interface StateMachineDeps {
  repo: AssignmentRepository;
  gitea: GiteaSubmissionPort;
  permissions: PermissionChecker;
  audit: AuditLogWriter;
  now: Clock;
}

// Coordination avoids duplicate remote work for machines sharing an adapter.
// SQLite uniqueness remains the authority across adapters/processes.
const submissionQueues = new WeakMap<AssignmentRepository, Map<string, Promise<void>>>();

export class AssignmentStateMachineImpl implements AssignmentStateMachine {
  private readonly repo: AssignmentRepository;
  private readonly gitea: GiteaSubmissionPort;
  private readonly permissions: PermissionChecker;
  private readonly audit: AuditLogWriter;
  private readonly now: Clock;

  constructor(deps: StateMachineDeps) {
    this.repo = deps.repo;
    this.gitea = deps.gitea;
    this.permissions = deps.permissions;
    this.audit = deps.audit;
    this.now = deps.now;
  }

  async submit(input: SubmitInput): Promise<SubmitResult> {
    let queues = submissionQueues.get(this.repo);
    if (!queues) { queues = new Map(); submissionQueues.set(this.repo, queues); }
    const scope = JSON.stringify([input.assignmentId, input.actor.userId]);
    const previous = queues.get(scope) ?? Promise.resolve();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    queues.set(scope, pending);
    await previous;
    try { return await this.submitOnce(input); } finally {
      release();
      if (queues.get(scope) === pending) queues.delete(scope);
    }
  }

  private async replay(input: SubmitInput, existing: SubmissionRecord): Promise<SubmitResult> {
    const conflict = existing.commitSha !== input.commitSha;
    await this.audit.append({
      actorId: input.actor.userId,
      eventType: conflict ? 'submission.conflict' : 'submission.idempotent',
      targetType: 'submission', targetId: existing.id,
      payload: { attempt: existing.attempt, commitSha: input.commitSha, idempotencyKey: input.idempotencyKey },
    });
    if (conflict) throw errors.conflict('Idempotency key was already used for a different commit');
    return { submission: existing, alreadyExisted: true };
  }

  private async submitOnce(input: SubmitInput): Promise<SubmitResult> {
    const { actor, assignmentId, commitSha, idempotencyKey } = input;
    if (!idempotencyKey?.trim() || !commitSha?.trim()) {
      throw errors.invalidInput('idempotencyKey and commitSha are required');
    }

    const assignment = await this.repo.getAssignment(assignmentId);
    if (!assignment) throw errors.notFound('assignment');

    const link = await this.repo.getRepositoryLink(assignmentId, actor.userId);
    if (!link) throw errors.forbidden('You do not have a repository for this assignment');

    await this.permissions.assert(actor, 'assignment:submit', {
      type: 'assignment',
      id: assignmentId,
    });

    const existing = await this.repo.getSubmissionByIdempotencyKey(link.id, idempotencyKey);
    if (existing) return this.replay(input, existing);

    const now = this.now();
    if (now > assignment.deadline) throw errors.deadlineExpired();

    const currentStatus = await this.currentStatus(link.id);
    if (!canTransition(currentStatus, 'submitted')) {
      const winner = await this.repo.getSubmissionByIdempotencyKey(link.id, idempotencyKey);
      if (winner) return this.replay(input, winner);
      throw errors.invalidState(`Cannot submit from status "${currentStatus}"`);
    }
    if (currentStatus === 'revision_required' && assignment.resubmissionPolicy !== 'allowed') {
      throw errors.forbidden('Resubmission is not allowed for this assignment');
    }

    const attempt = await this.nextAttempt(link.id);
    const winner = await this.repo.getSubmissionByIdempotencyKey(link.id, idempotencyKey);
    if (winner) return this.replay(input, winner);

    const commitExists = await this.gitea.hasCommit({
      repoFullName: link.giteaRepoFullName,
      commitSha,
    });
    if (!commitExists) {
      await this.audit.append({
        actorId: actor.userId,
        eventType: 'integration.error',
        targetType: 'assignment',
        targetId: assignmentId,
        payload: { commitSha, reason: 'commit_not_found' },
      });
      throw errors.integration(`Commit ${commitSha} does not exist in the remote repository`);
    }

    // Reconcile a partially committed snapshot (crash between snapshot creation
    // and database insert) without duplicating the protected ref.
    const prior = await this.gitea.getExistingSubmission({
      repoFullName: link.giteaRepoFullName,
      attempt,
    });

    let protectedRef: string;
    let effectiveSha = commitSha;
    let alreadyExisted = false;
    if (prior) {
      if (prior.commitSha !== commitSha) {
        await this.audit.append({
          actorId: actor.userId,
          eventType: 'integration.error',
          targetType: 'assignment',
          targetId: assignmentId,
          payload: { commitSha, attempt, reason: 'snapshot_commit_mismatch' },
        });
        throw errors.integration('Existing protected snapshot does not match the requested commit');
      }
      protectedRef = prior.protectedRef;
      effectiveSha = prior.commitSha;
      alreadyExisted = true;
    } else {
      try {
        const snapshot = await this.gitea.createProtectedSnapshot({
          repoFullName: link.giteaRepoFullName,
          commitSha,
          attempt,
        });
        protectedRef = snapshot.protectedRef;
      } catch {
        // A concurrent creator may have won the protected-ref race.
        const concurrent = await this.gitea.getExistingSubmission({ repoFullName: link.giteaRepoFullName, attempt });
        if (concurrent?.commitSha === commitSha) {
          protectedRef = concurrent.protectedRef;
        } else {
          await this.audit.append({
            actorId: actor.userId,
            eventType: 'integration.error',
            targetType: 'assignment',
            targetId: assignmentId,
            payload: { commitSha, attempt, reason: 'snapshot_failed' },
          });
          throw errors.integration('Failed to create the protected submission snapshot');
        }
      }
    }

    try {
      await this.gitea.ensureReviewPullRequest({
        repoFullName: link.giteaRepoFullName,
        protectedRef,
        attempt,
      });
    } catch {
      await this.audit.append({
        actorId: actor.userId,
        eventType: 'integration.error',
        targetType: 'assignment',
        targetId: assignmentId,
        payload: { commitSha: effectiveSha, attempt, reason: 'review_pull_request_failed' },
      });
      throw errors.integration('Failed to open the review pull request');
    }

    let submission: SubmissionRecord;
    try {
      submission = await this.repo.insertSubmissionWithAudit({
        repositoryLinkId: link.id,
        attempt,
        commitSha: effectiveSha,
        protectedRef,
        status: 'submitted',
        submittedAt: now,
        idempotencyKey,
      }, {
        actorId: actor.userId,
        eventType: alreadyExisted ? 'submission.idempotent' : 'submission.created',
        targetType: 'submission',
        payload: { attempt, commitSha: effectiveSha, protectedRef },
      });
    } catch (error) {
      // A uniqueness loser must replay the durable winner, never invent success.
      const winner = await this.repo.getSubmissionByIdempotencyKey(link.id, idempotencyKey);
      if (winner) return this.replay(input, winner);
      throw error;
    }

    return { submission, alreadyExisted };
  }

  async requestRevision(input: RequestRevisionInput): Promise<ReviewResult> {
    const { actor, submissionId, feedback } = input;
    const inline = this.requireCompleteInline(input);
    const { submission, assignment, link } = await this.resolveReviewTarget(input);
    await this.permissions.assert(actor, 'assignment:review', {
      type: 'submission',
      id: submissionId,
    });

    if (!canTransition(submission.status, 'revision_required')) {
      throw errors.invalidState(`Cannot request revision from status "${submission.status}"`);
    }
    if (this.now() > assignment.deadline) {
      throw errors.deadlineExpired(); // revision_required is forbidden after the deadline
    }

    await this.repo.updateSubmissionStatus(submissionId, 'revision_required');
    await this.postReviewComment(link, submission, `Requested revision: ${feedback || 'Please fix and resubmit.'}`, inline);
    await this.audit.append({
      actorId: actor.userId,
      eventType: 'review.decision',
      targetType: 'submission',
      targetId: submissionId,
      payload: { decision: 'revision_required', feedback },
    });
    return { review: null, status: 'revision_required' };
  }

  async pass(input: ReviewInput): Promise<ReviewResult> {
    return this.decide(input, 'pass', 'passed');
  }

  async fail(input: ReviewInput): Promise<ReviewResult> {
    return this.decide(input, 'fail', 'failed');
  }

  private async decide(
    input: ReviewInput,
    decision: 'pass' | 'fail',
    targetStatus: 'passed' | 'failed',
  ): Promise<ReviewResult> {
    const { actor, submissionId, feedback } = input;
    const inline = this.requireCompleteInline(input);
    const { submission, link } = await this.resolveReviewTarget(input);
    await this.permissions.assert(actor, 'assignment:review', {
      type: 'submission',
      id: submissionId,
    });

    if (!canTransition(submission.status, targetStatus)) {
      throw errors.invalidState(`Cannot mark as ${targetStatus} from status "${submission.status}"`);
    }

    const grade = this.normalizeGrade(input.grade, decision);
    await this.repo.updateSubmissionStatus(submissionId, targetStatus);
    const review = await this.repo.insertReview({
      submissionId,
      reviewerId: actor.userId,
      decision,
      feedback,
      grade,
    });
    await this.postReviewComment(
      link,
      submission,
      `${decision === 'pass' ? 'Passed' : 'Failed'}: ${feedback || 'No additional feedback.'}${grade !== null ? ` Grade: ${grade}/5.` : ''}`,
      inline,
    );
    await this.audit.append({
      actorId: actor.userId,
      eventType: 'review.decision',
      targetType: 'submission',
      targetId: submissionId,
      payload: { decision, status: targetStatus, feedback, grade },
    });
    if (grade !== null) {
      await this.audit.append({
        actorId: actor.userId,
        eventType: 'review.graded',
        targetType: 'submission',
        targetId: submissionId,
        payload: { grade, decision },
      });
    }
    return { review, status: targetStatus };
  }

  /** Validates a numeric grade against the 1–5 scale; null when absent/disabled. */
  private normalizeGrade(grade: unknown, _decision: 'pass' | 'fail'): NumericGrade | null {
    if (grade === null || grade === undefined) return null;
    if (typeof grade !== 'number' || !Number.isInteger(grade) || grade < 1 || grade > 5) {
      throw errors.invalidInput('grade must be an integer between 1 and 5');
    }
    return grade as NumericGrade;
  }

  private async resolveReviewTarget(input: {
    assignmentId: AssignmentId;
    submissionId: SubmissionId;
  }): Promise<{ submission: SubmissionRecord; assignment: AssignmentView; link: RepositoryLinkRecord }> {
    const submission = await this.repo.getSubmission(input.submissionId);
    if (!submission) throw errors.notFound('submission');

    const link = await this.repo.getRepositoryLinkById(submission.repositoryLinkId);
    if (!link) throw errors.notFound('repository link');

    const assignment = await this.repo.getAssignment(link.groupAssignmentId);
    if (!assignment) throw errors.notFound('assignment');

    if (assignment.id !== input.assignmentId) {
      throw errors.invalidInput('submission does not belong to this assignment');
    }
    return { submission, assignment, link };
  }

  /**
   * Rejects a partially-supplied inlineComment (any of path/line/body missing)
   * before any state change, so a review is never recorded with a dangling
   * remark. Returns the complete comment, or undefined when none was provided.
   */
  private requireCompleteInline(
    input: { inlineComment?: InlineComment },
  ): InlineComment | undefined {
    const { inlineComment } = input;
    if (inlineComment === undefined) return undefined;
    if (typeof inlineComment.path !== 'string' || !inlineComment.path.trim()
      || typeof inlineComment.line !== 'number' || !Number.isInteger(inlineComment.line)
      || typeof inlineComment.body !== 'string' || !inlineComment.body.trim()) {
      throw errors.invalidInput('inlineComment requires path, line, and body together');
    }
    return inlineComment;
  }

  /**
   * Posts the review decision as a general comment on the submission's PR, and
   * — when the teacher attached an inline remark — a second line comment at the
   * requested path/line carrying the remark's body. Both are fail-soft: a
   * remote posting failure is audited and swallowed, never failing the review
   * decision itself. The inline call is a separate `addComment` so a failing
   * remark can never retroactively un-post the delivered general comment.
   */
  private async postReviewComment(
    link: RepositoryLinkRecord,
    submission: SubmissionRecord,
    body: string,
    inline?: InlineComment,
  ): Promise<void> {
    const post = async (comment: { body: string; inline?: { path: string; line: number } }): Promise<void> => {
      try {
        const pr = await this.gitea.ensureReviewPullRequest({
          repoFullName: link.giteaRepoFullName,
          protectedRef: submission.protectedRef,
          attempt: submission.attempt,
        });
        await this.gitea.addComment({
          repoFullName: link.giteaRepoFullName,
          pullRequestNumber: pr.number,
          body: comment.body,
          inline: comment.inline,
        });
      } catch {
        await this.audit.append({
          actorId: null,
          eventType: 'integration.error',
          targetType: 'submission',
          targetId: submission.id,
          payload: {
            reason: 'review_comment_failed',
            ...(comment.inline ? { inlinePath: comment.inline.path, inlineLine: comment.inline.line } : {}),
          },
        });
      }
    };

    await post({ body });
    if (inline) {
      await post({ body: inline.body, inline: { path: inline.path, line: inline.line } });
    }
  }

  private async currentStatus(linkId: RepositoryLinkId): Promise<AssignmentStatus> {
    const submissions = await this.repo.listSubmissions(linkId);
    const latest = submissions.reduce<SubmissionRecord | null>(
      (max, s) => (max === null || s.attempt > max.attempt ? s : max),
      null,
    );
    return latest?.status ?? 'in_progress';
  }

  private async nextAttempt(linkId: RepositoryLinkId): Promise<number> {
    const submissions = await this.repo.listSubmissions(linkId);
    const max = submissions.reduce((m, s) => Math.max(m, s.attempt), 0);
    return max + 1;
  }
}
