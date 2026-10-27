import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { check, index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const roles = ['student', 'teacher', 'admin', 'owner'] as const;
export const assignmentStatuses = ['in_progress', 'submitted', 'revision_required', 'passed', 'failed'] as const;
export const activationStates = ['pending', 'active', 'disabled'] as const;
export const membershipStates = ['active', 'inactive'] as const;
export const reviewDecisions = ['revision_required', 'passed', 'failed'] as const;
export const testVisibilities = ['visible', 'hidden'] as const;
export const testRunStatuses = ['queued', 'running', 'passed', 'failed', 'error'] as const;
export const notificationChannels = ['in_app', 'email', 'telegram'] as const;

const epochMilliseconds = sql`(CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))`;
const id = () => text('id').primaryKey().notNull().$defaultFn(randomUUID);
const createdAt = () => integer('created_at').notNull().default(epochMilliseconds);
const updatedAt = () => integer('updated_at').notNull().default(epochMilliseconds).$onUpdateFn(() => Date.now());
const timestamps = () => ({ createdAt: createdAt(), updatedAt: updatedAt() });
const restrict = { onDelete: 'restrict', onUpdate: 'restrict' } as const;

export const users = sqliteTable('users', {
  id: id(),
  giteaId: integer('gitea_id').notNull(),
  login: text('login').notNull(),
  email: text('email').notNull(),
  displayName: text('display_name').notNull(),
  ...timestamps(),
}, (table) => [
  uniqueIndex('users_gitea_id_unique').on(table.giteaId),
  uniqueIndex('users_login_unique').on(table.login),
  uniqueIndex('users_normalized_email_unique').on(sql`lower(trim(${table.email}))`),
  check('users_email_nonempty', sql`length(trim(${table.email})) > 0`),
]);

export const userRoles = sqliteTable('user_roles', {
  id: id(),
  userId: text('user_id').notNull().references(() => users.id, restrict),
  role: text('role', { enum: roles }).notNull(),
  createdAt: createdAt(),
}, (table) => [
  uniqueIndex('user_roles_user_role_unique').on(table.userId, table.role),
  check('user_roles_role_check', sql`${table.role} IN ('student', 'teacher', 'admin', 'owner')`),
]);

export const sessions = sqliteTable('sessions', {
  tokenHash: text('token_hash').primaryKey().notNull(),
  userId: text('user_id').notNull().references(() => users.id, restrict),
  expiresAt: integer('expires_at').notNull(),
  createdAt: integer('created_at').notNull(),
}, (table) => [index('sessions_user_idx').on(table.userId), index('sessions_expiry_idx').on(table.expiresAt)]);

export const studentProfiles = sqliteTable('student_profiles', {
  id: id(),
  userId: text('user_id').notNull().references(() => users.id, restrict),
  studentId: text('student_id').notNull(),
  expectedEmail: text('expected_email').notNull(),
  activationState: text('activation_state', { enum: activationStates }).notNull().default('pending'),
  ...timestamps(),
}, (table) => [
  uniqueIndex('student_profiles_user_unique').on(table.userId),
  uniqueIndex('student_profiles_student_id_unique').on(table.studentId),
  uniqueIndex('student_profiles_normalized_email_unique').on(sql`lower(trim(${table.expectedEmail}))`),
  check('student_profiles_email_nonempty', sql`length(trim(${table.expectedEmail})) > 0`),
  check('student_profiles_activation_state_check', sql`${table.activationState} IN ('pending', 'active', 'disabled')`),
]);

export const activations = sqliteTable('activations', {
  id: id(),
  studentProfileId: text('student_profile_id').notNull().references(() => studentProfiles.id, restrict),
  tokenHmac: text('token_hmac').notNull(),
  expiresAt: integer('expires_at').notNull(),
  usedAt: integer('used_at'),
  createdAt: createdAt(),
}, (table) => [
  uniqueIndex('activations_active_token_unique').on(table.tokenHmac).where(sql`${table.usedAt} IS NULL`),
  index('activations_student_profile_idx').on(table.studentProfileId),
  index('activations_expiry_idx').on(table.expiresAt),
]);

export const groups = sqliteTable('groups', {
  id: id(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  ...timestamps(),
}, (table) => [uniqueIndex('groups_code_unique').on(table.code)]);

export const groupMembers = sqliteTable('group_members', {
  id: id(),
  groupId: text('group_id').notNull().references(() => groups.id, restrict),
  userId: text('user_id').notNull().references(() => users.id, restrict),
  state: text('state', { enum: membershipStates }).notNull().default('active'),
  joinedAt: integer('joined_at').notNull().default(epochMilliseconds),
  leftAt: integer('left_at'),
  ...timestamps(),
}, (table) => [
  uniqueIndex('group_members_group_user_unique').on(table.groupId, table.userId),
  index('group_members_user_idx').on(table.userId),
  check('group_members_state_check', sql`${table.state} IN ('active', 'inactive')`),
  check('group_members_dates_check', sql`${table.leftAt} IS NULL OR ${table.leftAt} >= ${table.joinedAt}`),
]);

export const courses = sqliteTable('courses', {
  id: id(),
  ownerId: text('owner_id').notNull().references(() => users.id, restrict),
  slug: text('slug').notNull(),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  publishedAt: integer('published_at'),
  ...timestamps(),
}, (table) => [
  uniqueIndex('courses_slug_unique').on(table.slug),
  index('courses_owner_idx').on(table.ownerId),
]);

export const courseGroups = sqliteTable('course_groups', {
  id: id(),
  courseId: text('course_id').notNull().references(() => courses.id, restrict),
  groupId: text('group_id').notNull().references(() => groups.id, restrict),
  createdAt: createdAt(),
}, (table) => [
  uniqueIndex('course_groups_pair_unique').on(table.courseId, table.groupId),
  index('course_groups_group_idx').on(table.groupId),
]);

export const lessons = sqliteTable('lessons', {
  id: id(),
  courseId: text('course_id').notNull().references(() => courses.id, restrict),
  position: integer('position').notNull(),
  title: text('title').notNull(),
  contentMetadata: text('content_metadata', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default(sql`'{}'`),
  ...timestamps(),
}, (table) => [
  uniqueIndex('lessons_course_position_unique').on(table.courseId, table.position),
  check('lessons_position_check', sql`${table.position} >= 0`),
  check('lessons_content_json_check', sql`json_valid(${table.contentMetadata})`),
]);

export const lessonPublications = sqliteTable('lesson_publications', {
  id: id(),
  lessonId: text('lesson_id').notNull().references(() => lessons.id, restrict),
  groupId: text('group_id').notNull().references(() => groups.id, restrict),
  publishedAt: integer('published_at').notNull(),
  ...timestamps(),
}, (table) => [
  uniqueIndex('lesson_publications_pair_unique').on(table.lessonId, table.groupId),
  index('lesson_publications_group_idx').on(table.groupId),
]);

export const courseAssignments = sqliteTable('course_assignments', {
  id: id(),
  courseId: text('course_id').notNull().references(() => courses.id, restrict),
  authorId: text('author_id').notNull().references(() => users.id, restrict),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  allowResubmission: integer('allow_resubmission', { mode: 'boolean' }).notNull().default(false),
  templateOwner: text('template_owner'),
  templateRepo: text('template_repo'),
  ...timestamps(),
}, (table) => [
  index('course_assignments_course_idx').on(table.courseId),
  index('course_assignments_author_idx').on(table.authorId),
  check('course_assignments_resubmission_check', sql`${table.allowResubmission} IN (0, 1)`),
]);

export const groupAssignments = sqliteTable('group_assignments', {
  id: id(),
  courseAssignmentId: text('course_assignment_id').notNull().references(() => courseAssignments.id, restrict),
  groupId: text('group_id').notNull().references(() => groups.id, restrict),
  deadline: integer('deadline'),
  publishedAt: integer('published_at'),
  ...timestamps(),
}, (table) => [
  uniqueIndex('group_assignments_pair_unique').on(table.courseAssignmentId, table.groupId),
  index('group_assignments_group_idx').on(table.groupId),
  check('group_assignments_published_deadline_check', sql`${table.publishedAt} IS NULL OR ${table.deadline} IS NOT NULL`),
]);

export const repositoryLinks = sqliteTable('repository_links', {
  id: id(),
  groupAssignmentId: text('group_assignment_id').notNull().references(() => groupAssignments.id, restrict),
  studentId: text('student_id').notNull().references(() => users.id, restrict),
  giteaRepositoryId: integer('gitea_repository_id').notNull(),
  fullName: text('full_name').notNull(),
  isPrivate: integer('is_private', { mode: 'boolean' }).notNull().default(true),
  status: text('status', { enum: assignmentStatuses }).notNull().default('in_progress'),
  ...timestamps(),
}, (table) => [
  uniqueIndex('repository_links_assignment_student_unique').on(table.groupAssignmentId, table.studentId),
  uniqueIndex('repository_links_gitea_id_unique').on(table.giteaRepositoryId),
  uniqueIndex('repository_links_full_name_unique').on(table.fullName),
  index('repository_links_student_idx').on(table.studentId),
  check('repository_links_private_check', sql`${table.isPrivate} IN (0, 1)`),
  check('repository_links_status_check', sql`${table.status} IN ('in_progress', 'submitted', 'revision_required', 'passed', 'failed')`),
]);

export const submissions = sqliteTable('submissions', {
  id: id(),
  repositoryLinkId: text('repository_link_id').notNull().references(() => repositoryLinks.id, restrict),
  attempt: integer('attempt').notNull(),
  commitSha: text('commit_sha').notNull(),
  protectedRef: text('protected_ref').notNull(),
  status: text('status', { enum: assignmentStatuses }).notNull().default('submitted'),
  submittedAt: integer('submitted_at').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  ...timestamps(),
}, (table) => [
  uniqueIndex('submissions_repository_attempt_unique').on(table.repositoryLinkId, table.attempt),
  uniqueIndex('submissions_repository_ref_unique').on(table.repositoryLinkId, table.protectedRef),
  uniqueIndex('submissions_repository_key_unique').on(table.repositoryLinkId, table.idempotencyKey),
  check('submissions_attempt_positive', sql`typeof(${table.attempt}) = 'integer' AND ${table.attempt} > 0`),
  check('submissions_commit_sha_nonempty', sql`length(trim(${table.commitSha})) > 0`),
  check('submissions_ref_nonempty', sql`length(trim(${table.protectedRef})) > 0`),
  check('submissions_idempotency_key_nonempty', sql`length(trim(${table.idempotencyKey})) > 0`),
  check('submissions_status_check', sql`${table.status} IN ('in_progress', 'submitted', 'revision_required', 'passed', 'failed')`),
]);

export const reviews = sqliteTable('reviews', {
  id: id(),
  submissionId: text('submission_id').notNull().references(() => submissions.id, restrict),
  reviewerId: text('reviewer_id').notNull().references(() => users.id, restrict),
  decision: text('decision', { enum: reviewDecisions }).notNull(),
  feedback: text('feedback').notNull().default(''),
  grade: real('grade'),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  ...timestamps(),
}, (table) => [
  uniqueIndex('reviews_one_active_per_submission').on(table.submissionId).where(sql`${table.isActive} = 1`),
  index('reviews_submission_idx').on(table.submissionId),
  index('reviews_reviewer_idx').on(table.reviewerId),
  check('reviews_decision_check', sql`${table.decision} IN ('revision_required', 'passed', 'failed')`),
  check('reviews_active_check', sql`${table.isActive} IN (0, 1)`),
]);

export const testDefinitions = sqliteTable('test_definitions', {
  id: id(),
  groupAssignmentId: text('group_assignment_id').notNull().references(() => groupAssignments.id, restrict),
  name: text('name').notNull(),
  sourceRef: text('source_ref').notNull(),
  visibility: text('visibility', { enum: testVisibilities }).notNull(),
  ...timestamps(),
}, (table) => [
  index('test_definitions_assignment_idx').on(table.groupAssignmentId),
  check('test_definitions_visibility_check', sql`${table.visibility} IN ('visible', 'hidden')`),
]);

export const testRuns = sqliteTable('test_runs', {
  id: id(),
  testDefinitionId: text('test_definition_id').notNull().references(() => testDefinitions.id, restrict),
  submissionId: text('submission_id').notNull().references(() => submissions.id, restrict),
  runKey: text('run_key').notNull(),
  status: text('status', { enum: testRunStatuses }).notNull().default('queued'),
  outputMetadata: text('output_metadata', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default(sql`'{}'`),
  startedAt: integer('started_at'),
  completedAt: integer('completed_at'),
  ...timestamps(),
}, (table) => [
  uniqueIndex('test_runs_idempotency_unique').on(table.testDefinitionId, table.submissionId, table.runKey),
  index('test_runs_submission_idx').on(table.submissionId),
  check('test_runs_status_check', sql`${table.status} IN ('queued', 'running', 'passed', 'failed', 'error')`),
  check('test_runs_output_json_check', sql`json_valid(${table.outputMetadata})`),
  check('test_runs_dates_check', sql`${table.completedAt} IS NULL OR (${table.startedAt} IS NOT NULL AND ${table.completedAt} >= ${table.startedAt})`),
]);

export const notifications = sqliteTable('notifications', {
  id: id(),
  recipientId: text('recipient_id').notNull().references(() => users.id, restrict),
  eventType: text('event_type').notNull(),
  deduplicationKey: text('deduplication_key').notNull(),
  payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default(sql`'{}'`),
  readAt: integer('read_at'),
  ...timestamps(),
}, (table) => [
  uniqueIndex('notifications_recipient_dedup_unique').on(table.recipientId, table.deduplicationKey),
  index('notifications_recipient_read_idx').on(table.recipientId, table.readAt),
  check('notifications_payload_json_check', sql`json_valid(${table.payload})`),
]);

export const notificationPreferences = sqliteTable('notification_preferences', {
  id: id(),
  userId: text('user_id').notNull().references(() => users.id, restrict),
  channel: text('channel', { enum: notificationChannels }).notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  ...timestamps(),
}, (table) => [
  uniqueIndex('notification_preferences_user_channel_unique').on(table.userId, table.channel),
  check('notification_preferences_channel_check', sql`${table.channel} IN ('in_app', 'email', 'telegram')`),
  check('notification_preferences_enabled_check', sql`${table.enabled} IN (0, 1)`),
]);

export const outageIncidents = sqliteTable('outage_incidents', {
  id: id(),
  service: text('service').notNull(),
  startedAt: integer('started_at').notNull(),
  endedAt: integer('ended_at'),
  confirmed: integer('confirmed', { mode: 'boolean' }).notNull().default(false),
  details: text('details').notNull().default(''),
  ...timestamps(),
}, (table) => [
  index('outage_incidents_service_start_idx').on(table.service, table.startedAt),
  check('outage_incidents_confirmed_check', sql`${table.confirmed} IN (0, 1)`),
  check('outage_incidents_dates_check', sql`${table.endedAt} IS NULL OR ${table.endedAt} >= ${table.startedAt}`),
]);

export const compensationWindows = sqliteTable('compensation_windows', {
  id: id(),
  outageIncidentId: text('outage_incident_id').notNull().references(() => outageIncidents.id, restrict),
  startsAt: integer('starts_at').notNull(),
  endsAt: integer('ends_at').notNull(),
  reason: text('reason').notNull(),
  ...timestamps(),
}, (table) => [
  index('compensation_windows_incident_start_idx').on(table.outageIncidentId, table.startsAt),
  check('compensation_windows_dates_check', sql`${table.endsAt} > ${table.startsAt}`),
]);

export const auditEvents = sqliteTable('audit_events', {
  id: id(),
  actorId: text('actor_id').references(() => users.id, restrict),
  eventType: text('event_type').notNull(),
  targetType: text('target_type').notNull(),
  targetId: text('target_id').notNull(),
  payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default(sql`'{}'`),
  occurredAt: integer('occurred_at').notNull().default(epochMilliseconds),
}, (table) => [
  index('audit_events_actor_idx').on(table.actorId),
  index('audit_events_target_idx').on(table.targetType, table.targetId),
  index('audit_events_time_idx').on(table.occurredAt),
  check('audit_events_payload_json_check', sql`json_valid(${table.payload})`),
]);

// Settings have no parent entity. Audit targets are polymorphic, not foreign keys.
export const systemSettings = sqliteTable('system_settings', {
  id: id(),
  key: text('key').notNull(),
  value: text('value', { mode: 'json' }).$type<unknown>().notNull(),
  updatedAt: updatedAt(),
}, (table) => [
  uniqueIndex('system_settings_key_unique').on(table.key),
  check('system_settings_value_json_check', sql`json_valid(${table.value})`),
]);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type UserRole = typeof userRoles.$inferSelect;
export type NewUserRole = typeof userRoles.$inferInsert;
export type StudentProfile = typeof studentProfiles.$inferSelect;
export type NewStudentProfile = typeof studentProfiles.$inferInsert;
export type Activation = typeof activations.$inferSelect;
export type NewActivation = typeof activations.$inferInsert;
export type Group = typeof groups.$inferSelect;
export type NewGroup = typeof groups.$inferInsert;
export type GroupMember = typeof groupMembers.$inferSelect;
export type NewGroupMember = typeof groupMembers.$inferInsert;
export type Course = typeof courses.$inferSelect;
export type NewCourse = typeof courses.$inferInsert;
export type CourseGroup = typeof courseGroups.$inferSelect;
export type NewCourseGroup = typeof courseGroups.$inferInsert;
export type Lesson = typeof lessons.$inferSelect;
export type NewLesson = typeof lessons.$inferInsert;
export type LessonPublication = typeof lessonPublications.$inferSelect;
export type NewLessonPublication = typeof lessonPublications.$inferInsert;
export type CourseAssignment = typeof courseAssignments.$inferSelect;
export type NewCourseAssignment = typeof courseAssignments.$inferInsert;
export type GroupAssignment = typeof groupAssignments.$inferSelect;
export type NewGroupAssignment = typeof groupAssignments.$inferInsert;
export type RepositoryLink = typeof repositoryLinks.$inferSelect;
export type NewRepositoryLink = typeof repositoryLinks.$inferInsert;
export type Submission = typeof submissions.$inferSelect;
export type NewSubmission = typeof submissions.$inferInsert;
export type Review = typeof reviews.$inferSelect;
export type NewReview = typeof reviews.$inferInsert;
export type TestDefinition = typeof testDefinitions.$inferSelect;
export type NewTestDefinition = typeof testDefinitions.$inferInsert;
export type TestRun = typeof testRuns.$inferSelect;
export type NewTestRun = typeof testRuns.$inferInsert;
export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;
export type NotificationPreference = typeof notificationPreferences.$inferSelect;
export type NewNotificationPreference = typeof notificationPreferences.$inferInsert;
export type OutageIncident = typeof outageIncidents.$inferSelect;
export type NewOutageIncident = typeof outageIncidents.$inferInsert;
export type CompensationWindow = typeof compensationWindows.$inferSelect;
export type NewCompensationWindow = typeof compensationWindows.$inferInsert;
export type AuditEvent = typeof auditEvents.$inferSelect;
export type NewAuditEvent = typeof auditEvents.$inferInsert;
export type SystemSetting = typeof systemSettings.$inferSelect;
export type NewSystemSetting = typeof systemSettings.$inferInsert;

/** Activation bearer secrets are never persisted; only HMAC fingerprints. */
export const activationTokens = sqliteTable('activation_tokens', {
  tokenHmac: text('token_hmac').primaryKey().notNull(),
  kind: text('kind', { enum: ['qr', 'email'] }).notNull(),
  groupId: text('group_id').notNull().references(() => groups.id, restrict),
  email: text('email'),
  qrTokenHmac: text('qr_token_hmac'),
  expiresAt: integer('expires_at').notNull(),
  usedAt: integer('used_at'),
  revokedAt: integer('revoked_at'),
}, table => [index('activation_tokens_expiry_idx').on(table.expiresAt)]);
export const activationRateLimits = sqliteTable('activation_rate_limits', {
 keyHash: text('key_hash').primaryKey().notNull(),
 windowStart: integer('window_start').notNull(),
 attempts: integer('attempts').notNull(),
});
