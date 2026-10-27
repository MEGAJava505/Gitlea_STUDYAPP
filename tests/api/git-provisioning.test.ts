import { beforeEach, describe, expect, it } from 'vitest';
import { configureServices } from '../../src/server/auth-context';
import { GET, POST } from '../../src/app/api/v1/assignments/[assignmentId]/repositories/route';
import {
  ProvisioningService,
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
  UserId,
} from '../../src/shared/contracts';
import { IdentityServiceImpl } from '../../src/domain/identity';
import {
  InMemoryAuditRepository,
  InMemoryRoleRepository,
  InMemorySessionRepository,
  gid,
  makeAuditWriter,
  makeSessionStore,
  uid,
} from '../domain/fakes';

const now = () => 5_000;
const aid = (s: string): AssignmentId => s as AssignmentId;
const lid = (s: string): RepositoryLinkId => s as RepositoryLinkId;

const tokens: Record<'student' | 'other', string> = { student: '', other: '' };
const TEMPLATE: AssignmentTemplate = { owner: 'local-github', repo: 'assignment-04' };
const ASSIGNMENT = aid('assignment-1');
const EXPECTED_REPOSITORY = 'local-github/assignment-04-jdu-2400051-b9bdab61ee87a7a6669b5a9aa6c4258ed6f4f881c3d5a245c8d9eb64f4b558ce';

class FakeRepository implements ProvisioningRepository {
  assignments = new Map<AssignmentId, ProvisioningAssignment>();
  links = new Map<string, RepositoryLinkRecord>();
  assigned = new Set<string>();
  private seq = 0;

  constructor() {
    this.assignments.set(ASSIGNMENT, {
      id: ASSIGNMENT,
      groupId: gid('group-1'),
      publishedAt: 4_000,
      template: TEMPLATE,
    });
    this.assigned.add(`${ASSIGNMENT}:${uid('student')}`);
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
    const key = `${input.groupAssignmentId}:${input.studentId}`;
    const existing = this.links.get(key);
    if (existing) return existing;
    this.seq += 1;
    const link: RepositoryLinkRecord = { id: lid(`link-${this.seq}`), ...input };
    this.links.set(key, link);
    return link;
  }
}

class FakeGitea implements GiteaProvisioningPort {
  private seq = 0;
  private repositories = new Map<string, { id: number; fullName: string; private: boolean; defaultBranch: string }>();

  async createRepositoryFromTemplate(input: {
    templateOwner: string;
    templateRepo: string;
    owner: string;
    name: string;
    private: true;
  }): Promise<{ id: number; fullName: string; private: boolean; defaultBranch: string }> {
    const fullName = `${input.owner}/${input.name}`;
    const existing = this.repositories.get(fullName);
    if (existing) return existing;
    this.seq += 1;
    const repository = { id: this.seq, fullName, private: true, defaultBranch: 'main' };
    this.repositories.set(fullName, repository);
    return repository;
  }

  async grantWriteAccess(): Promise<void> {}
  async protectBranch(): Promise<void> {}

  async createPullRequest(): Promise<{ number: number }> {
    throw new Error('not used');
  }

  async addComment(): Promise<void> {
    throw new Error('not used');
  }
}

class FakeAudit implements ProvisioningAudit {
  events: Array<{ eventType: ProvisioningAuditEventType }> = [];

