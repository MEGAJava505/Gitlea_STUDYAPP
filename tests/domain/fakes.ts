import {
  AccessResolver,
  AssignmentId,
  AssignmentRepository,
  AssignmentStatus,
  AssignmentView,
  AuditEvent,
  AuditEventId,
  AuditInput,
  AuditLogWriter,
  AuditRepository,
  Clock,
  NewReview,
  NewSubmission,
  RepositoryLinkId,
  RepositoryLinkRecord,
  ReviewId,
  ReviewRecord,
  Role,
  RoleRepository,
  SessionPrincipal,
  SessionRecord,
  SessionRepository,
  SubmissionId,
  SubmissionRecord,
  UserId,
  UserRecord,
} from '../../src/shared/contracts';
import { GiteaSubmissionPort } from '../../src/server/ports/gitea-submissions';
import { AuditLogWriterImpl } from '../../src/domain/audit';
import { PermissionCheckerImpl } from '../../src/domain/permissions';
import { SessionStoreImpl } from '../../src/domain/auth/session';
import { AssignmentStateMachineImpl } from '../../src/domain/assignments/state-machine';

/* Opaque id helpers */
export const uid = (s: string): UserId => s as UserId;
export const aid = (s: string): AssignmentId => s as AssignmentId;
export const lid = (s: string): RepositoryLinkId => s as RepositoryLinkId;
export const sid = (s: string): SubmissionId => s as SubmissionId;
export const rid = (s: string): ReviewId => s as ReviewId;
export const audId = (s: string): AuditEventId => s as AuditEventId;
export const gid = (s: string) => s as import('../../src/shared/contracts').GroupId;

export function principal(
  userId: UserId,
  roles: Role[],
  login = 'user',
  displayName = 'User',
): SessionPrincipal {
  return { userId, roles, login, displayName };
}

export function makeUser(over: Partial<UserRecord> = {}): UserRecord {
  return {
    id: uid('u'),
    login: 'jdu-0000',
    email: 'a@jdu.uz',
    displayName: 'User',
    giteaId: null,
    ...over,
  };
}

export function makeAssignment(over: Partial<AssignmentView> = {}): AssignmentView {
  return {
    id: aid('a1'),
    courseAssignmentId: 'ca1',
    teacherId: uid('u-teacher'),
    groupId: gid('g1'),
    deadline: 10_000,
    resubmissionPolicy: 'allowed',
    publishedAt: 0,
    ...over,
  };
}

export function makeLink(over: Partial<RepositoryLinkRecord> = {}): RepositoryLinkRecord {
  return {
    id: lid('link1'),
    groupAssignmentId: aid('a1'),
    studentId: uid('u-student'),
    giteaRepoFullName: 'local-github/assignment-01-jdu-2400001',
    giteaRepoId: 1,
    isPrivate: true,
    ...over,
  };
}

/* ---------------------------- role repository ---------------------------- */

export class InMemoryRoleRepository implements RoleRepository {
  private users = new Map<UserId, UserRecord>();
  private roles = new Map<UserId, Role[]>();

  constructor(seed?: { users?: UserRecord[]; roles?: Array<{ userId: UserId; role: Role }> }) {
    for (const u of seed?.users ?? []) this.users.set(u.id, u);
    for (const r of seed?.roles ?? []) {
      const list = this.roles.get(r.userId) ?? [];
      if (!list.includes(r.role)) list.push(r.role);
      this.roles.set(r.userId, list);
    }
  }

  async getUserById(id: UserId): Promise<UserRecord | null> {
    return this.users.get(id) ?? null;
  }

  async listRoles(userId: UserId): Promise<Role[]> {
    return [...(this.roles.get(userId) ?? [])];
  }

  async listAllRoles(): Promise<Array<{ userId: UserId; role: Role }>> {
    const out: Array<{ userId: UserId; role: Role }> = [];
    for (const [userId, roles] of this.roles) {
      for (const role of roles) out.push({ userId, role });
    }
    return out;
  }

  async insertRole(userId: UserId, role: Role): Promise<void> {
    const list = this.roles.get(userId) ?? [];
    if (!list.includes(role)) list.push(role);
    this.roles.set(userId, list);
  }

  async deleteRole(userId: UserId, role: Role): Promise<void> {
    const list = (this.roles.get(userId) ?? []).filter((r) => r !== role);
    this.roles.set(userId, list);
  }
}

/* --------------------------- session repository -------------------------- */

export class InMemorySessionRepository implements SessionRepository {
  rows = new Map<string, SessionRecord>();

