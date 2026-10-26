/**
 * Shared contracts for the Local GitHub MVP (Task C).
 *
 * This module owns every opaque ID alias, role/status literal, the session
 * principal, permission names, and the typed service input/output shapes that
 * the domain, server, and API layers agree on.
 *
 * The domain services are dependency-injected against the repository ports
 * declared here. Those ports are the exact seam that Task B's database layer
 * (`src/db/client.ts` `db`, `src/db/schema.ts` tables) satisfies at
 * integration time; Task C intentionally does not import the ORM directly so
 * that the domain remains unit-testable with in-memory fakes.
 */

/* ------------------------------------------------------------------ *
 * Opaque identifiers
 * ------------------------------------------------------------------ */

declare const __brand: unique symbol;
type Brand<B extends string> = { readonly [__brand]: B };

export type UserId = string & Brand<'UserId'>;
export type GroupId = string & Brand<'GroupId'>;
export type CourseId = string & Brand<'CourseId'>;
export type AssignmentId = string & Brand<'AssignmentId'>;
export type RepositoryLinkId = string & Brand<'RepositoryLinkId'>;
export type SubmissionId = string & Brand<'SubmissionId'>;
export type ReviewId = string & Brand<'ReviewId'>;
export type AuditEventId = string & Brand<'AuditEventId'>;

/* ------------------------------------------------------------------ *
 * Literals
 * ------------------------------------------------------------------ */

export const ROLES = ['student', 'teacher', 'admin', 'owner'] as const;
export type Role = (typeof ROLES)[number];

export const ASSIGNMENT_STATUSES = [
  'in_progress',
  'submitted',
  'revision_required',
  'passed',
  'failed',
] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

/** Final review decision. Revision requests are a separate transition. */
export type SubmissionDecision = 'pass' | 'fail';

export type ResubmissionPolicy = 'allowed' | 'forbidden';

/* ------------------------------------------------------------------ *
 * Clock
 * ------------------------------------------------------------------ */

/** Epoch-millisecond clock. Injectable so deadline/expiry tests are deterministic. */
export type Clock = () => number;

/* ------------------------------------------------------------------ *
 * Principal & permissions
 * ------------------------------------------------------------------ */

export interface SessionPrincipal {
  userId: UserId;
  login: string;
  displayName: string;
  roles: Role[];
}

export type Permission =
  | 'session:read'
  | 'identity:read'
  | 'identity:list_roles'
  | 'identity:grant_role'
  | 'identity:revoke_role'
  | 'assignment:read'
  | 'assignment:submit'
  | 'assignment:review'
  | 'submission:read'
  | 'audit:read';

/** Permissions whose denial must be written to the audit log. */
export const SENSITIVE_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  'identity:grant_role',
  'identity:revoke_role',
  'assignment:submit',
  'assignment:review',
  'submission:read',
  'audit:read',
]);

export type ResourceRef =
  | { type: 'assignment'; id: AssignmentId }
  | { type: 'repositoryLink'; id: RepositoryLinkId }
  | { type: 'submission'; id: SubmissionId }
  | { type: 'group'; id: GroupId }
  | { type: 'course'; id: CourseId };

/* ------------------------------------------------------------------ *
 * Domain records
 * ------------------------------------------------------------------ */

export interface UserRecord {
  id: UserId;
  login: string;
  email: string;
  displayName: string;
  giteaId: number | null;
}

export interface UserRoleRecord {
  userId: UserId;
  role: Role;
}

export interface SessionRecord {
  /** SHA-256 hex of the opaque token. The raw token is never persisted. */
  tokenHash: string;
  userId: UserId;
  /** Absolute epoch-ms expiry. */
  expiresAt: number;
  createdAt: number;
}

export interface ValidSession {
  userId: UserId;
  expiresAt: number;
  createdAt: number;
}

export interface CookieSpec {
  name: string;
  value: string;
  maxAge: number;
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax';
  path: string;
}

export interface RepositoryLinkRecord {
  id: RepositoryLinkId;
  groupAssignmentId: AssignmentId;
  studentId: UserId;
  giteaRepoFullName: string;
  giteaRepoId: number | null;
  isPrivate: boolean;
}