  async append(input: {
    actorId: UserId | null;
    eventType: ProvisioningAuditEventType;
    targetType: string;
    targetId: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    this.events.push({ eventType: input.eventType });
  }
}

function request(url: string, init: { method?: string; token?: string } = {}) {
  return new Request(new URL(url, 'http://localhost'), {
    method: init.method ?? 'GET',
    headers: init.token ? { cookie: `session=${init.token}` } : {},
  });
}

const params = { params: Promise.resolve({ assignmentId: 'assignment-1' }) };
let repository: FakeRepository;

beforeEach(async () => {
  const roles = new InMemoryRoleRepository({
    users: [
      { id: uid('student'), login: 'jdu-2400051', email: 'student@example.com', displayName: 'Student', giteaId: null },
      { id: uid('other'), login: 'jdu-2400052', email: 'other@example.com', displayName: 'Other', giteaId: null },
    ],
    roles: [{ userId: uid('student'), role: 'student' }, { userId: uid('other'), role: 'student' }],
  });
  const sessions = makeSessionStore(new InMemorySessionRepository(), now);
  tokens.student = (await sessions.create(
    { userId: uid('student'), login: 'jdu-2400051', displayName: 'Student', roles: ['student'] },
    60_000,
  )).token;
  tokens.other = (await sessions.create(
    { userId: uid('other'), login: 'jdu-2400052', displayName: 'Other', roles: ['student'] },
    60_000,
  )).token;

  const audit = makeAuditWriter(new InMemoryAuditRepository(), now);
  const identities = new IdentityServiceImpl({ roles, audit });
  repository = new FakeRepository();
  const provisioning = new ProvisioningService({
    repo: repository,
    gitea: new FakeGitea(),
    audit: new FakeAudit(),
    now,
    organization: 'local-github',
    cloneBaseUrl: 'http://gitea:3000',
    sshCloneBaseUrl: 'ssh://git@gitea:2222',
  });

  configureServices({
    sessions,
    identities,
    audit,
    provisioning,
  } as Parameters<typeof configureServices>[0]);
});

describe('POST /assignments/:assignmentId/repositories', () => {
  it('rejects unauthenticated callers with 401', async () => {
    const res = await POST(request('/api/v1/assignments/assignment-1/repositories', { method: 'POST' }), params);

    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('UNAUTHENTICATED');
  });

  it('forbids a student who is not assigned to the assignment', async () => {
    const res = await POST(request('/api/v1/assignments/assignment-1/repositories', {
      method: 'POST',
      token: tokens.other,
    }), params);

    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('FORBIDDEN');
  });

  it('creates the repository on the first call and returns the same link on retry', async () => {
    const first = await POST(request('/api/v1/assignments/assignment-1/repositories', {
      method: 'POST',
      token: tokens.student,
    }), params);
    expect(first.status).toBe(201);
    const firstBody = await first.json();
    expect(firstBody).toMatchObject({
      created: true,
      repository: {
        groupAssignmentId: 'assignment-1',
        studentId: 'student',
        giteaRepoFullName: EXPECTED_REPOSITORY,
        isPrivate: true,
      },
      cloneUrls: {
        https: `http://gitea:3000/${EXPECTED_REPOSITORY}.git`,
        ssh: `ssh://git@gitea:2222/${EXPECTED_REPOSITORY}.git`,
      },
    });

    const second = await POST(request('/api/v1/assignments/assignment-1/repositories', {
      method: 'POST',
      token: tokens.student,
    }), params);
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.created).toBe(false);
    expect(secondBody.repository.id).toBe(firstBody.repository.id);
  });

  it('creates distinct repositories for two assignments using the same template and student', async () => {
    const otherAssignment = aid('assignment-2');
    repository.assignments.set(otherAssignment, { ...repository.assignments.get(ASSIGNMENT)!, id: otherAssignment });
    repository.assigned.add(`${otherAssignment}:${uid('student')}`);
    const first = await POST(request('/api/v1/assignments/assignment-1/repositories', { method: 'POST', token: tokens.student }), params);
    const second = await POST(request('/api/v1/assignments/assignment-2/repositories', { method: 'POST', token: tokens.student }), { params: Promise.resolve({ assignmentId: otherAssignment }) });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const firstBody = await first.json();
    const secondBody = await second.json();
    expect(secondBody.repository.groupAssignmentId).toBe(otherAssignment);
    expect(secondBody.repository.id).not.toBe(firstBody.repository.id);
    expect(secondBody.repository.giteaRepoFullName).not.toBe(firstBody.repository.giteaRepoFullName);
    expect(secondBody.cloneUrls.https).toBe(`http://gitea:3000/${secondBody.repository.giteaRepoFullName}.git`);
  });
});

describe('GET /assignments/:assignmentId/repositories', () => {
  it('rejects unauthenticated callers with 401', async () => {
    const res = await GET(request('/api/v1/assignments/assignment-1/repositories'), params);

    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('UNAUTHENTICATED');
  });

  it('returns the caller link with clone URLs', async () => {
    await POST(request('/api/v1/assignments/assignment-1/repositories', {
      method: 'POST',
      token: tokens.student,
    }), params);

    const res = await GET(request('/api/v1/assignments/assignment-1/repositories', { token: tokens.student }), params);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.repository.giteaRepoFullName).toBe(EXPECTED_REPOSITORY);
    expect(body.cloneUrls.https).toBe(`http://gitea:3000/${EXPECTED_REPOSITORY}.git`);
  });
});
