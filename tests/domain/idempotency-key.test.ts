import { describe, expect, it } from 'vitest';
import { makeAssignmentWorld, principal } from './fakes';

const COMMIT_A = 'abc123';
const COMMIT_B = 'def456';
const KEY_1 = 'client-key-1';
const KEY_2 = 'client-key-2';

describe('idempotency key persistence', () => {
  it('same key + same SHA returns existing submission (idempotent replay)', async () => {
    const w = makeAssignmentWorld({ nowMs: 500 });
    const actor = principal(w.student, ['student']);

    const first = await w.machine.submit({
      actor,
      assignmentId: w.assignment.id,
      commitSha: COMMIT_A,
      idempotencyKey: KEY_1,
    });

    const retry = await w.machine.submit({
      actor,
      assignmentId: w.assignment.id,
      commitSha: COMMIT_A,
      idempotencyKey: KEY_1,
    });

    expect(retry.alreadyExisted).toBe(true);
    expect(retry.submission.id).toBe(first.submission.id);
    expect(w.gitea.snapshots).toHaveLength(1);
    expect(w.auditRepo.events.filter((e) => e.eventType === 'submission.idempotent')).toHaveLength(1);
  });

  it('same key + different SHA produces stable 409 conflict', async () => {
    const w = makeAssignmentWorld({ nowMs: 500 });
    const actor = principal(w.student, ['student']);
    w.gitea.commits.add(COMMIT_B);

    await w.machine.submit({
      actor,
      assignmentId: w.assignment.id,
      commitSha: COMMIT_A,
      idempotencyKey: KEY_1,
    });

    await expect(
      w.machine.submit({
        actor,
        assignmentId: w.assignment.id,
        commitSha: COMMIT_B,
        idempotencyKey: KEY_1,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });

    expect(await w.repo.listSubmissions(w.link.id)).toHaveLength(1);
    expect(w.gitea.snapshots).toHaveLength(1);
    expect(w.auditRepo.events.some((e) => e.eventType === 'submission.conflict')).toBe(true);
  });

  it('different key + same SHA creates second submission (new attempt)', async () => {
    const w = makeAssignmentWorld({ nowMs: 500 });
    const actor = principal(w.student, ['student']);

    const first = await w.machine.submit({
      actor,
      assignmentId: w.assignment.id,
      commitSha: COMMIT_A,
      idempotencyKey: KEY_1,
    });

    await w.machine.requestRevision({
      actor: principal(w.teacher, ['teacher']),
      assignmentId: w.assignment.id,
      submissionId: first.submission.id,
      feedback: 'revise',
    });

    const second = await w.machine.submit({
      actor,
      assignmentId: w.assignment.id,
      commitSha: COMMIT_A,
      idempotencyKey: KEY_2,
    });

    expect(second.alreadyExisted).toBe(false);
    expect(second.submission.attempt).toBe(2);
    expect(second.submission.commitSha).toBe(COMMIT_A);
    expect(await w.repo.listSubmissions(w.link.id)).toHaveLength(2);
  });

  it('key first used after deadline is rejected even if commit exists', async () => {
    const w = makeAssignmentWorld({ nowMs: 500, deadline: 10_000 });
    const actor = principal(w.student, ['student']);

    w.setNow(10_001);
    await expect(
      w.machine.submit({
        actor,
        assignmentId: w.assignment.id,
        commitSha: COMMIT_A,
        idempotencyKey: KEY_1,
      }),
    ).rejects.toMatchObject({ code: 'DEADLINE_EXPIRED' });
  });

  it('key first used before deadline remains retrievable after deadline', async () => {
    const w = makeAssignmentWorld({ nowMs: 500, deadline: 10_000 });
    const actor = principal(w.student, ['student']);

    const first = await w.machine.submit({
      actor,
      assignmentId: w.assignment.id,
      commitSha: COMMIT_A,
      idempotencyKey: KEY_1,
    });

    w.setNow(10_001);
    const retry = await w.machine.submit({
      actor,
      assignmentId: w.assignment.id,
      commitSha: COMMIT_A,
      idempotencyKey: KEY_1,
    });

    expect(retry.alreadyExisted).toBe(true);
    expect(retry.submission.id).toBe(first.submission.id);
  });

  it('concurrent identical requests (same key+SHA) produce exactly one submission', async () => {
    const w = makeAssignmentWorld({ nowMs: 500 });
    const actor = principal(w.student, ['student']);

    const [r1, r2] = await Promise.all([
      w.machine.submit({
        actor,
        assignmentId: w.assignment.id,
        commitSha: COMMIT_A,
        idempotencyKey: KEY_1,
      }),
      w.machine.submit({
        actor,
        assignmentId: w.assignment.id,
        commitSha: COMMIT_A,
        idempotencyKey: KEY_1,
      }),
    ]);

    expect(r1.submission.id).toBe(r2.submission.id);
    expect(await w.repo.listSubmissions(w.link.id)).toHaveLength(1);
    expect(w.gitea.snapshots).toHaveLength(1);
  });
  it('a new key after deadline cannot replay an old SHA', async () => {
    const w = makeAssignmentWorld({ nowMs: 500 });
    const input = { actor: principal(w.student, ['student']), assignmentId: w.assignment.id, commitSha: COMMIT_A, idempotencyKey: KEY_1 };
    await w.machine.submit(input);
    w.setNow(10_001);
    await expect(w.machine.submit({ ...input, idempotencyKey: KEY_2 })).rejects.toMatchObject({ code: 'DEADLINE_EXPIRED' });
    await expect(w.machine.submit({ ...input, commitSha: COMMIT_B })).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
    expect(w.gitea.snapshots).toHaveLength(1);
  });

  it.each(['submitted', 'passed', 'failed'] as const)('new keys cannot bypass %s with an old SHA', async (status) => {
    const w = makeAssignmentWorld();
    const input = { actor: principal(w.student, ['student']), assignmentId: w.assignment.id, commitSha: COMMIT_A, idempotencyKey: KEY_1 };
    const first = await w.machine.submit(input);
    await w.repo.updateSubmissionStatus(first.submission.id, status);
    await expect(w.machine.submit({ ...input, idempotencyKey: KEY_2 })).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(await w.repo.listSubmissions(w.link.id)).toHaveLength(1);
    expect(w.gitea.snapshots).toHaveLength(1);
  });

  it('new key with old SHA respects forbidden revision policy', async () => {
    const w = makeAssignmentWorld({ resubmissionPolicy: 'forbidden' });
    const input = { actor: principal(w.student, ['student']), assignmentId: w.assignment.id, commitSha: COMMIT_A, idempotencyKey: KEY_1 };
    const first = await w.machine.submit(input);
    await w.repo.updateSubmissionStatus(first.submission.id, 'revision_required');
    await expect(w.machine.submit({ ...input, idempotencyKey: KEY_2 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await w.repo.listSubmissions(w.link.id)).toHaveLength(1);
  });

});
