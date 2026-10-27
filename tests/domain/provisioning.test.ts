import { describe, expect, it } from 'vitest';
import {
  ProvisioningService,
  cloneUrls,
  repositoryName,
  type AssignmentTemplate,
  type ProvisioningAssignment,
  type ProvisioningAudit,
  type ProvisioningAuditEventType,
  type ProvisioningRepository,
} from '../../src/domain/git/provisioning';
import type { GiteaProvisioningPort } from '../../src/server/ports/gitea-provisioning';
import type {
  AssignmentId,
  RepositoryLinkId,
  RepositoryLinkRecord,
  SessionPrincipal,
  UserId,
} from '../../src/shared/contracts';
import { gid, principal, uid } from './fakes';

/* ------------------------------- fakes ---------------------------------- */

const aid = (s: string): AssignmentId => s as AssignmentId;
const lid = (s: string): RepositoryLinkId => s as RepositoryLinkId;

const STUDENT = principal(uid('u-student'), ['student'], 'jdu-2400051', 'Student');
const OTHER_STUDENT = principal(uid('u-other'), ['student'], 'jdu-2400052', 'Other');
const TEACHER = principal(uid('u-teacher'), ['teacher'], 'teacher', 'Teacher');
const TEMPLATE: AssignmentTemplate = { owner: 'local-github', repo: 'assignment-04' };
const ASSIGNMENT = aid('a1');

class FakeProvisioningRepository implements ProvisioningRepository {
  assignments = new Map<AssignmentId, ProvisioningAssignment>();
  links = new Map<string, RepositoryLinkRecord>();
  assigned = new Set<string>();
  failInsert = false;
  private seq = 0;

  seedAssignment(over: Partial<ProvisioningAssignment> = {}): void {
    this.assignments.set(ASSIGNMENT, {
      id: ASSIGNMENT,
      groupId: gid('g1'),
      publishedAt: 500,
      template: TEMPLATE,
      ...over,
    });
  }

  allow(studentId: UserId): void {
    this.assigned.add(`${ASSIGNMENT}:${studentId}`);
  }

  async getPublishedAssignment(id: AssignmentId): Promise<ProvisioningAssignment | null> {
    return this.assignments.get(id) ?? null;
  }

  async isAssignedToStudent(id: AssignmentId, studentId: UserId): Promise<boolean> {
    return this.assigned.has(`${id}:${studentId}`);
  }

  async getRepositoryLink(id: AssignmentId, studentId: UserId): Promise<RepositoryLinkRecord | null> {
    return this.links.get(`${id}:${studentId}`) ?? null;
  }

  async insertRepositoryLink(input: Omit<RepositoryLinkRecord, 'id'>): Promise<RepositoryLinkRecord> {
    if (this.failInsert) throw new Error('database unavailable');
    const key = `${input.groupAssignmentId}:${input.studentId}`;
    const existing = this.links.get(key);
    if (existing) return existing;
    this.seq += 1;
    const link: RepositoryLinkRecord = { id: lid(`link-${this.seq}`), ...input };
    this.links.set(key, link);
    return link;
  }
}

class FakeGiteaProvisioning implements GiteaProvisioningPort {
  repositories = new Map<string, { id: number; fullName: string; private: boolean; defaultBranch: string }>();
  createInputs: Array<{ templateOwner: string; templateRepo: string; owner: string; name: string; private: true }> = [];
  grants: Array<{ repo: string; login: string }> = [];
  protections: Array<{ repo: string; branch: string }> = [];
  failOn: 'create' | 'grant' | 'protect' | null = null;
  forcePublic = false;
  private seq = 0;

  async createRepositoryFromTemplate(input: {
    templateOwner: string;
    templateRepo: string;
    owner: string;
    name: string;
    private: true;
  }): Promise<{ id: number; fullName: string; private: boolean; defaultBranch: string }> {
    this.createInputs.push(input);
    if (this.failOn === 'create') throw new Error('gitea unavailable');
    const fullName = `${input.owner}/${input.name}`;
    const existing = this.repositories.get(fullName);
    if (existing) return existing;
    this.seq += 1;
    const repo = { id: this.seq, fullName, private: !this.forcePublic, defaultBranch: 'main' };
    this.repositories.set(fullName, repo);
    return repo;
  }

  async grantWriteAccess(input: { repo: string; login: string }): Promise<void> {
    if (this.failOn === 'grant') throw new Error('gitea unavailable');
    this.grants.push(input);
  }

  async protectBranch(input: { repo: string; branch: string }): Promise<void> {
    if (this.failOn === 'protect') throw new Error('gitea unavailable');
    this.protections.push(input);
  }

  async createPullRequest(): Promise<{ number: number }> {
    throw new Error('not used in provisioning tests');
  }

  async addComment(): Promise<void> {
    throw new Error('not used in provisioning tests');
  }
}

interface RecordedAudit {
  actorId: UserId | null;
  eventType: ProvisioningAuditEventType;
  targetType: string;
  targetId: string;
  payload: Record<string, unknown>;
}

class FakeAudit implements ProvisioningAudit {
  events: RecordedAudit[] = [];