  async insert(record: SessionRecord): Promise<void> {
    this.rows.set(record.tokenHash, record);
  }

  async findByTokenHash(hash: string): Promise<SessionRecord | null> {
    return this.rows.get(hash) ?? null;
  }

  async deleteByTokenHash(hash: string): Promise<void> {
    this.rows.delete(hash);
  }
}

/* ---------------------------- audit repository --------------------------- */

export class InMemoryAuditRepository implements AuditRepository {
  events: AuditEvent[] = [];

  async append(event: AuditEvent): Promise<AuditEventId> {
    this.events.push(event);
    return event.id;
  }
}

/* -------------------------- assignment repository ------------------------ */

export class InMemoryAssignmentRepository implements AssignmentRepository, AccessResolver {
  assignments = new Map<AssignmentId, AssignmentView>();
  links = new Map<RepositoryLinkId, RepositoryLinkRecord>();
  private linkByAssignmentStudent = new Map<string, RepositoryLinkRecord>();
  submissions = new Map<SubmissionId, SubmissionRecord>();
  private submissionsByLink = new Map<RepositoryLinkId, SubmissionRecord[]>();
  reviews = new Map<ReviewId, ReviewRecord>();
  private seq = { submission: 0, review: 0 };
  private clock: Clock;

  constructor(clock: Clock = () => Date.now(), private readonly submissionAudit = new InMemoryAuditRepository()) {
    this.clock = clock;
  }

  seedAssignment(assignment: AssignmentView): void {
    this.assignments.set(assignment.id, assignment);
  }

  seedLink(link: RepositoryLinkRecord): void {
    this.links.set(link.id, link);
    this.linkByAssignmentStudent.set(`${link.groupAssignmentId}:${link.studentId}`, link);
  }

  async getAssignment(id: AssignmentId): Promise<AssignmentView | null> {
    return this.assignments.get(id) ?? null;
  }

  async getRepositoryLink(assignmentId: AssignmentId, studentId: UserId): Promise<RepositoryLinkRecord | null> {
    return this.linkByAssignmentStudent.get(`${assignmentId}:${studentId}`) ?? null;
  }

  async getRepositoryLinkById(id: RepositoryLinkId): Promise<RepositoryLinkRecord | null> {
    return this.links.get(id) ?? null;
  }

  async listSubmissions(linkId: RepositoryLinkId): Promise<SubmissionRecord[]> {
    return [...(this.submissionsByLink.get(linkId) ?? [])];
  }

  async getSubmissionByIdempotencyKey(linkId: RepositoryLinkId, key: string): Promise<SubmissionRecord | null> {
    return (await this.listSubmissions(linkId)).find((s) => s.idempotencyKey === key) ?? null;
  }

  async getSubmission(id: SubmissionId): Promise<SubmissionRecord | null> {
    return this.submissions.get(id) ?? null;
  }

  async insertSubmission(input: NewSubmission): Promise<SubmissionRecord> {
    this.seq.submission += 1;
    const record: SubmissionRecord = { id: sid(`sub-${this.seq.submission}`), ...input };
    this.submissions.set(record.id, record);
    const list = this.submissionsByLink.get(input.repositoryLinkId) ?? [];
    list.push(record);
    this.submissionsByLink.set(input.repositoryLinkId, list);
    return record;
  }

  async insertSubmissionWithAudit(input: NewSubmission, audit: Omit<AuditInput, 'targetId'>): Promise<SubmissionRecord> {
    // Stage the record until audit succeeds, mirroring the adapter's rollback.
    const record: SubmissionRecord = { id: sid(`sub-${++this.seq.submission}`), ...input };
    await makeAuditWriter(this.submissionAudit, this.clock).append({ ...audit, targetId: record.id });
    this.submissions.set(record.id, record);
    const list = this.submissionsByLink.get(input.repositoryLinkId) ?? [];
    list.push(record);
    this.submissionsByLink.set(input.repositoryLinkId, list);
    return record;
  }

  async updateSubmissionStatus(id: SubmissionId, status: AssignmentStatus): Promise<void> {
    const existing = this.submissions.get(id);
    if (!existing) return;
    const updated = { ...existing, status };
    this.submissions.set(id, updated);
    const list = this.submissionsByLink.get(existing.repositoryLinkId) ?? [];
    const idx = list.findIndex((s) => s.id === id);
    if (idx >= 0) list[idx] = updated;
  }

  async insertReview(input: NewReview): Promise<ReviewRecord> {
    this.seq.review += 1;
    const record: ReviewRecord = {
      id: rid(`rev-${this.seq.review}`),
      createdAt: this.clock(),
      ...input,
    };
    this.reviews.set(record.id, record);
    return record;
  }
}