export interface AssignmentView {
  id: AssignmentId;
  courseAssignmentId: string;
  /** Teacher responsible for this published assignment (course assignment author). */
  teacherId: UserId;
  groupId: GroupId;
  deadline: number;
  resubmissionPolicy: ResubmissionPolicy;
  publishedAt: number;
}

export interface SubmissionRecord {
  id: SubmissionId;
  repositoryLinkId: RepositoryLinkId;
  attempt: number;
  commitSha: string;
  protectedRef: string;
  status: AssignmentStatus;
  submittedAt: number;
}

export interface NewSubmission {
  repositoryLinkId: RepositoryLinkId;
  attempt: number;
  commitSha: string;
  protectedRef: string;
  status: AssignmentStatus;
  submittedAt: number;
}

export interface ReviewRecord {
  id: ReviewId;
  submissionId: SubmissionId;
  reviewerId: UserId;
  decision: SubmissionDecision;
  feedback: string;
  createdAt: number;
}

export interface NewReview {
  submissionId: SubmissionId;
  reviewerId: UserId;
  decision: SubmissionDecision;
  feedback: string;
}

/* ------------------------------------------------------------------ *
 * Audit
 * ------------------------------------------------------------------ */

export type AuditEventType =
  | 'role.granted'
  | 'role.revoked'
  | 'role.denied'
  | 'activation.conflict'
  | 'activation.succeeded'
  | 'group.created'
  | 'group.member_added'
  | 'group.member_removed'
  | 'group.course_assigned'
  | 'repository.provisioned'
  | 'submission.created'
  | 'submission.idempotent'
  | 'submission.auto_failed'
  | 'review.decision'
  | 'review.denied'
  | 'permission.denied'
  | 'integration.error';

export interface AuditEvent {
  id: AuditEventId;
  actorId: UserId | null;
  eventType: AuditEventType;
  targetType: string;
  targetId: string;
  payload: Record<string, unknown>;
  createdAt: number;
}

export interface AuditInput {
  actorId: UserId | null;
  eventType: AuditEventType;
  targetType: string;
  targetId: string;
  payload: Record<string, unknown>;
}

/* ------------------------------------------------------------------ *
 * Repository ports (backed by Task B's Db at integration time)
 * ------------------------------------------------------------------ */

export interface RoleRepository {
  getUserById(id: UserId): Promise<UserRecord | null>;
  listRoles(userId: UserId): Promise<Role[]>;
  listAllRoles(): Promise<UserRoleRecord[]>;
  insertRole(userId: UserId, role: Role): Promise<void>;
  deleteRole(userId: UserId, role: Role): Promise<void>;
}

export interface SessionRepository {
  insert(record: SessionRecord): Promise<void>;
  findByTokenHash(hash: string): Promise<SessionRecord | null>;
  deleteByTokenHash(hash: string): Promise<void>;
}

export interface AuditRepository {
  append(event: AuditEvent): Promise<AuditEventId>;
}

export interface AssignmentRepository {
  getAssignment(id: AssignmentId): Promise<AssignmentView | null>;
  getRepositoryLink(assignmentId: AssignmentId, studentId: UserId): Promise<RepositoryLinkRecord | null>;
  getRepositoryLinkById(id: RepositoryLinkId): Promise<RepositoryLinkRecord | null>;
  listSubmissions(linkId: RepositoryLinkId): Promise<SubmissionRecord[]>;
  getSubmission(id: SubmissionId): Promise<SubmissionRecord | null>;
  insertSubmission(input: NewSubmission): Promise<SubmissionRecord>;
  updateSubmissionStatus(id: SubmissionId, status: AssignmentStatus): Promise<void>;
  insertReview(input: NewReview): Promise<ReviewRecord>;
}

/** Read-only surface used by the permission checker (structurally satisfied by AssignmentRepository). */
export interface AccessResolver {
  getAssignment(id: AssignmentId): Promise<AssignmentView | null>;
  getRepositoryLink(assignmentId: AssignmentId, studentId: UserId): Promise<RepositoryLinkRecord | null>;
  getRepositoryLinkById(id: RepositoryLinkId): Promise<RepositoryLinkRecord | null>;
  getSubmission(id: SubmissionId): Promise<SubmissionRecord | null>;
}

