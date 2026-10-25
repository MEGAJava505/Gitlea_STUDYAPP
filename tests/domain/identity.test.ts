import { describe, expect, it } from 'vitest';
import { IdentityServiceImpl } from '../../src/domain/identity';
import { Role, UserId, errors } from '../../src/shared/contracts';
import {
  InMemoryAuditRepository,
  InMemoryRoleRepository,
  makeAuditWriter,
  makeUser,
  uid,
} from './fakes';

function setup(seed?: {
  users?: Array<{ id: UserId; roles: Role[]; login?: string }>;
}) {
  const roles = new InMemoryRoleRepository({
    users: (seed?.users ?? []).map((u) =>
      makeUser({ id: u.id, login: u.login ?? `login-${u.id}` }),
    ),
    roles: (seed?.users ?? []).flatMap((u) => u.roles.map((role) => ({ userId: u.id, role }))),
  });
  const auditRepo = new InMemoryAuditRepository();
  const audit = makeAuditWriter(auditRepo, () => 1_000);
  const identity = new IdentityServiceImpl({ roles, audit });
  return { identity, roles, auditRepo };
}

describe('IdentityService', () => {
  it('supports combined roles on one user', async () => {
    const { identity, roles } = setup({
      users: [
        { id: uid('creator'), roles: ['owner', 'student'] },
        { id: uid('target'), roles: ['student'] },
      ],
    });

    await identity.grantRole({ actorId: uid('creator'), targetUserId: uid('target'), role: 'teacher' });

    expect(await identity.listRoles(uid('creator'))).toEqual(['owner', 'student']);
    expect(await identity.listRoles(uid('target'))).toEqual(['student', 'teacher']);
    expect(await roles.listAllRoles()).toHaveLength(4);
  });

  it('does not let an Admin grant Owner', async () => {
    const { identity, auditRepo } = setup({
      users: [
        { id: uid('owner'), roles: ['owner'] },
        { id: uid('admin'), roles: ['admin'] },
        { id: uid('target'), roles: ['student'] },
      ],
    });

    await expect(
      identity.grantRole({ actorId: uid('admin'), targetUserId: uid('target'), role: 'owner' }),
    ).rejects.toThrow({ code: 'FORBIDDEN' });

    expect(await identity.listRoles(uid('target'))).toEqual(['student']);
    expect(auditRepo.events.some((e) => e.eventType === 'role.denied')).toBe(true);
  });

  it('does not let an Admin revoke Owner', async () => {
    const { identity, roles } = setup({
      users: [
        { id: uid('owner'), roles: ['owner'] },
        { id: uid('admin'), roles: ['admin'] },
      ],
    });

    await expect(
      identity.revokeRole({ actorId: uid('admin'), targetUserId: uid('owner'), role: 'owner' }),
    ).rejects.toThrow({ code: 'FORBIDDEN' });

    expect(await identity.listRoles(uid('owner'))).toEqual(['owner']);
    expect(await roles.listAllRoles()).toHaveLength(2);
  });

  it('refuses to remove the final Owner', async () => {
    const { identity, roles, auditRepo } = setup({
      users: [{ id: uid('only-owner'), roles: ['owner'] }],
    });

    await expect(
      identity.revokeRole({
        actorId: uid('only-owner'),
        targetUserId: uid('only-owner'),
        role: 'owner',
      }),
    ).rejects.toThrow({ code: 'FORBIDDEN' });

    expect(await identity.listRoles(uid('only-owner'))).toEqual(['owner']);
    expect(await roles.listAllRoles()).toHaveLength(1);
    expect(
      auditRepo.events.some(
        (e) => e.eventType === 'role.denied' && e.payload?.reason === 'last_owner',
      ),
    ).toBe(true);
  });

  it('lets an Owner grant and revoke Admin', async () => {
    const { identity } = setup({
      users: [
        { id: uid('owner'), roles: ['owner'] },
        { id: uid('teacher'), roles: ['teacher'] },
      ],
    });

    await identity.grantRole({ actorId: uid('owner'), targetUserId: uid('teacher'), role: 'admin' });
    expect(await identity.listRoles(uid('teacher'))).toEqual(['teacher', 'admin']);

    await identity.revokeRole({ actorId: uid('owner'), targetUserId: uid('teacher'), role: 'admin' });
    expect(await identity.listRoles(uid('teacher'))).toEqual(['teacher']);
  });

  it('writes audit events for role changes', async () => {
    const { identity, auditRepo } = setup({
      users: [
        { id: uid('owner'), roles: ['owner'] },
        { id: uid('target'), roles: ['student'] },
      ],
    });

    await identity.grantRole({ actorId: uid('owner'), targetUserId: uid('target'), role: 'teacher' });
    await identity.revokeRole({ actorId: uid('owner'), targetUserId: uid('target'), role: 'teacher' });

    const types = auditRepo.events.map((e) => e.eventType);
    expect(types).toContain('role.granted');
    expect(types).toContain('role.revoked');

    const granted = auditRepo.events.find((e) => e.eventType === 'role.granted')!;
    expect(granted.actorId).toBe(uid('owner'));
    expect(granted.targetId).toBe(uid('target'));
    expect(granted.payload).toEqual({ role: 'teacher' });
  });
});
