import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '../../src/app/api/v1/assignments/[assignmentId]/submit/route';
import { configureServices } from '../../src/server/auth-context';
import { DomainError, errors, type AssignmentStateMachine, type SessionPrincipal, type SubmitResult, type UserId } from '../../src/shared/contracts';

const principal: SessionPrincipal = {
  userId: 'student' as UserId, login: 'student', displayName: 'Student', roles: ['student'],
};
const submit = vi.fn<AssignmentStateMachine['submit']>();
const validBody = { commitSha: 'abc123', idempotencyKey: 'retry-key' };

function request(body: unknown, authenticated = true) {
  return new Request('http://localhost/api/v1/assignments/a1/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(authenticated ? { cookie: 'session=test-session' } : {}) },
    body: JSON.stringify(body),
  });
}

function post(req: Request) {
  return POST(req, { params: Promise.resolve({ assignmentId: 'a1' }) });
}

beforeEach(() => {
  submit.mockReset();
  submit.mockRejectedValue(errors.conflict('Idempotency key already used with a different commit'));
  configureServices({
    sessions: {
      get: async () => ({ userId: principal.userId, createdAt: 0, expiresAt: 10_000 }),
      create: vi.fn(), revoke: vi.fn(),
    },
    identities: {
      getUser: async () => ({ id: principal.userId, login: principal.login, displayName: principal.displayName, email: 'student@example.com', giteaId: null }),
      listRoles: async () => principal.roles,
      grantRole: vi.fn(), revokeRole: vi.fn(),
    },
    assignments: { submit, requestRevision: vi.fn(), pass: vi.fn(), fail: vi.fn() },
    audit: { append: vi.fn() },
  });
});

describe('assignment submit HTTP contract', () => {
  it.each([
    ['null', null],
    ['array', []],
    ['string', 'abc123'],
    ['number', 42],
    ['boolean', true],
    ['empty object', {}],
    ...(['commitSha', 'idempotencyKey'] as const).flatMap((field) =>
      [undefined, null, '', ' \t\n', 123, true, [], {}, ['abc123']].map((value) =>
        [field + ": " + JSON.stringify(value), { ...validBody, [field]: value }]),
    ),
  ])('rejects malformed input: %s', async (_name, body) => {
    const response = await post(request(body));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: 'INVALID_INPUT', message: 'commitSha and idempotencyKey are required' },
    });
    expect(submit).not.toHaveBeenCalled();
  });

  it('rejects invalid JSON without invoking the service', async () => {
    const response = await post(new Request('http://localhost/api/v1/assignments/a1/submit', {
      method: 'POST', headers: { cookie: 'session=test-session' }, body: '{',
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: 'INVALID_INPUT', message: 'commitSha and idempotencyKey are required' },
    });
    expect(submit).not.toHaveBeenCalled();
  });

  it('propagates repeated same-key/different-SHA conflicts as stable JSON 409', async () => {
    // The service owns durable-key semantics; this seam preserves its conflict.
    const body = { commitSha: 'different-sha', idempotencyKey: 'retry-key' };
    for (let retry = 0; retry < 2; retry += 1) {
      const response = await post(request(body));
      expect(response.status).toBe(409);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(await response.json()).toEqual({
        error: { code: 'CONFLICT', message: 'Idempotency key already used with a different commit' },
      });
    }
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit).toHaveBeenNthCalledWith(1, { actor: principal, assignmentId: 'a1', ...body });
    expect(submit).toHaveBeenNthCalledWith(2, { actor: principal, assignmentId: 'a1', ...body });
  });

  it.each([false, true])('forwards exact nonempty strings without normalization; replay=%s', async (alreadyExisted) => {
    const body = { commitSha: ' abc123 ', idempotencyKey: ' Retry-Key/01 ' };
    const result: SubmitResult = {
      submission: {
        id: 'sub-1' as SubmitResult['submission']['id'],
        repositoryLinkId: 'link-1' as SubmitResult['submission']['repositoryLinkId'],
        attempt: 1, commitSha: body.commitSha, protectedRef: 'submission/1', status: 'submitted', submittedAt: 1_000,
      },
      alreadyExisted,
    };
    submit.mockResolvedValue(result);
    const response = await post(request(body));
    expect(response.status).toBe(alreadyExisted ? 200 : 201);
    expect(await response.json()).toEqual(result);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith({ actor: principal, assignmentId: 'a1', ...body });
  });

  it('preserves JSON 401 and never submits unauthenticated requests', async () => {
    const response = await post(request(validBody, false));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } });
    expect(submit).not.toHaveBeenCalled();
  });

  it('preserves the service authorization denial as JSON 403', async () => {
    submit.mockRejectedValue(errors.forbidden());
    const response = await post(request(validBody));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { code: 'FORBIDDEN', message: 'Forbidden' } });
  });

  it('preserves sanitized integration errors without serializing private details', async () => {
    submit.mockRejectedValue(new DomainError('INTEGRATION_ERROR', 'Repository service unavailable', 502, { diagnostic: 'private adapter diagnostic' }));
    const response = await post(request(validBody));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: { code: 'INTEGRATION_ERROR', message: 'Repository service unavailable' } });
  });

  it('does not expose unexpected integration exception messages', async () => {
    submit.mockRejectedValue(new Error('private adapter diagnostic'));
    const response = await post(request(validBody));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
  });
});
