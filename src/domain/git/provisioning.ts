import { createHash } from 'node:crypto';
import { errors, type AssignmentId, type Clock, type RepositoryLinkRecord, type SessionPrincipal, type UserId } from '../../shared/contracts';
import type { GiteaProvisioningPort } from '../../server/ports/gitea-provisioning';

export interface AssignmentTemplate {
  owner: string;
  repo: string;
}

export interface ProvisioningAssignment {
  id: AssignmentId;
  groupId: import('../../shared/contracts').GroupId;
  publishedAt: number | null;
  template: AssignmentTemplate | null;
}

export interface ProvisioningRepository {
  getPublishedAssignment(id: AssignmentId): Promise<ProvisioningAssignment | null>;
  isAssignedToStudent(id: AssignmentId, studentId: UserId): Promise<boolean>;
  getRepositoryLink(id: AssignmentId, studentId: UserId): Promise<RepositoryLinkRecord | null>;
  insertRepositoryLink(input: Omit<RepositoryLinkRecord, 'id'>): Promise<RepositoryLinkRecord>;
}

export type ProvisioningAuditEventType = 'repository.provisioned' | 'integration.error';

export interface ProvisioningAudit {
  append(input: {
    actorId: UserId | null;
    eventType: ProvisioningAuditEventType;
    targetType: string;
    targetId: string;
    payload: Record<string, unknown>;
  }): Promise<unknown>;
}

export interface CloneUrls {
  https: string;
  ssh: string;
}

export interface ProvisioningResult {
  created: boolean;
  repository: RepositoryLinkRecord;
  cloneUrls: CloneUrls;
}

export function repositoryName(templateRepo: string, login: string, assignmentId?: AssignmentId): string {
  const normalize = (value: string): string => value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  const prefix = `${normalize(templateRepo) || 'assignment'}-${normalize(login) || 'student'}`;
  // Keep the legacy two-argument helper compatible; provisioning always scopes
  // identity to the assignment, independently of lossy display-name normalization.
  if (assignmentId === undefined) return prefix;
  const identity = createHash('sha256').update(JSON.stringify([assignmentId, login])).digest('hex');
  return `${prefix.slice(0, 35)}-${identity}`;
}

export function cloneUrls(fullName: string, bases: { cloneBaseUrl: string; sshCloneBaseUrl: string }): CloneUrls {
  const suffix = `${fullName}.git`;
  return {
    https: `${bases.cloneBaseUrl.replace(/\/$/, '')}/${suffix}`,
    ssh: `${bases.sshCloneBaseUrl.replace(/\/$/, '')}/${suffix}`,
  };
}

export class ProvisioningService {
  private readonly deps: {
    repo: ProvisioningRepository;
    gitea: GiteaProvisioningPort;
    audit: ProvisioningAudit;
    now: Clock;
    organization: string;
    cloneBaseUrl: string;
    sshCloneBaseUrl: string;
  };

  constructor(deps: ProvisioningService['deps']) {
    this.deps = deps;
  }

  async provision(actor: SessionPrincipal, assignmentId: AssignmentId): Promise<ProvisioningResult> {
    const assignment = await this.authorize(actor, assignmentId);
    const existing = await this.deps.repo.getRepositoryLink(assignmentId, actor.userId);
    if (existing) return this.result(existing, false);
    if (!assignment.template) throw errors.invalidState('Assignment template is not configured');

    const name = repositoryName(assignment.template.repo, actor.login, assignmentId);
    const fullName = `${this.deps.organization}/${name}`;
    const giteaRepo = await this.callGitea(actor, assignmentId, 'create_repository', () => this.deps.gitea.createRepositoryFromTemplate({
      templateOwner: assignment.template!.owner,
      templateRepo: assignment.template!.repo,
      owner: this.deps.organization,
      name,
      private: true,
    }));
    if (!giteaRepo.private) {
      await this.recordIntegrationError(actor, assignmentId, 'private_repository');
      throw errors.integration('Gitea returned a public repository');
    }
    await this.callGitea(actor, assignmentId, 'grant_write_access', () => this.deps.gitea.grantWriteAccess({ repo: giteaRepo.fullName || fullName, login: actor.login }));
    await this.callGitea(actor, assignmentId, 'protect_branch', () => this.deps.gitea.protectBranch({ repo: giteaRepo.fullName || fullName, branch: giteaRepo.defaultBranch || 'main' }));

    let repository: RepositoryLinkRecord;
    try {
      repository = await this.deps.repo.insertRepositoryLink({
        groupAssignmentId: assignmentId,
        studentId: actor.userId,
        giteaRepoFullName: giteaRepo.fullName || fullName,
        giteaRepoId: giteaRepo.id,
        isPrivate: true,
      });
    } catch (error) {
      await this.recordIntegrationError(actor, assignmentId, 'link_repository');
      throw errors.integration(error instanceof Error ? error.message : 'Repository link could not be stored');
    }
    await this.deps.audit.append({
      actorId: actor.userId,
      eventType: 'repository.provisioned',
      targetType: 'repositoryLink',
      targetId: repository.id,
      payload: {
        assignmentId,
        studentId: actor.userId,
        repoFullName: repository.giteaRepoFullName,
        private: repository.isPrivate,
        createdAt: this.deps.now(),
      },
    });
    return this.result(repository, true);
  }

  async get(actor: SessionPrincipal, assignmentId: AssignmentId): Promise<ProvisioningResult> {
    await this.authorize(actor, assignmentId);
    const repository = await this.deps.repo.getRepositoryLink(assignmentId, actor.userId);
    if (!repository) throw errors.notFound('repository');
    return this.result(repository, false);
  }

  private async authorize(actor: SessionPrincipal, assignmentId: AssignmentId): Promise<ProvisioningAssignment> {
    if (!actor.roles.includes('student')) throw errors.forbidden('Student access required');
    const assignment = await this.deps.repo.getPublishedAssignment(assignmentId);
    if (!assignment) throw errors.notFound('assignment');
    if (assignment.publishedAt === null) throw errors.invalidState('Assignment is not published');
    if (!(await this.deps.repo.isAssignedToStudent(assignmentId, actor.userId))) throw errors.forbidden('Assignment access required');
    return assignment;
  }

  private result(repository: RepositoryLinkRecord, created: boolean): ProvisioningResult {
    return {
      created,
      repository,
      cloneUrls: cloneUrls(repository.giteaRepoFullName, {
        cloneBaseUrl: this.deps.cloneBaseUrl,
        sshCloneBaseUrl: this.deps.sshCloneBaseUrl,
      }),
    };
  }

  private async callGitea<T>(actor: SessionPrincipal, assignmentId: AssignmentId, step: string, operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      await this.recordIntegrationError(actor, assignmentId, step);
      throw errors.integration(error instanceof Error ? error.message : 'Gitea operation failed');
    }
  }

  private async recordIntegrationError(actor: SessionPrincipal, assignmentId: AssignmentId, step: string): Promise<void> {
    await this.deps.audit.append({
      actorId: actor.userId,
      eventType: 'integration.error',
      targetType: 'assignment',
      targetId: assignmentId,
      payload: { assignmentId, studentId: actor.userId, step },
    });
  }
}