/* ------------------------------ gitea port ------------------------------- */

export class FakeGitea implements GiteaSubmissionPort {
  commits = new Set<string>();
  snapshots: Array<{ repoFullName: string; attempt: number; commitSha: string; protectedRef: string }> = [];
  failSnapshot = false;
  failPullRequest = false;
  pullRequests: Array<{ repoFullName: string; protectedRef: string; number: number }> = [];

  async hasCommit(input: { repoFullName: string; commitSha: string }): Promise<boolean> {
    return this.commits.has(input.commitSha);
  }

  async createProtectedSnapshot(input: {
    repoFullName: string;
    commitSha: string;
    attempt: number;
  }): Promise<{ protectedRef: string }> {
    if (this.failSnapshot) throw new Error('snapshot boom');
    const protectedRef = `submission/${input.attempt}`;
    this.snapshots.push({ ...input, protectedRef });
    return { protectedRef };
  }

  async ensureReviewPullRequest(input: {
    repoFullName: string;
    protectedRef: string;
    attempt: number;
  }): Promise<{ number: number }> {
    if (this.failPullRequest) throw new Error('pull request boom');
    const existing = this.pullRequests.find(
      (pr) => pr.repoFullName === input.repoFullName && pr.protectedRef === input.protectedRef,
    );
    if (existing) return { number: existing.number };
    const number = this.pullRequests.length + 1;
    this.pullRequests.push({ repoFullName: input.repoFullName, protectedRef: input.protectedRef, number });
    return { number };
  }

  async getExistingSubmission(input: {
    repoFullName: string;
    attempt: number;
  }): Promise<{ protectedRef: string; commitSha: string } | null> {
    const found = this.snapshots.find(
      (s) => s.repoFullName === input.repoFullName && s.attempt === input.attempt,
    );
    return found ? { protectedRef: found.protectedRef, commitSha: found.commitSha } : null;
  }
}

/* ------------------------------ wiring helper ---------------------------- */

export function makeAuditWriter(repo: AuditRepository, clock: Clock): AuditLogWriter {
  return new AuditLogWriterImpl({ audit: repo, now: clock });
}

export function makeSessionStore(
  repo: SessionRepository,
  clock: Clock,
  secureCookies = false,
): SessionStoreImpl {
  return new SessionStoreImpl({ sessions: repo, now: clock, secureCookies });
}

export interface AssignmentWorld {
  repo: InMemoryAssignmentRepository;
  gitea: FakeGitea;
  auditRepo: InMemoryAuditRepository;
  audit: AuditLogWriter;
  permissions: PermissionCheckerImpl;
  machine: AssignmentStateMachineImpl;
  now: Clock;
  setNow: (t: number) => void;
  student: UserId;
  teacher: UserId;
  assignment: AssignmentView;
  link: RepositoryLinkRecord;
}

export function makeAssignmentWorld(overrides?: {
  deadline?: number;
  resubmissionPolicy?: AssignmentView['resubmissionPolicy'];
  teacherId?: UserId;
  studentId?: UserId;
  commitSha?: string;
  nowMs?: number;
}): AssignmentWorld {
  let current = overrides?.nowMs ?? 500;
  const now: Clock = () => current;
  const setNow = (t: number) => {
    current = t;
  };

  const student = overrides?.studentId ?? uid('u-student');
  const teacher = overrides?.teacherId ?? uid('u-teacher');
  const assignment = makeAssignment({
    id: aid('a1'),
    teacherId: teacher,
    deadline: overrides?.deadline ?? 10_000,
    resubmissionPolicy: overrides?.resubmissionPolicy ?? 'allowed',
  });
  const link = makeLink({
    id: lid('link1'),
    groupAssignmentId: assignment.id,
    studentId: student,
  });

  const auditRepo = new InMemoryAuditRepository();
  const repo = new InMemoryAssignmentRepository(now, auditRepo);
  repo.seedAssignment(assignment);
  repo.seedLink(link);

  const gitea = new FakeGitea();
  gitea.commits.add(overrides?.commitSha ?? 'abc123');

  const audit = makeAuditWriter(auditRepo, now);
  const permissions = new PermissionCheckerImpl({ resolver: repo, audit });
  const machine = new AssignmentStateMachineImpl({ repo, gitea, permissions, audit, now });

  return {
    repo,
    gitea,
    auditRepo,
    audit,
    permissions,
    machine,
    now,
    setNow,
    student,
    teacher,
    assignment,
    link,
  };
}
