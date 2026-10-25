import {
  AuditLogWriter,
  GrantRoleInput,
  IdentityService,
  RevokeRoleInput,
  Role,
  RoleRepository,
  UserId,
  UserRecord,
  errors,
} from '../shared/contracts';

interface IdentityDeps {
  roles: RoleRepository;
  audit: AuditLogWriter;
}

/**
 * A user may hold multiple roles at once. Role changes are always audited.
 *
 * Role-management boundaries:
 *  - Only an Owner may grant or revoke `owner` or `admin`.
 *  - An Admin may grant or revoke `student` / `teacher`, but never `owner` or `admin`.
 *  - The final Owner in the system can never be removed.
 */
export class IdentityServiceImpl implements IdentityService {
  private readonly roles: RoleRepository;
  private readonly audit: AuditLogWriter;

  constructor(deps: IdentityDeps) {
    this.roles = deps.roles;
    this.audit = deps.audit;
  }

  async getUser(userId: UserId): Promise<UserRecord | null> {
    return this.roles.getUserById(userId);
  }

  async listRoles(userId: UserId): Promise<Role[]> {
    return this.roles.listRoles(userId);
  }

  async grantRole(input: GrantRoleInput): Promise<void> {
    const { actorId, targetUserId, role } = input;

    const actorRoles = await this.roles.listRoles(actorId);
    if (!canManageRole(actorRoles, role)) {
      await this.audit.append({
        actorId,
        eventType: 'role.denied',
        targetType: 'user',
        targetId: targetUserId,
        payload: { role, reason: 'insufficient_authority' },
      });
      throw errors.forbidden(`Cannot grant role "${role}"`);
    }

    const target = await this.roles.getUserById(targetUserId);
    if (!target) {
      throw errors.notFound('user');
    }

    const existing = await this.roles.listRoles(targetUserId);
    if (existing.includes(role)) {
      return; // idempotent: role already present
    }

    await this.roles.insertRole(targetUserId, role);
    await this.audit.append({
      actorId,
      eventType: 'role.granted',
      targetType: 'user',
      targetId: targetUserId,
      payload: { role },
    });
  }

  async revokeRole(input: RevokeRoleInput): Promise<void> {
    const { actorId, targetUserId, role } = input;

    const actorRoles = await this.roles.listRoles(actorId);
    if (!canManageRole(actorRoles, role)) {
      await this.audit.append({
        actorId,
        eventType: 'role.denied',
        targetType: 'user',
        targetId: targetUserId,
        payload: { role, reason: 'insufficient_authority' },
      });
      throw errors.forbidden(`Cannot revoke role "${role}"`);
    }

    const target = await this.roles.getUserById(targetUserId);
    if (!target) {
      throw errors.notFound('user');
    }

    const existing = await this.roles.listRoles(targetUserId);
    if (!existing.includes(role)) {
      return; // idempotent: role already absent
    }

    if (role === 'owner') {
      const owners = (await this.roles.listAllRoles()).filter((r) => r.role === 'owner');
      if (owners.length <= 1) {
        await this.audit.append({
          actorId,
          eventType: 'role.denied',
          targetType: 'user',
          targetId: targetUserId,
          payload: { role, reason: 'last_owner' },
        });
        throw errors.forbidden('Cannot remove the last Owner');
      }
    }

    await this.roles.deleteRole(targetUserId, role);
    await this.audit.append({
      actorId,
      eventType: 'role.revoked',
      targetType: 'user',
      targetId: targetUserId,
      payload: { role },
    });
  }
}

export function canManageRole(actorRoles: Role[], role: Role): boolean {
  if (role === 'owner' || role === 'admin') {
    return actorRoles.includes('owner');
  }
  return actorRoles.includes('admin') || actorRoles.includes('owner');
}
