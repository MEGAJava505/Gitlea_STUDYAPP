import { describe, expect, it, vi } from 'vitest';
import { canTransition } from '../../src/domain/assignments/state-machine';
import { errors } from '../../src/shared/contracts';
import { makeAssignmentWorld, principal } from './fakes';

const COMMIT = 'abc123';
const KEY = 'key-1';

describe('state machine — transition table', () => {
  it('encodes exactly the legal transitions', () => {
    expect(canTransition('in_progress', 'submitted')).toBe(true);
    expect(canTransition('submitted', 'revision_required')).toBe(true);
    expect(canTransition('submitted', 'passed')).toBe(true);
    expect(canTransition('submitted', 'failed')).toBe(true);
    expect(canTransition('revision_required', 'submitted')).toBe(true);
    expect(canTransition('revision_required', 'failed')).toBe(true);

    expect(canTransition('in_progress', 'passed')).toBe(false);
    expect(canTransition('in_progress', 'failed')).toBe(false);
    expect(canTransition('in_progress', 'revision_required')).toBe(false);
    expect(canTransition('submitted', 'in_progress')).toBe(false);
    expect(canTransition('revision_required', 'passed')).toBe(false);
    expect(canTransition('revision_required', 'revision_required')).toBe(false);
    expect(canTransition('passed', 'submitted')).toBe(false);
    expect(canTransition('failed', 'passed')).toBe(false);
    expect(canTransition('passed', 'revision_required')).toBe(false);
  });
});

