import { beforeAll, describe, expect, it } from 'vitest';
import { DomainError } from '../../src/shared/contracts';
import { IdentityServiceImpl } from '../../src/domain/identity';
import { createAuthContext } from '../../src/server/auth-context';
import {
  requireAdminPanel,
  requireStudentPanel,
  requireTeacherPanel,
} from '../../src/server/panels';
import {
  InMemoryAuditRepository,
  InMemoryRoleRepository,
  InMemorySessionRepository,
  makeAuditWriter,
  makeSessionStore,
  uid,
} from '../domain/fakes';

let studentToken = '';
let teacherToken = '';
let adminToken = '';
let ownerToken = '';
let auth: ReturnType<typeof createAuthContext>;

function requestWithSession(token?: string): Request {
  return new Request('http://localhost/panel', {
    headers: token ? { cookie: `session=${token}` } : undefined,
  });
}

function expectDomainCode(action: () => unknown, code: string): void {
  try {
    action();
    expect.fail(`Expected ${code} error`);
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect(error).toMatchObject({ code });
  }
}

beforeAll(async () => {
  const now = () => 1_000;
  const roles = new InMemoryRoleRepository({
    users: [
      { id: uid('student'), login: 'student', email: 'student@example.test', displayName: 'Student' },
      { id: uid('teacher'), login: 'teacher', email: 'teacher@example.test', displayName: 'Teacher' },
      { id: uid('admin'), login: 'admin', email: 'admin@example.test', displayName: 'Admin' },
      { id: uid('owner'), login: 'owner', email: 'owner@example.test', displayName: 'Owner' },
    ],
    roles: [
      { userId: uid('student'), role: 'student' },
      { userId: uid('teacher'), role: 'teacher' },
      { userId: uid('admin'), role: 'admin' },
      { userId: uid('owner'), role: 'owner' },
    ],
  });
  const audit = makeAuditWriter(new InMemoryAuditRepository(), now);
  const identities = new IdentityServiceImpl({ roles, audit });
  const sessions = makeSessionStore(new InMemorySessionRepository(), now);
  auth = createAuthContext({ sessions, identities });

  studentToken = (await sessions.create(
    { userId: uid('student'), login: 'student', displayName: 'Student', roles: ['student'] },
    60_000,
  )).token;
  teacherToken = (await sessions.create(
    { userId: uid('teacher'), login: 'teacher', displayName: 'Teacher', roles: ['teacher'] },
    60_000,
  )).token;
  adminToken = (await sessions.create(
    { userId: uid('admin'), login: 'admin', displayName: 'Admin', roles: ['admin'] },
    60_000,
  )).token;
  ownerToken = (await sessions.create(
    { userId: uid('owner'), login: 'owner', displayName: 'Owner', roles: ['owner'] },
    60_000,
  )).token;
});

describe('panel access', () => {
  it('denies an unauthenticated request', async () => {
    const principal = await auth.principal(requestWithSession());

    expectDomainCode(() => requireStudentPanel(principal), 'UNAUTHENTICATED');
  });

  it('allows each role to open its own panel', async () => {
    const student = await auth.principal(requestWithSession(studentToken));
    const teacher = await auth.principal(requestWithSession(teacherToken));
    const admin = await auth.principal(requestWithSession(adminToken));
    const owner = await auth.principal(requestWithSession(ownerToken));

    expect(requireStudentPanel(student)).toMatchObject({ userId: uid('student') });
    expect(requireTeacherPanel(teacher)).toMatchObject({ userId: uid('teacher') });
    expect(requireAdminPanel(admin)).toMatchObject({ userId: uid('admin') });
    expect(requireAdminPanel(owner)).toMatchObject({ userId: uid('owner') });
  });

  it('prevents a student from opening teacher and admin panels', async () => {
    const student = await auth.principal(requestWithSession(studentToken));

    expectDomainCode(() => requireTeacherPanel(student), 'FORBIDDEN');
    expectDomainCode(() => requireAdminPanel(student), 'FORBIDDEN');
  });

  it('prevents a teacher from opening the admin panel', async () => {
    const teacher = await auth.principal(requestWithSession(teacherToken));

    expectDomainCode(() => requireAdminPanel(teacher), 'FORBIDDEN');
  });
});