/* ------------------------------------------------------------------ *
 * Service input / output types
 * ------------------------------------------------------------------ */

export interface GrantRoleInput {
  actorId: UserId;
  targetUserId: UserId;
  role: Role;
}

export interface RevokeRoleInput {
  actorId: UserId;
  targetUserId: UserId;
  role: Role;
}

export interface CreateSessionInput {
  principal: SessionPrincipal;
  ttlMs: number;
}

export interface SubmitInput {
  actor: SessionPrincipal;
  assignmentId: AssignmentId;
  commitSha: string;
  idempotencyKey: string;
}

export interface SubmitResult {
  submission: SubmissionRecord;
  alreadyExisted: boolean;
}

export interface RequestRevisionInput {
  actor: SessionPrincipal;
  assignmentId: AssignmentId;
  submissionId: SubmissionId;
  feedback: string;
}

export interface ReviewInput {
  actor: SessionPrincipal;
  assignmentId: AssignmentId;
  submissionId: SubmissionId;
  decision: SubmissionDecision;
  feedback: string;
}

export interface ReviewResult {
  review: ReviewRecord | null;
  status: AssignmentStatus;
}

/* ------------------------------------------------------------------ *
 * Service interfaces
 * ------------------------------------------------------------------ */

export interface IdentityService {
  getUser(userId: UserId): Promise<UserRecord | null>;
  listRoles(userId: UserId): Promise<Role[]>;
  grantRole(input: GrantRoleInput): Promise<void>;
  revokeRole(input: RevokeRoleInput): Promise<void>;
}

export interface SessionStore {
  create(principal: SessionPrincipal, ttlMs: number): Promise<{ token: string; cookie: CookieSpec }>;
  get(token: string): Promise<ValidSession | null>;
  revoke(token: string): Promise<void>;
}

export interface PermissionChecker {
  can(actor: SessionPrincipal, permission: Permission, resource?: ResourceRef): Promise<boolean>;
  assert(actor: SessionPrincipal, permission: Permission, resource?: ResourceRef): Promise<void>;
}

export interface AuditLogWriter {
  append(input: AuditInput): Promise<AuditEventId>;
}

export interface AssignmentStateMachine {
  submit(input: SubmitInput): Promise<SubmitResult>;
  requestRevision(input: RequestRevisionInput): Promise<ReviewResult>;
  pass(input: ReviewInput): Promise<ReviewResult>;
  fail(input: ReviewInput): Promise<ReviewResult>;
}

/* ------------------------------------------------------------------ *
 * Errors & the stable JSON error contract
 * ------------------------------------------------------------------ */

export class DomainError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: string, message: string, status: number, details?: unknown) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const errors = {
  unauthenticated: () => new DomainError('UNAUTHENTICATED', 'Authentication required', 401),
  forbidden: (message = 'Forbidden') => new DomainError('FORBIDDEN', message, 403),
  notFound: (what = 'resource') => new DomainError('NOT_FOUND', `${what} not found`, 404),
  invalidInput: (message: string) => new DomainError('INVALID_INPUT', message, 400),
  conflict: (message: string) => new DomainError('CONFLICT', message, 409),
  deadlineExpired: () => new DomainError('DEADLINE_EXPIRED', 'The assignment deadline has passed', 409),
  invalidState: (message: string) => new DomainError('INVALID_STATE', message, 409),
  integration: (message: string) => new DomainError('INTEGRATION_ERROR', message, 502),
} as const;

export interface ApiErrorBody {
  error: { code: string; message: string };
}

/** Maps any thrown value to the stable JSON error contract (code + status). */
export function toErrorBody(err: unknown): { status: number; body: ApiErrorBody } {
  if (err instanceof DomainError) {
    return { status: err.status, body: { error: { code: err.code, message: err.message } } };
  }
  return {
    status: 500,
    body: { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
  };
}
