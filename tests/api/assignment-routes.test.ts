import { beforeAll, describe, expect, it } from 'vitest';
import { configureServices } from '../../src/server/auth-context';
import { POST as POST_SESSION, GET as GET_SESSION, DELETE as DELETE_SESSION } from '../../src/app/api/v1/session/route';
import { POST as POST_SUBMIT } from '../../src/app/api/v1/assignments/[assignmentId]/submit/route';
import { POST as POST_REVIEW } from '../../src/app/api/v1/assignments/[assignmentId]/review/route';
import { IdentityServiceImpl } from '../../src/domain/identity';
import { PermissionCheckerImpl } from '../../src/domain/permissions';
import { AssignmentStateMachineImpl } from '../../src/domain/assignments/state-machine';
import {
  InMemoryAssignmentRepository,
  InMemoryAuditRepository,
  InMemoryRoleRepository,
  InMemorySessionRepository,
  FakeGitea,
  makeAssignment,
  makeAuditWriter,
  makeLink,
  makeSessionStore,
  aid,
  gid,
  lid,
  uid,
} from '../domain/fakes';

let studentToken = '';
let teacherToken = '';
const rawTokens: string[] = [];

const jsonReq = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const ctx = (assignmentId: string) => ({ params: Promise.resolve({ assignmentId }) });

function cookieHeader(name: string, value: string) {
  return { cookie: `${name}=${value}` };
}

function tokenFromSetCookie(res: Response): string {
  const header = res.headers.get('set-cookie') ?? '';
  const pair = header.split(';')[0];
  return pair.slice(pair.indexOf('=') + 1);
}

beforeAll(async () => {
  const now = () => 1_000; // before the deadline (10_000)

  const rolesRepo = new InMemoryRoleRepository({
    users: [
      { id: uid('u-student'), login: 'jdu-2400001', email: 's1@jdu.uz', displayName: 'Student' },
      { id: uid('u-teacher'), login: 'teacher-1', email: 't@jdu.uz', displayName: 'Teacher' },
    ],
    roles: [
      { userId: uid('u-student'), role: 'student' },
      { userId: uid('u-teacher'), role: 'teacher' },
    ],
  });
  const auditRepo = new InMemoryAuditRepository();
  const audit = makeAuditWriter(auditRepo, now);
  const identities = new IdentityServiceImpl({ roles: rolesRepo, audit });
  const sessions = makeSessionStore(new InMemorySessionRepository(), now);

  const assignmentRepo = new InMemoryAssignmentRepository(now);
  assignmentRepo.seedAssignment(
    makeAssignment({ id: aid('a1'), teacherId: uid('u-teacher'), groupId: gid('g1'), deadline: 10_000 }),
  );
  assignmentRepo.seedLink(
    makeLink({ id: lid('link1'), groupAssignmentId: aid('a1'), studentId: uid('u-student') }),
  );

  const gitea = new FakeGitea();
  gitea.commits.add('abc123');
  const permissions = new PermissionCheckerImpl({ resolver: assignmentRepo, audit });
  const assignments = new AssignmentStateMachineImpl({ repo: assignmentRepo, gitea, permissions, audit, now });

  configureServices({ sessions, identities, assignments, permissions, audit });

  const s = await sessions.create(
    { userId: uid('u-student'), login: 'jdu-2400001', displayName: 'Student', roles: ['student'] },
    3_600_000,
  );
  const t = await sessions.create(
    { userId: uid('u-teacher'), login: 'teacher-1', displayName: 'Teacher', roles: ['teacher'] },
    3_600_000,
  );
  studentToken = s.token;
  teacherToken = t.token;
  rawTokens.push(s.token, t.token);
});

