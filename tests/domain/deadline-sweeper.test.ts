import { describe, expect, it } from 'vitest';
import {
  DeadlineSweeper,
  type OverdueLink,
  type DeadlineSweeperRepository,
} from '../../src/domain/assignments/deadline-sweeper';
import { InMemoryAuditRepository, makeAuditWriter } from './fakes';
import type {
  AssignmentId,
  GroupId,
  RepositoryLinkId,
  UserId,
} from '../../src/shared/contracts';

const aid = (s: string) => s as AssignmentId;
const gid = (s: string) => s as GroupId;
const lid = (s: string) => s as RepositoryLinkId;
const uid = (s: string) => s as UserId;

function link(over: Partial<OverdueLink> = {}): OverdueLink {
  return {
    linkId: lid('link-1'),
    studentId: uid('u-student'),
    assignmentId: aid('a1'),
    groupId: gid('g1'),
    deadline: 1_000,
    ...over,
  };
}

class FakeSweeperRepo implements DeadlineSweeperRepository {
  noSubmission: OverdueLink[] = [];
  revisionRequired: OverdueLink[] = [];
  failed: RepositoryLinkId[] = [];
  seenNow: number[] = [];
  eligible = true;

  async findOverdueWithoutSubmission(now: number): Promise<OverdueLink[]> {
    this.seenNow.push(now);
    return this.noSubmission;
  }
  async findOverdueRevisionRequired(now: number): Promise<OverdueLink[]> {
    this.seenNow.push(now);
    return this.revisionRequired;
  }
  async markLinkFailed(linkId: RepositoryLinkId): Promise<boolean> {
    if (!this.eligible) return false;
    this.failed.push(linkId);
    return true;
  }
}

function makeWorld(nowMs: number) {
  const repo = new FakeSweeperRepo();
  const auditRepo = new InMemoryAuditRepository();
  const audit = makeAuditWriter(auditRepo, () => nowMs);
  const sweeper = new DeadlineSweeper({ repo, audit, now: () => nowMs });
  return { repo, auditRepo, sweeper };
}

describe('deadline sweeper', () => {
  it('fails a link that has no submission at all', async () => {
    const { repo, auditRepo, sweeper } = makeWorld(2_000);
    repo.noSubmission = [link()];

    const result = await sweeper.sweep();

    expect(result.failedNoSubmission).toBe(1);
    expect(result.failedUnresolvedRevision).toBe(0);
    expect(repo.failed).toEqual([lid('link-1')]);
    const evt = auditRepo.events.find((e) => e.eventType === 'submission.auto_failed');
    expect(evt).toBeTruthy();
    expect(evt!.targetId).toBe('link-1');
    expect(evt!.payload.reason).toBe('no_submission');
  });

  it('fails a link whose revision_required was never resubmitted in time', async () => {
    const { repo, auditRepo, sweeper } = makeWorld(2_000);
    repo.revisionRequired = [link({ linkId: lid('link-2') })];

    const result = await sweeper.sweep();

    expect(result.failedUnresolvedRevision).toBe(1);
    expect(result.failedNoSubmission).toBe(0);
    expect(repo.failed).toEqual([lid('link-2')]);
    const evt = auditRepo.events.find((e) => e.eventType === 'submission.auto_failed');
    expect(evt!.payload.reason).toBe('unresolved_revision');
  });

  it('does not count or audit stale candidates skipped at the write boundary', async () => {
    const { repo, auditRepo, sweeper } = makeWorld(2_000);
    repo.noSubmission = [link()];
    repo.revisionRequired = [link({ linkId: lid('link-2') })];
    repo.eligible = false;
    expect(await sweeper.sweep()).toEqual({ failedNoSubmission: 0, failedUnresolvedRevision: 0 });
    expect(auditRepo.events).toHaveLength(0);
    expect(repo.failed).toHaveLength(0);
  });

  it('is a no-op when nothing is overdue', async () => {
    const { repo, auditRepo, sweeper } = makeWorld(2_000);
    const result = await sweeper.sweep();
    expect(result).toEqual({ failedNoSubmission: 0, failedUnresolvedRevision: 0 });
    expect(repo.failed).toHaveLength(0);
    expect(auditRepo.events).toHaveLength(0);
  });

  it('sweeps both categories in one run and audits each link', async () => {
    const { repo, auditRepo, sweeper } = makeWorld(5_000);
    repo.noSubmission = [link({ linkId: lid('l1') }), link({ linkId: lid('l2') })];
    repo.revisionRequired = [link({ linkId: lid('l3') })];

    const result = await sweeper.sweep();

    expect(result.failedNoSubmission).toBe(2);
    expect(result.failedUnresolvedRevision).toBe(1);
    expect(repo.failed).toEqual([lid('l1'), lid('l2'), lid('l3')]);
    const autoFailed = auditRepo.events.filter((e) => e.eventType === 'submission.auto_failed');
    expect(autoFailed).toHaveLength(3);
    // The audit actor is the system (null), not a person.
    expect(autoFailed.every((e) => e.actorId === null)).toBe(true);
  });

  it('passes the current server time to the repository queries', async () => {
    const { repo, sweeper } = makeWorld(9_999);
    await sweeper.sweep();
    expect(repo.seenNow).toEqual([9_999, 9_999]);
  });
});
