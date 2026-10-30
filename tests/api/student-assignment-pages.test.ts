import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudentAssignmentDetail } from '../../src/server/student-assignments';

const fixture = vi.hoisted(() => ({ get: vi.fn(), list: vi.fn(), grading: { isEnabled: vi.fn() } }));
vi.mock('next/headers', () => ({ headers: async () => new Headers({ cookie: 'session=student' }) }));
vi.mock('next/navigation', () => ({
  notFound: () => { throw new Error('NOT_FOUND'); },
  unauthorized: () => { throw new Error('UNAUTHORIZED'); },
  forbidden: () => { throw new Error('FORBIDDEN'); },
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock('../../src/server/auth-context', () => ({
  getServices: () => ({ studentAssignments: fixture, grading: fixture.grading }),
  createAuthContext: () => ({ principal: async () => ({ userId: 'student', roles: ['student'] }) }),
}));
import DetailPage from '../../src/app/(panels)/student/assignments/[assignmentId]/page';
import ListPage from '../../src/app/(panels)/student/assignments/page';

let assignment: StudentAssignmentDetail;
const renderDetail = async () => renderToStaticMarkup(await DetailPage({ params: Promise.resolve({ assignmentId: 'a1' }) }));

beforeEach(() => {
  // Vitest's existing TS transform uses classic JSX; Next supplies this in production.
  vi.stubGlobal('React', React);
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-26T12:00:00Z'));
  vi.stubEnv('GITEA_CLONE_BASE_URL', 'https://git.example.test');
  assignment = {
    id: 'a1', title: 'Assignment', description: 'Build it', deadline: Date.parse('2026-10-26T18:59:59.999Z'),
    status: 'in_progress', allowResubmission: true, repository: { fullName: 'org/a1-student' }, attempts: [],
  };
  fixture.get.mockImplementation(async () => assignment);
  fixture.list.mockImplementation(async () => [assignment]);
  fixture.grading.isEnabled.mockImplementation(async () => false);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe('student assignment server pages', () => {
  it('renders own repository, explicit submission workflow and Tashkent deadline', async () => {
    const html = await renderDetail();
    expect(fixture.get).toHaveBeenCalledWith('student', 'a1');
    expect(html).toContain('https://git.example.test/org/a1-student.git');
    expect(html).toContain('Pushing alone is not a submission.');
    expect(html).toContain('git push -u origin work');
    expect(html).toContain('Submit work');
    expect(html).toContain('26 October 2026 at 23:59');
    expect(html).toContain('(Tashkent)');
    expect(html).toContain('2026-10-26T18:59:59.999Z');
  });

  it('renders list status and Tashkent time for the authenticated student', async () => {
    const html = renderToStaticMarkup(await ListPage());
    expect(fixture.list).toHaveBeenCalledWith('student');
    expect(html).toContain('/student/assignments/a1');
    expect(html).toContain('data-status="in_progress"');
    expect(html).toContain('23:59:59');
  });

  it('does not render hidden or other students assignments', async () => {
    fixture.get.mockResolvedValue(null);
    await expect(renderDetail()).rejects.toThrow('NOT_FOUND');
  });

  it('allows a revision only when resubmission is enabled', async () => {
    assignment.status = 'revision_required';
    expect(await renderDetail()).toContain('Submit work');
    assignment.allowResubmission = false;
    const html = await renderDetail();
    expect(html).not.toContain('Submit work');
    expect(html).toContain('resubmission is not allowed');
  });

  it('keeps timely submitted work awaiting review after the deadline', async () => {
    assignment.status = 'submitted';
    assignment.deadline = Date.parse('2026-10-26T11:59:59.999Z');
    const html = await renderDetail();
    expect(html).toContain('Submitted. Waiting for teacher review.');
    expect(html).not.toContain('Submit work');
  });

  it('closes expired submissions without provisioning a repository', async () => {
    assignment.deadline = Date.parse('2026-10-26T11:59:59.999Z');
    expect(await renderDetail()).not.toContain('Submit work');
    assignment.repository = null;
    const html = await renderDetail();
    expect(html).not.toContain('Create my repository');
    expect(html).toContain('the deadline has passed');
  });

  it.each(['passed', 'failed'] as const)('explains terminal %s without offering submission or repository creation', async (status) => {
    assignment.status = status;
    assignment.repository = null;
    const html = await renderDetail();
    expect(html).toContain('Submission is closed: this assignment is final.');
    expect(html).not.toContain('Submit work');
    expect(html).not.toContain('Create my repository');
    assignment.repository = { fullName: 'org/a1-student' };
    expect(await renderDetail()).not.toContain('Submit work');
  });

  it('hides the grade column entirely while numeric grading is disabled', async () => {
    assignment.attempts = [{
      attempt: 1, commitSha: 'a'.repeat(40), submittedAt: 1_700_000_000_000, status: 'passed',
      review: { decision: 'passed', feedback: 'Good', grade: 4 },
    }];
    fixture.grading.isEnabled.mockImplementation(async () => false);
    const html = await renderDetail();
    expect(html).toContain('Feedback');
    expect(html).not.toContain('<th>Grade</th>');
    expect(html).not.toContain('data-grade');
    // The feedback still surfaces; only the grade is suppressed.
    expect(html).toContain('Good');
  });

  it('shows the grade column and value while numeric grading is enabled', async () => {
    assignment.attempts = [{
      attempt: 1, commitSha: 'a'.repeat(40), submittedAt: 1_700_000_000_000, status: 'passed',
      review: { decision: 'passed', feedback: 'Good', grade: 4 },
    }];
    fixture.grading.isEnabled.mockImplementation(async () => true);
    const html = await renderDetail();
    expect(html).toContain('<th>Grade</th>');
    expect(html).toContain('data-grade');
    expect(html).toContain('>4<');
  });
});