describe('API routes', () => {
  it('POST /session: missing userId is 400 with a stable code', async () => {
    const res = await POST_SESSION(jsonReq('/api/v1/session', {}));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: 'INVALID_INPUT', message: 'userId is required' },
    });
  });

  it('POST /session: mints a session; raw token lives only in Set-Cookie', async () => {
    const res = await POST_SESSION(jsonReq('/api/v1/session', { userId: 'u-student' }));
    expect(res.status).toBe(200);

    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    const minted = tokenFromSetCookie(res);
    expect(minted).toBeTruthy();

    const bodyText = await res.clone().text();
    const payload = JSON.parse(bodyText) as { principal: { userId: string } };
    expect(payload.principal.userId).toBe('u-student');
    expect(bodyText).not.toContain(minted); // token never in the JSON payload
  });

  it('GET /session: 401 without a token', async () => {
    const res = await GET_SESSION(new Request('/api/v1/session'));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: { code: 'UNAUTHENTICATED', message: 'Authentication required' },
    });
  });

  it('GET /session: 401 after logout revokes the session', async () => {
    const fresh = await POST_SESSION(jsonReq('/api/v1/session', { userId: 'u-student' }));
    const revokedToken = tokenFromSetCookie(fresh);

    const del = await DELETE_SESSION(
      new Request('/api/v1/session', { method: 'DELETE', headers: cookieHeader('session', revokedToken) }),
    );
    expect(del.status).toBe(200);

    const res = await GET_SESSION(new Request('/api/v1/session', { headers: cookieHeader('session', revokedToken) }));
    expect(res.status).toBe(401);
  });

  it('GET /session: authenticated success returns the principal', async () => {
    const res = await GET_SESSION(new Request('/api/v1/session', { headers: cookieHeader('session', studentToken) }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { principal: { userId: string; roles: string[] } };
    expect(body.principal.userId).toBe('u-student');
    expect(body.principal.roles).toContain('student');
  });

  it('submit: 401 when unauthenticated', async () => {
    const res = await POST_SUBMIT(
      jsonReq('/api/v1/assignments/a1/submit', { commitSha: 'abc123', idempotencyKey: 'k1' }),
      ctx('a1'),
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('UNAUTHENTICATED');
  });

  it('submit: 400 on malformed input', async () => {
    const res = await POST_SUBMIT(
      jsonReq('/api/v1/assignments/a1/submit', { commitSha: 'abc123' }, cookieHeader('session', studentToken)),
      ctx('a1'),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('INVALID_INPUT');
  });

  it('submit: authenticated success creates the submission (201)', async () => {
    const res = await POST_SUBMIT(
      jsonReq('/api/v1/assignments/a1/submit', { commitSha: 'abc123', idempotencyKey: 'api-key-1' }, cookieHeader('session', studentToken)),
      ctx('a1'),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      submission: { id: string; attempt: number; status: string };
      alreadyExisted: boolean;
    };
    expect(body.submission.attempt).toBe(1);
    expect(body.submission.status).toBe('submitted');
    expect(body.alreadyExisted).toBe(false);
  });

  it('submit: idempotent retry returns the existing attempt (200, same id)', async () => {
    const res = await POST_SUBMIT(
      jsonReq('/api/v1/assignments/a1/submit', { commitSha: 'abc123', idempotencyKey: 'api-key-1' }, cookieHeader('session', studentToken)),
      ctx('a1'),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      submission: { id: string; attempt: number };
      alreadyExisted: boolean;
    };
    expect(body.alreadyExisted).toBe(true);
    expect(body.submission.attempt).toBe(1);
  });

  it('submit: unknown assignment is 404, never 500', async () => {
    const res = await POST_SUBMIT(
      jsonReq('/api/v1/assignments/nope/submit', { commitSha: 'abc123', idempotencyKey: 'k-x' }, cookieHeader('session', studentToken)),
      ctx('nope'),
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('NOT_FOUND');
  });

  it('submit: a teacher gets 403 (role check), no snapshot created', async () => {
    const res = await POST_SUBMIT(
      jsonReq('/api/v1/assignments/a1/submit', { commitSha: 'abc123', idempotencyKey: 'k-t' }, cookieHeader('session', teacherToken)),
      ctx('a1'),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('FORBIDDEN');
  });

  it('review: 400 on missing fields', async () => {
    const res = await POST_REVIEW(
      jsonReq('/api/v1/assignments/a1/review', { action: 'pass' }, cookieHeader('session', teacherToken)),
      ctx('a1'),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('INVALID_INPUT');
  });

  it('review: a student cannot review (403) even their own submission', async () => {
    const res = await POST_REVIEW(
      jsonReq(
        '/api/v1/assignments/a1/review',
        { action: 'pass', submissionId: 'sub-1', feedback: 'self' },
        cookieHeader('session', studentToken),
      ),
      ctx('a1'),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('FORBIDDEN');
  });

  it('review: the responsible teacher passes the submission', async () => {
    const res = await POST_REVIEW(
      jsonReq(
        '/api/v1/assignments/a1/review',
        { action: 'pass', submissionId: 'sub-1', feedback: 'ok' },
        cookieHeader('session', teacherToken),
      ),
      ctx('a1'),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; review: { decision: string } | null };
    expect(body.status).toBe('passed');
    expect(body.review?.decision).toBe('pass');
  });

  it('no handler leaks session tokens or secrets in the payload', async () => {
    const res = await POST_REVIEW(
      jsonReq(
        '/api/v1/assignments/a1/review',
        { action: 'fail', submissionId: 'sub-1', feedback: 'again' },
        cookieHeader('session', teacherToken),
      ),
      ctx('a1'),
    );
    const text = await res.text();
    for (const raw of rawTokens) {
      expect(text).not.toContain(raw);
    }
    expect(text).not.toContain('abc123secret');
  });
});