  async append(input: RecordedAudit): Promise<void> {
    this.events.push(input);
  }
}

function world() {
  const repo = new FakeProvisioningRepository();
  repo.seedAssignment();
  repo.allow(STUDENT.userId);
  const gitea = new FakeGiteaProvisioning();
  const audit = new FakeAudit();
  const service = new ProvisioningService({
    repo,
    gitea,
    audit,
    now: () => 1_000,
    organization: 'local-github',
    cloneBaseUrl: 'http://gitea:3000',
    sshCloneBaseUrl: 'ssh://git@gitea:2222',
  });
  return { repo, gitea, audit, service };
}

/* ------------------------------- tests ---------------------------------- */

describe('repository naming', () => {
  it('builds a deterministic, Gitea-safe name from the template and student login', () => {
    expect(repositoryName('assignment-04', 'jdu-2400051')).toBe('assignment-04-jdu-2400051');
    expect(repositoryName('Assignment 04!', 'JDU_2400051')).toBe('assignment-04-jdu_2400051');
    expect(repositoryName('', 'jdu-2400051')).toBe('assignment-jdu-2400051');
  });

  it('builds HTTPS and SSH clone URLs for a repository full name', () => {
    expect(cloneUrls('local-github/assignment-04-jdu-2400051', {
      cloneBaseUrl: 'http://gitea:3000/',
      sshCloneBaseUrl: 'ssh://git@gitea:2222/',
    })).toEqual({
      https: 'http://gitea:3000/local-github/assignment-04-jdu-2400051.git',
      ssh: 'ssh://git@gitea:2222/local-github/assignment-04-jdu-2400051.git',
    });
  });
});

describe('provisioning', () => {
  it('isolates two assignments sharing a template and student in distinct repositories', async () => {
    const w = world();
    const secondId = aid('a2');
    w.repo.assignments.set(secondId, { ...w.repo.assignments.get(ASSIGNMENT)!, id: secondId });
    w.repo.assigned.add(`${secondId}:${STUDENT.userId}`);
    const first = await w.service.provision(STUDENT, ASSIGNMENT);
    const second = await w.service.provision(STUDENT, secondId);
    expect(second.repository.giteaRepoFullName).not.toBe(first.repository.giteaRepoFullName);
    expect(second.repository.giteaRepoId).not.toBe(first.repository.giteaRepoId);
    expect(w.gitea.repositories.size).toBe(2);
    expect(w.repo.links.size).toBe(2);
  });
  it('creates one private repository from the assignment template and links it', async () => {
    const w = world();

    const result = await w.service.provision(STUDENT, ASSIGNMENT);

    expect(result.created).toBe(true);
    expect(result.repository).toMatchObject({
      groupAssignmentId: ASSIGNMENT,
      studentId: STUDENT.userId,
      giteaRepoFullName: 'local-github/assignment-04-jdu-2400051-2eb8f8691d1025517b466e82307f1a06c6bff28d659c036fadd8d7638147978e',
      giteaRepoId: 1,
      isPrivate: true,
    });
    expect(w.gitea.createInputs).toEqual([{
      templateOwner: 'local-github',
      templateRepo: 'assignment-04',
      owner: 'local-github',
      name: 'assignment-04-jdu-2400051-2eb8f8691d1025517b466e82307f1a06c6bff28d659c036fadd8d7638147978e',
      private: true,
    }]);
    expect(result.cloneUrls).toEqual({
      https: 'http://gitea:3000/local-github/assignment-04-jdu-2400051-2eb8f8691d1025517b466e82307f1a06c6bff28d659c036fadd8d7638147978e.git',
      ssh: 'ssh://git@gitea:2222/local-github/assignment-04-jdu-2400051-2eb8f8691d1025517b466e82307f1a06c6bff28d659c036fadd8d7638147978e.git',
    });
    expect([...w.repo.links.values()]).toHaveLength(1);
  });

  it('grants the student Write access and protects the default branch', async () => {
    const w = world();

    await w.service.provision(STUDENT, ASSIGNMENT);

    expect(w.gitea.grants).toEqual([{ repo: 'local-github/assignment-04-jdu-2400051-2eb8f8691d1025517b466e82307f1a06c6bff28d659c036fadd8d7638147978e', login: 'jdu-2400051' }]);
    expect(w.gitea.protections).toEqual([{ repo: 'local-github/assignment-04-jdu-2400051-2eb8f8691d1025517b466e82307f1a06c6bff28d659c036fadd8d7638147978e', branch: 'main' }]);
  });

  it('writes an audit event without token or secret material', async () => {
    const w = world();

    const result = await w.service.provision(STUDENT, ASSIGNMENT);

    expect(w.audit.events).toHaveLength(1);
    expect(w.audit.events[0]).toMatchObject({
      actorId: STUDENT.userId,
      eventType: 'repository.provisioned',
      targetType: 'repositoryLink',
      targetId: result.repository.id,
      payload: {
        assignmentId: ASSIGNMENT,
        studentId: STUDENT.userId,
        repoFullName: 'local-github/assignment-04-jdu-2400051-2eb8f8691d1025517b466e82307f1a06c6bff28d659c036fadd8d7638147978e',
        private: true,
      },
    });
    expect(JSON.stringify(w.audit.events)).not.toMatch(/token|secret|password/i);
  });

  it('is idempotent: a duplicate provision returns the existing link without new Gitea calls', async () => {
    const w = world();

    const first = await w.service.provision(STUDENT, ASSIGNMENT);
    const second = await w.service.provision(STUDENT, ASSIGNMENT);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.repository.id).toBe(first.repository.id);
    expect(w.gitea.createInputs).toHaveLength(1);
    expect(w.gitea.grants).toHaveLength(1);
    expect(w.gitea.protections).toHaveLength(1);
    expect(w.repo.links.size).toBe(1);
    expect(w.audit.events).toHaveLength(1);
  });

  it('retries after a partial failure and reuses the already-created repository', async () => {
    const w = world();
    w.gitea.failOn = 'grant';

    await expect(w.service.provision(STUDENT, ASSIGNMENT)).rejects.toMatchObject({
      code: 'INTEGRATION_ERROR',
      status: 502,
    });
    expect(w.repo.links.size).toBe(0);

    w.gitea.failOn = null;
    const result = await w.service.provision(STUDENT, ASSIGNMENT);

    expect(result.created).toBe(true);
    expect(w.gitea.repositories.size).toBe(1);
    expect(w.repo.links.size).toBe(1);
    expect(w.audit.events.map((event) => event.eventType)).toEqual([
      'integration.error',
      'repository.provisioned',
    ]);
  });

  it('refuses to link a repository that Gitea created as public', async () => {
    const w = world();
    w.gitea.forcePublic = true;

    await expect(w.service.provision(STUDENT, ASSIGNMENT)).rejects.toMatchObject({
      code: 'INTEGRATION_ERROR',
      status: 502,
    });
    expect(w.repo.links.size).toBe(0);
    expect(w.gitea.grants).toHaveLength(0);
    expect(w.gitea.protections).toHaveLength(0);
  });

  it('maps a template-resolution failure to an integration error', async () => {
    const w = world();
    w.repo.seedAssignment({ template: null });

    await expect(w.service.provision(STUDENT, ASSIGNMENT)).rejects.toMatchObject({
      code: 'INVALID_STATE',
      status: 409,
    });
    expect(w.gitea.createInputs).toHaveLength(0);
  });

  it('maps Gitea transport failures to INTEGRATION_ERROR and audits the failed step', async () => {
    const w = world();
    w.gitea.failOn = 'create';

    await expect(w.service.provision(STUDENT, ASSIGNMENT)).rejects.toMatchObject({
      code: 'INTEGRATION_ERROR',
      status: 502,
    });
    expect(w.audit.events).toEqual([
      expect.objectContaining({
        eventType: 'integration.error',
        payload: expect.objectContaining({ assignmentId: ASSIGNMENT, studentId: STUDENT.userId, step: 'create_repository' }),
      }),
    ]);
    expect(JSON.stringify(w.audit.events)).not.toMatch(/token|secret|password/i);
  });
});

