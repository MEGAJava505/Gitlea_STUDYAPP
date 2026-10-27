import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '../../src/app/api/v1/assignments/[assignmentId]/submit/route';
import { configureServices } from '../../src/server/auth-context';
import { errors, type AssignmentStateMachine, type SessionPrincipal, type UserId } from '../../src/shared/contracts';

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
});
