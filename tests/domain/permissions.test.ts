import { describe, expect, it } from 'vitest';
import { PermissionCheckerImpl } from '../../src/domain/permissions';
import { errors } from '../../src/shared/contracts';
import {
  InMemoryAssignmentRepository,
  InMemoryAuditRepository,
  makeAuditWriter,
  makeAssignment,
  makeLink,
  principal,
  aid,
  gid,
  lid,
  uid,
} from './fakes';

async function setup() {
  const repo = new InMemoryAssignmentRepository(() => 1);
  repo.seedAssignment(
    makeAssignment({ id: aid('a1'), teacherId: uid('u-teacher'), groupId: gid('g1') }),
  );
  repo.seedLink(
    makeLink({ id: lid('link1'), groupAssignmentId: aid('a1'), studentId: uid('u-student') }),
  );
  const submission = await repo.insertSubmission({
    repositoryLinkId: lid('link1'),
    attempt: 1,
    commitSha: 'abc123',
    protectedRef: 'submission/1',
    status: 'submitted',
    submittedAt: 1,
  });

  const auditRepo = new InMemoryAuditRepository();
  const audit = makeAuditWriter(auditRepo, () => 1);
  const checker = new PermissionCheckerImpl({ resolver: repo, audit });

  return { checker, auditRepo, submissionId: submission.id };
}

describe('PermissionChecker', () => {
  it('limits submit to the student that owns the repository link', async () => {
    const { checker } = await setup();
    const owner = principal(uid('u-student'), ['student']);
    const other = principal(uid('u-other'), ['student']);

    await expect(
      checker.assert(owner, 'assignment:submit', { type: 'assignment', id: aid('a1') }),
    ).resolves.toBeUndefined();

    await expect(
      checker.assert(other, 'assignment:submit', { type: 'assignment', id: aid('a1') }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('requires assignment membership for a teacher to review', async () => {
    const { checker, submissionId } = await setup();
    const assigned = principal(uid('u-teacher'), ['teacher']);
    const stranger = principal(uid('u-stranger'), ['teacher']);

    await expect(
      checker.assert(assigned, 'assignment:review', { type: 'submission', id: submissionId }),
    ).resolves.toBeUndefined();

    await expect(
      checker.assert(stranger, 'assignment:review', { type: 'submission', id: submissionId }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('checks the role on every permission', async () => {
    const { checker, submissionId } = await setup();
    const student = principal(uid('u-student'), ['student']);
    const teacher = principal(uid('u-teacher'), ['teacher']);
    const admin = principal(uid('u-admin'), ['admin']);
    const owner = principal(uid('u-owner'), ['owner']);

    expect(await checker.can(student, 'identity:grant_role')).toBe(false);
    expect(await checker.can(teacher, 'identity:grant_role')).toBe(false);
    expect(await checker.can(admin, 'identity:grant_role')).toBe(true);
    expect(await checker.can(owner, 'audit:read')).toBe(true);
    expect(await checker.can(teacher, 'audit:read')).toBe(false);

    // A student cannot review even when the submission is not their own.
    await expect(
      checker.assert(student, 'assignment:review', { type: 'submission', id: submissionId }),
    ).rejects.toThrow();
  });

  it('denies self-review even for Admin and Owner', async () => {
    const { checker, auditRepo, submissionId } = await setup();
    const creator = principal(uid('u-student'), ['student', 'admin', 'owner']);

    await expect(
      checker.assert(creator, 'assignment:review', { type: 'submission', id: submissionId }),
    ).rejects.toThrow(/own submission/);

    expect(auditRepo.events.some((e) => e.eventType === 'review.denied')).toBe(true);
  });

  it('audits a denied sensitive access', async () => {
    const { checker, auditRepo, submissionId } = await setup();
    const stranger = principal(uid('u-stranger'), ['teacher']);

    await expect(
      checker.assert(stranger, 'assignment:review', { type: 'submission', id: submissionId }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const denied = auditRepo.events.find((e) => e.eventType === 'permission.denied')!;
    expect(denied).toBeDefined();
    expect(denied.actorId).toBe(uid('u-stranger'));
    expect(denied.payload).toMatchObject({ permission: 'assignment:review' });
  });
});
