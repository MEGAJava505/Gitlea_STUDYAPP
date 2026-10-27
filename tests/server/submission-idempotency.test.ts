import { describe, expect, it } from 'vitest';
import { makeAssignmentWorld, principal } from '../domain/fakes';

const input = (w: ReturnType<typeof makeAssignmentWorld>, key: string, sha: string) => ({
  actor: principal(w.student, ['student']), assignmentId: w.assignment.id,
  commitSha: sha, idempotencyKey: key,
});

describe('submission idempotency public service contract', () => {
  it('replays the exact key and SHA across a deadline boundary', async () => {
    const w = makeAssignmentWorld({ nowMs: 500, deadline: 1_000 });
    const first = await w.machine.submit(input(w, 'semantic-key', 'abc123'));
    w.setNow(1_001);
    const replay = await w.machine.submit(input(w, 'semantic-key', 'abc123'));
    expect(replay).toMatchObject({ alreadyExisted: true, submission: { id: first.submission.id } });
    expect(w.gitea.snapshots).toHaveLength(1);
  });

  it('rejects same key with a different SHA as a stable conflict', async () => {
    const w = makeAssignmentWorld({ nowMs: 500 });
    await w.machine.submit(input(w, 'semantic-key', 'abc123'));
    await expect(w.machine.submit(input(w, 'semantic-key', 'def456')))
      .rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
    expect(w.gitea.snapshots).toHaveLength(1);
  });

  it('denies a new key after deadline despite an earlier same-SHA submission', async () => {
    const w = makeAssignmentWorld({ nowMs: 500, deadline: 1_000 });
    await w.machine.submit(input(w, 'first-key', 'abc123'));
    w.setNow(1_001);
    await expect(w.machine.submit(input(w, 'late-key', 'abc123')))
      .rejects.toMatchObject({ code: 'DEADLINE_EXPIRED' });
  });

  it('allows a different key and same SHA for a permitted revision without bypassing transition', async () => {
    const w = makeAssignmentWorld({ nowMs: 500, resubmissionPolicy: 'allowed' });
    const first = await w.machine.submit(input(w, 'first-key', 'abc123'));
    await w.machine.requestRevision({ actor: principal(w.teacher, ['teacher']), assignmentId: w.assignment.id, submissionId: first.submission.id, feedback: 'revise' });
    const next = await w.machine.submit(input(w, 'revision-key', 'abc123'));
    expect(next.alreadyExisted).toBe(false);
    expect(next.submission.attempt).toBe(2);
  });

  it('converges concurrent identical submissions to one attempt', async () => {
    const w = makeAssignmentWorld({ nowMs: 500 });
    const results = await Promise.all([w.machine.submit(input(w, 'semantic-key', 'abc123')), w.machine.submit(input(w, 'semantic-key', 'abc123'))]);
    expect(new Set(results.map(r => r.submission.id)).size).toBe(1);
    expect(await w.repo.listSubmissions(w.link.id)).toHaveLength(1);
  });

  it('reconciles an orphan snapshot after a failed review integration call', async () => {
    const w = makeAssignmentWorld({ nowMs: 500 });
    w.gitea.failPullRequest = true;
    await expect(w.machine.submit(input(w, 'semantic-key', 'abc123'))).rejects.toMatchObject({ code: 'INTEGRATION_ERROR' });
    w.gitea.failPullRequest = false;
    const retry = await w.machine.submit(input(w, 'semantic-key', 'abc123'));
    expect(retry.submission.attempt).toBe(1);
    expect(w.gitea.snapshots).toHaveLength(1);
  });
});