describe('submit', () => {
  it('does not persist on audit failure; concurrent same-key retries converge with one success audit', async () => {
    const w = makeAssignmentWorld({ nowMs: 500 });
    const input = { actor: principal(w.student, ['student']), assignmentId: w.assignment.id,
      commitSha: COMMIT, idempotencyKey: KEY };
    vi.spyOn(w.auditRepo, 'append').mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(w.machine.submit(input)).rejects.toThrow('audit unavailable');
    await expect(w.repo.getSubmissionByIdempotencyKey(w.link.id, KEY)).resolves.toBeNull();
    expect(w.auditRepo.events).toHaveLength(0);
    const results = await Promise.all([w.machine.submit(input), w.machine.submit(input)]);
    expect(results[0]!.submission.id).toBe(results[1]!.submission.id);
    await expect(w.repo.listSubmissions(w.link.id)).resolves.toHaveLength(1);
    expect(w.auditRepo.events.filter((e) => e.payload.protectedRef === 'submission/1')).toHaveLength(1);
    expect(w.gitea.snapshots).toHaveLength(1);
    expect(w.gitea.pullRequests).toHaveLength(1);
  });

  it('moves in_progress -> submitted, creates one snapshot, records attempt 1', async () => {
    const w = makeAssignmentWorld({ nowMs: 500 });
    const actor = principal(w.student, ['student']);

    const result = await w.machine.submit({
      actor,
      assignmentId: w.assignment.id,
      commitSha: COMMIT,
      idempotencyKey: KEY,
    });

    expect(result.alreadyExisted).toBe(false);
    expect(result.submission.status).toBe('submitted');
    expect(result.submission.attempt).toBe(1);
    expect(result.submission.commitSha).toBe(COMMIT);
    expect(result.submission.protectedRef).toBe('submission/1');
    expect(result.submission.submittedAt).toBe(500);
    expect(w.gitea.snapshots).toHaveLength(1);
    expect(w.gitea.pullRequests).toEqual([{ repoFullName: w.link.giteaRepoFullName, protectedRef: 'submission/1', number: 1 }]);
    expect(w.auditRepo.events.some((e) => e.eventType === 'submission.created')).toBe(true);
  });

  it('does not report success when the review pull request cannot be opened', async () => {
    const w = makeAssignmentWorld({ nowMs: 500 });
    w.gitea.failPullRequest = true;

    await expect(
      w.machine.submit({ actor: principal(w.student, ['student']), assignmentId: w.assignment.id, commitSha: COMMIT, idempotencyKey: KEY }),
    ).rejects.toMatchObject({ code: 'INTEGRATION_ERROR' });
    await expect(w.repo.listSubmissions(w.link.id)).resolves.toHaveLength(0);
    expect(w.auditRepo.events.some((e) => e.payload.reason === 'review_pull_request_failed')).toBe(true);

    // Reconciliation: the retry reuses the protected snapshot and opens the PR once.
    w.gitea.failPullRequest = false;
    const retry = await w.machine.submit({ actor: principal(w.student, ['student']), assignmentId: w.assignment.id, commitSha: COMMIT, idempotencyKey: KEY });
    expect(retry.submission.attempt).toBe(1);
    expect(w.gitea.snapshots).toHaveLength(1);
    expect(w.gitea.pullRequests).toHaveLength(1);
  });

  it('fails closed when an orphan protected snapshot belongs to a different commit', async () => {
    const w = makeAssignmentWorld({ nowMs: 500 });
    await w.gitea.createProtectedSnapshot({
      repoFullName: w.link.giteaRepoFullName, attempt: 1, commitSha: COMMIT,
    });
    w.gitea.commits.add('def456');

    await expect(w.machine.submit({
      actor: principal(w.student, ['student']), assignmentId: w.assignment.id,
      commitSha: 'def456', idempotencyKey: KEY,
    })).rejects.toMatchObject({ code: 'INTEGRATION_ERROR' });
    await expect(w.repo.listSubmissions(w.link.id)).resolves.toHaveLength(0);
    expect(w.gitea.snapshots).toHaveLength(1);
    expect(w.gitea.snapshots[0].commitSha).toBe(COMMIT);
    expect(w.gitea.pullRequests).toHaveLength(0);
    expect(w.auditRepo.events.some((e) => e.payload.reason === 'snapshot_commit_mismatch')).toBe(true);
  });

  it('rejects a commit that does not exist remotely', async () => {
    const w = makeAssignmentWorld({ nowMs: 500 });
    const actor = principal(w.student, ['student']);

    await expect(
      w.machine.submit({
        actor,
        assignmentId: w.assignment.id,
        commitSha: 'missing-sha',
        idempotencyKey: KEY,
      }),
    ).rejects.toMatchObject({ code: 'INTEGRATION_ERROR' });

    expect(w.gitea.snapshots).toHaveLength(0);
    expect(w.auditRepo.events.some((e) => e.eventType === 'integration.error')).toBe(true);
    expect(w.repo.listSubmissions(w.link.id)).resolves;
  });

  it('is idempotent: repeated submit with the same commit returns the existing attempt', async () => {
    const w = makeAssignmentWorld({ nowMs: 500 });
    const actor = principal(w.student, ['student']);
    const input = {
      actor,
      assignmentId: w.assignment.id,
      commitSha: COMMIT,
      idempotencyKey: KEY,
    };

    const first = await w.machine.submit(input);
    const retry = await w.machine.submit(input);

    expect(first.alreadyExisted).toBe(false);
    expect(retry.alreadyExisted).toBe(true);
    expect(retry.submission.id).toBe(first.submission.id);
    expect(retry.submission.attempt).toBe(1);
    expect(w.gitea.snapshots).toHaveLength(1); // exactly one protected snapshot
  });

  it('a retry after the deadline still returns the already-created attempt', async () => {
    const w = makeAssignmentWorld({ nowMs: 500, deadline: 10_000 });
    const actor = principal(w.student, ['student']);

    const first = await w.machine.submit({
      actor,
      assignmentId: w.assignment.id,
      commitSha: COMMIT,
      idempotencyKey: KEY,
    });

    w.setNow(10_001); // after deadline
    const retry = await w.machine.submit({
      actor,
      assignmentId: w.assignment.id,
      commitSha: COMMIT,
      idempotencyKey: KEY,
    });

    expect(retry.alreadyExisted).toBe(true);
    expect(retry.submission.id).toBe(first.submission.id);
    expect(retry.submission.attempt).toBe(1);
  });

  it('enforces the deadline boundary (server time, deadline-ms is still open)', async () => {
    const w = makeAssignmentWorld({ nowMs: 500, deadline: 10_000 });
    const actor = principal(w.student, ['student']);

    w.setNow(10_000); // deadline moment is allowed
    const atDeadline = await w.machine.submit({
      actor,
      assignmentId: w.assignment.id,
      commitSha: COMMIT,
      idempotencyKey: 'key-at-deadline',
    });
    expect(atDeadline.submission.status).toBe('submitted');

    // Second attempt (new commit) after the deadline is rejected.
    w.gitea.commits.add('late-sha');
    w.setNow(10_001);
    await expect(
      w.machine.submit({
        actor,
        assignmentId: w.assignment.id,
        commitSha: 'late-sha',
        idempotencyKey: 'key-late',
      }),
    ).rejects.toMatchObject({ code: 'DEADLINE_EXPIRED' });
  });

  it('rejects a first submit from the terminal state (already failed)', async () => {
    const w = makeAssignmentWorld({ nowMs: 500 });
    const actor = principal(w.student, ['student']);

    await w.machine.submit({
      actor,
      assignmentId: w.assignment.id,
      commitSha: COMMIT,
      idempotencyKey: 'key-1',
    });
    const sub = w.auditRepo.events.find((e) => e.eventType === 'submission.created')!;
    await w.repo.updateSubmissionStatus(sub.targetId, 'failed');

    w.gitea.commits.add('second-sha');
    await expect(
      w.machine.submit({
        actor,
        assignmentId: w.assignment.id,
        commitSha: 'second-sha',
        idempotencyKey: 'key-2',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });
});

describe('resubmission', () => {
  it('numbering never increments for a duplicate attempt; the next attempt is positive and sequential', async () => {
    const w = makeAssignmentWorld({ nowMs: 500 });
    const actor = principal(w.student, ['student']);
    const first = await w.machine.submit({
      actor,
      assignmentId: w.assignment.id,
      commitSha: COMMIT,
      idempotencyKey: 'key-1',
    });
    expect(first.submission.attempt).toBe(1);

    await w.machine.requestRevision({
      actor: principal(w.teacher, ['teacher']),
      assignmentId: w.assignment.id,
      submissionId: first.submission.id,
      feedback: 'fix it',
    });

    w.gitea.commits.add('v2-sha');
    const second = await w.machine.submit({
      actor,
      assignmentId: w.assignment.id,
      commitSha: 'v2-sha',
      idempotencyKey: 'key-2',
    });
    expect(second.submission.attempt).toBe(2);
    expect(second.submission.protectedRef).toBe('submission/2');
    expect(second.alreadyExisted).toBe(false);
  });

  it('forbids resubmission when the policy is forbidden', async () => {
    const w = makeAssignmentWorld({
      nowMs: 500,
      resubmissionPolicy: 'forbidden',
    });
    const actor = principal(w.student, ['student']);
    const first = await w.machine.submit({
      actor,
      assignmentId: w.assignment.id,
      commitSha: COMMIT,
      idempotencyKey: 'key-1',
    });

    await w.machine.requestRevision({
      actor: principal(w.teacher, ['teacher']),
      assignmentId: w.assignment.id,
      submissionId: first.submission.id,
      feedback: 'rewrite',
    });

    w.gitea.commits.add('v2-sha');
    await expect(
      w.machine.submit({
        actor,
        assignmentId: w.assignment.id,
        commitSha: 'v2-sha',
        idempotencyKey: 'key-2',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('review transitions', () => {
  it('submitted -> revision_required before the deadline', async () => {
    const w = makeAssignmentWorld({ nowMs: 500 });
    const student = principal(w.student, ['student']);
    const teacher = principal(w.teacher, ['teacher']);
    const sub = await w.machine.submit({
      actor: student,
      assignmentId: w.assignment.id,
      commitSha: COMMIT,
      idempotencyKey: 'key-1',
    });

    const result = await w.machine.requestRevision({
      actor: teacher,
      assignmentId: w.assignment.id,
      submissionId: sub.submission.id,
      feedback: 'needs work',
    });

    expect(result.status).toBe('revision_required');
    expect(w.auditRepo.events.some((e) => e.eventType === 'review.decision')).toBe(true);
  });

  it('forbids revision_required after the deadline', async () => {
    const w = makeAssignmentWorld({ nowMs: 500 });
    const student = principal(w.student, ['student']);
    const teacher = principal(w.teacher, ['teacher']);
    const sub = await w.machine.submit({
      actor: student,
      assignmentId: w.assignment.id,
      commitSha: COMMIT,
      idempotencyKey: 'key-1',
    });

    w.setNow(10_001);
    await expect(
      w.machine.requestRevision({
        actor: teacher,
        assignmentId: w.assignment.id,
        submissionId: sub.submission.id,
        feedback: 'too late',
      }),
    ).rejects.toMatchObject({ code: 'DEADLINE_EXPIRED' });
  });

  it('a timely submitted work after the deadline can still become passed', async () => {
    const w = makeAssignmentWorld({ nowMs: 500 });
    const student = principal(w.student, ['student']);
    const teacher = principal(w.teacher, ['teacher']);
    const sub = await w.machine.submit({
      actor: student,
      assignmentId: w.assignment.id,
      commitSha: COMMIT,
      idempotencyKey: 'key-1',
    });

    w.setNow(10_001); // after deadline
    const result = await w.machine.pass({
      actor: teacher,
      assignmentId: w.assignment.id,
      submissionId: sub.submission.id,
      decision: 'pass',
      feedback: 'good work',
    });

    expect(result.status).toBe('passed');
    expect(result.review).not.toBeNull();
    expect(result.review!.reviewerId).toBe(w.teacher);
    expect(result.review!.decision).toBe('pass');
  });

  it('submitted -> failed after the deadline', async () => {
    const w = makeAssignmentWorld({ nowMs: 500 });
    const student = principal(w.student, ['student']);
    const teacher = principal(w.teacher, ['teacher']);
    const sub = await w.machine.submit({
      actor: student,
      assignmentId: w.assignment.id,
      commitSha: COMMIT,
      idempotencyKey: 'key-1',
    });

    w.setNow(10_001);
    const result = await w.machine.fail({
      actor: teacher,
      assignmentId: w.assignment.id,
      submissionId: sub.submission.id,
      decision: 'fail',
      feedback: 'insufficient',
    });
    expect(result.status).toBe('failed');
  });

  it('revision_required -> failed is allowed; terminal states reject every transition', async () => {
    const w = makeAssignmentWorld({ nowMs: 500 });
    const student = principal(w.student, ['student']);
    const teacher = principal(w.teacher, ['teacher']);
    const sub = await w.machine.submit({
      actor: student,
      assignmentId: w.assignment.id,
      commitSha: COMMIT,
      idempotencyKey: 'key-1',
    });
    await w.machine.requestRevision({
      actor: teacher,
      assignmentId: w.assignment.id,
      submissionId: sub.submission.id,
      feedback: 'revise',
    });

    // revision_required -> passed is illegal
    await expect(
      w.machine.pass({
        actor: teacher,
        assignmentId: w.assignment.id,
        submissionId: sub.submission.id,
        decision: 'pass',
        feedback: 'x',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });

    const failed = await w.machine.fail({
      actor: teacher,
      assignmentId: w.assignment.id,
      submissionId: sub.submission.id,
      decision: 'fail',
      feedback: 'gave up',
    });
    expect(failed.status).toBe('failed');

    // terminal: nothing else is possible
    await expect(
      w.machine.pass({
        actor: teacher,
        assignmentId: w.assignment.id,
        submissionId: sub.submission.id,
        decision: 'pass',
        feedback: 'x',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(
      w.machine.requestRevision({
        actor: teacher,
        assignmentId: w.assignment.id,
        submissionId: sub.submission.id,
        feedback: 'x',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('denies self-review end-to-end: Admin+Owner student cannot pass their own submission', async () => {
    const w = makeAssignmentWorld({ nowMs: 500 });
    const selfAdmin = principal(w.student, ['student', 'admin', 'owner']);
    const sub = await w.machine.submit({
      actor: principal(w.student, ['student']),
      assignmentId: w.assignment.id,
      commitSha: COMMIT,
      idempotencyKey: 'key-1',
    });

    await expect(
      w.machine.pass({
        actor: selfAdmin,
        assignmentId: w.assignment.id,
        submissionId: sub.submission.id,
        decision: 'pass',
        feedback: 'my own work',
      }),
    ).rejects.toThrow(/own submission/);

    expect(w.auditRepo.events.some((e) => e.eventType === 'review.denied')).toBe(true);
  });

  it('a teacher without responsibility for the assignment cannot review', async () => {
    const w = makeAssignmentWorld({ nowMs: 500 });
    const sub = await w.machine.submit({
      actor: principal(w.student, ['student']),
      assignmentId: w.assignment.id,
      commitSha: COMMIT,
      idempotencyKey: 'key-1',
    });

    const stranger = principal('u-stranger' as never, ['teacher']);
    await expect(
      w.machine.pass({
        actor: stranger,
        assignmentId: w.assignment.id,
        submissionId: sub.submission.id,
        decision: 'pass',
        feedback: 'not mine',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
