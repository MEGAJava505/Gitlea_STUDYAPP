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

/** Optional numeric grade on a 1–5 scale (PLAN_GITEA.md §11.2). */
export type NumericGrade = 1 | 2 | 3 | 4 | 5;

export const NOTIFICATION_CHANNELS = ['in_app', 'email', 'telegram'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export interface NotificationRecord {
  id: string;
  recipientId: UserId;
  eventType: string;
  deduplicationKey: string;
  payload: Record<string, unknown>;
  readAt: number | null;
  createdAt: number;
}

export interface NotificationPreferenceRecord {
  channel: NotificationChannel;
  enabled: boolean;
}

export interface NotificationRepository {
  create(input: Omit<NotificationRecord, 'id' | 'readAt' | 'createdAt'>): Promise<NotificationRecord>;
  list(recipientId: UserId, options?: { unreadOnly?: boolean }): Promise<NotificationRecord[]>;
  markRead(recipientId: UserId, notificationId: string): Promise<boolean>;
  getPreferences(userId: UserId): Promise<NotificationPreferenceRecord[]>;
  setPreference(userId: UserId, channel: NotificationChannel, enabled: boolean): Promise<void>;
}

/** System setting row for toggleable features (e.g. numeric grading). */
export interface SystemSetting {
  id: string;
  key: string;
  value: unknown;
  updatedAt: number;
}

/** Read/write port over the `system_settings` table (key → JSON value). */
export interface SystemSettingsRepository {
  get(key: string): Promise<SystemSetting | null>;
  set(key: string, value: unknown): Promise<void>;
}

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
  idempotencyKey: string;
}

export interface NewSubmission {
  repositoryLinkId: RepositoryLinkId;
  attempt: number;
  commitSha: string;
  protectedRef: string;
  status: AssignmentStatus;
  submittedAt: number;
  idempotencyKey: string;
}

export interface ReviewRecord {
  id: ReviewId;
  submissionId: SubmissionId;
  reviewerId: UserId;
  decision: SubmissionDecision;
  feedback: string;
  /** Numeric grade 1–5; null when numeric grading is disabled or not set. */
  grade: NumericGrade | null;
  /** The single active review for a submission; superseded reviews are kept for audit but inactive. */
  isActive: boolean;
  createdAt: number;
}

/** Read port over the `reviews` table for the grading / review-UI surfaces. */
export interface ReviewQueryRepository {
  /** The currently-active review for a submission, or null when none has been recorded. */
  getLatestActiveReview(submissionId: SubmissionId): Promise<ReviewRecord | null>;
  /** All active reviews whose submissions are in the given set, newest-first. */
  listReviewsForReview(submissionIds: readonly SubmissionId[]): Promise<ReviewRecord[]>;
}

export interface NewReview {
  submissionId: SubmissionId;
  reviewerId: UserId;
  decision: SubmissionDecision;
  feedback: string;
  grade: NumericGrade | null;
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
  | 'submission.conflict'
  | 'submission.auto_failed'
  | 'review.decision'
  | 'review.graded'
  | 'review.denied'
  | 'grading.updated'
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
  getSubmissionByIdempotencyKey(linkId: RepositoryLinkId, key: string): Promise<SubmissionRecord | null>;
  getSubmission(id: SubmissionId): Promise<SubmissionRecord | null>;
  insertSubmission(input: NewSubmission): Promise<SubmissionRecord>;
  /** Commit submission, link status and this success audit in one local transaction.
   * The adapter supplies targetId from the inserted record; no async callback or
   * external AuditLogWriter may run while the transaction is open.
   */
  insertSubmissionWithAudit(input: NewSubmission, audit: Omit<AuditInput, 'targetId'>): Promise<SubmissionRecord>;
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

/** A teacher's inline remark tied to a specific file path and line. */
export interface InlineComment {
  path: string;
  line: number;
  body: string;
}

export interface RequestRevisionInput {
  actor: SessionPrincipal;
  assignmentId: AssignmentId;
  submissionId: SubmissionId;
  feedback: string;
  inlineComment?: InlineComment;
}

export interface ReviewInput {
  actor: SessionPrincipal;
  assignmentId: AssignmentId;
  submissionId: SubmissionId;
  decision: SubmissionDecision;
  feedback: string;
  /** Numeric grade 1–5; only honored for a terminal pass/fail when enabled. */
  grade?: NumericGrade | null;
  inlineComment?: InlineComment;
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