describe('provisioning authorization', () => {
  it('rejects actors without the student role', async () => {
    const w = world();

    await expect(w.service.provision(TEACHER, ASSIGNMENT)).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect(w.gitea.createInputs).toHaveLength(0);
    expect(w.repo.links.size).toBe(0);
  });

  it('rejects a student who is not assigned to the published assignment', async () => {
    const w = world();

    await expect(w.service.provision(OTHER_STUDENT, ASSIGNMENT)).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect(w.gitea.createInputs).toHaveLength(0);
  });

  it('returns not found for an unknown assignment and invalid state for an unpublished one', async () => {
    const w = world();

    await expect(w.service.provision(STUDENT, aid('missing'))).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });

    w.repo.seedAssignment({ publishedAt: null });
    await expect(w.service.provision(STUDENT, ASSIGNMENT)).rejects.toMatchObject({ code: 'INVALID_STATE', status: 409 });
  });
});

describe('reading the provisioned repository', () => {
  it('returns the existing link with clone URLs for its owner', async () => {
    const w = world();
    await w.service.provision(STUDENT, ASSIGNMENT);

    const result = await w.service.get(STUDENT, ASSIGNMENT);

    expect(result.created).toBe(false);
    expect(result.repository.giteaRepoFullName).toBe('local-github/assignment-04-jdu-2400051-2eb8f8691d1025517b466e82307f1a06c6bff28d659c036fadd8d7638147978e');
    expect(result.cloneUrls.https).toContain('/local-github/assignment-04-jdu-2400051-2eb8f8691d1025517b466e82307f1a06c6bff28d659c036fadd8d7638147978e.git');
  });

  it('returns not found when the student has no repository yet', async () => {
    const w = world();

    await expect(w.service.get(STUDENT, ASSIGNMENT)).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
  });

  it('does not reveal another student link', async () => {
    const w = world();
    await w.service.provision(STUDENT, ASSIGNMENT);

    await expect(w.service.get(OTHER_STUDENT, ASSIGNMENT)).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
  });
});
