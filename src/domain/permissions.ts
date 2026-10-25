import {
  AccessResolver,
  AssignmentId,
  AuditLogWriter,
  Permission,
  PermissionChecker,
  RepositoryLinkId,
  ResourceRef,
  Role,
  SessionPrincipal,
  SubmissionId,
  UserId,
  errors,
} from '../shared/contracts';

const ROLE_PERMISSIONS: Readonly<Record<Role, ReadonlySet<Permission>>> = {
  student: new Set<Permission>([
    'session:read',
    'identity:read',
    'assignment:read',
    'assignment:submit',
    'submission:read',
  ]),
  teacher: new Set<Permission>([
    'session:read',
    'identity:read',
    'identity:list_roles',
    'assignment:read',
    'assignment:review',
    'submission:read',
  ]),
  admin: new Set<Permission>([
    'session:read',
    'identity:read',
    'identity:list_roles',
    'identity:grant_role',
    'identity:revoke_role',
    'assignment:read',
    'assignment:review',
    'submission:read',
    'audit:read',
  ]),
  owner: new Set<Permission>([
    'session:read',
    'identity:read',
    'identity:list_roles',
    'identity:grant_role',
    'identity:revoke_role',
    'assignment:read',
    'assignment:review',
    'submission:read',
    'audit:read',
  ]),
};

type DenialReason = 'self_review' | 'insufficient';

interface PermissionDeps {
  resolver: AccessResolver;
  audit?: AuditLogWriter;
}

/**
 * Evaluates a permission against the actor's roles AND the target resource.
 * Role presence alone is never sufficient for resource-scoped permissions:
 * student ownership, teacher assignment membership, and self-review are all
 * resolved from the injected access resolver on every call.
 */
export class PermissionCheckerImpl implements PermissionChecker {
  private readonly resolver: AccessResolver;
  private readonly audit?: AuditLogWriter;

  constructor(deps: PermissionDeps) {
    this.resolver = deps.resolver;
    this.audit = deps.audit;
  }

  async can(
    actor: SessionPrincipal,
    permission: Permission,
    resource?: ResourceRef,
  ): Promise<boolean> {
    return (await this.denyReason(actor, permission, resource)) === null;
  }

  async assert(
    actor: SessionPrincipal,
    permission: Permission,
    resource?: ResourceRef,
  ): Promise<void> {
    const reason = await this.denyReason(actor, permission, resource);
    if (reason === null) return;

    if (this.audit) {
      await this.audit.append({
        actorId: actor.userId,
        eventType: reason === 'self_review' ? 'review.denied' : 'permission.denied',
        targetType: resource?.type ?? 'permission',
        targetId: resource ? String(resource.id) : permission,
        payload: { permission, reason },
      });
    }

    if (reason === 'self_review') {
      throw errors.forbidden('You cannot review your own submission');
    }
    throw errors.forbidden(`Missing permission "${permission}"`);
  }

  private async denyReason(
    actor: SessionPrincipal,
    permission: Permission,
    resource?: ResourceRef,
  ): Promise<DenialReason | null> {
    if (!hasRolePermission(actor.roles, permission)) {
      return 'insufficient';
    }

    if (resource === undefined) {
      return null;
    }

    switch (permission) {
      case 'assignment:submit':
        return this.denySubmit(actor, resource);
      case 'assignment:review':
        return this.denyReview(actor, resource);
      case 'assignment:read':
        return this.denyAssignmentRead(actor, resource);
      case 'submission:read':
        return this.denySubmissionRead(actor, resource);
      default:
        return null;
    }
  }

  private async denySubmit(
    actor: SessionPrincipal,
    resource: ResourceRef,
  ): Promise<DenialReason | null> {
    if (resource.type !== 'assignment') return 'insufficient';
    if (!actor.roles.includes('student')) return 'insufficient';
    const link = await this.resolver.getRepositoryLink(resource.id, actor.userId);
    if (!link || link.studentId !== actor.userId) return 'insufficient';
    return null;
  }

  private async denyReview(
    actor: SessionPrincipal,
    resource: ResourceRef,
  ): Promise<DenialReason | null> {
    if (resource.type !== 'submission') return 'insufficient';

    const submission = await this.resolver.getSubmission(resource.id);
    if (!submission) return 'insufficient';

    const link = await this.resolver.getRepositoryLinkById(submission.repositoryLinkId);
    if (!link) return 'insufficient';

    // No actor may review their own submission — not even Admin or Owner.
    if (actor.userId === link.studentId) return 'self_review';

    if (actor.roles.includes('admin') || actor.roles.includes('owner')) return null;

    const assignment = await this.resolver.getAssignment(link.groupAssignmentId);
    if (!assignment) return 'insufficient';
    return actor.userId === assignment.teacherId ? null : 'insufficient';
  }

  private async denyAssignmentRead(
    actor: SessionPrincipal,
    resource: ResourceRef,
  ): Promise<DenialReason | null> {
    if (resource.type !== 'assignment') return 'insufficient';
    if (actor.roles.includes('admin') || actor.roles.includes('owner')) return null;

    const assignment = await this.resolver.getAssignment(resource.id);
    if (!assignment) return 'insufficient';

    if (actor.userId === assignment.teacherId) return null;

    const link = await this.resolver.getRepositoryLink(resource.id, actor.userId);
    return link && link.studentId === actor.userId ? null : 'insufficient';
  }

  private async denySubmissionRead(
    actor: SessionPrincipal,
    resource: ResourceRef,
  ): Promise<DenialReason | null> {
    if (resource.type !== 'submission') return 'insufficient';
    if (actor.roles.includes('admin') || actor.roles.includes('owner')) return null;

    const submission = await this.resolver.getSubmission(resource.id);
    if (!submission) return 'insufficient';

    const link = await this.resolver.getRepositoryLinkById(submission.repositoryLinkId);
    if (!link) return 'insufficient';
    if (actor.userId === link.studentId) return null;

    const assignment = await this.resolver.getAssignment(link.groupAssignmentId);
    if (!assignment) return 'insufficient';
    return actor.userId === assignment.teacherId ? null : 'insufficient';
  }
}

export function hasRolePermission(roles: Role[], permission: Permission): boolean {
  return roles.some((role) => ROLE_PERMISSIONS[role]?.has(permission));
}

export type { AssignmentId, RepositoryLinkId, SubmissionId, UserId };
