PRAGMA foreign_keys = ON;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY NOT NULL,
  gitea_id INTEGER NOT NULL,
  login TEXT NOT NULL,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
  CHECK (length(trim(email)) > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS users_gitea_id_unique ON users(gitea_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS users_login_unique ON users(login);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS users_normalized_email_unique ON users(lower(trim(email)));
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS user_roles (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN ('student', 'teacher', 'admin', 'owner')),
  created_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS user_roles_user_role_unique ON user_roles(user_id, role);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS student_profiles (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  student_id TEXT NOT NULL,
  expected_email TEXT NOT NULL,
  activation_state TEXT NOT NULL DEFAULT 'pending' CHECK (activation_state IN ('pending', 'active', 'disabled')),
  created_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
  CHECK (length(trim(expected_email)) > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS student_profiles_user_unique ON student_profiles(user_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS student_profiles_student_id_unique ON student_profiles(student_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS student_profiles_normalized_email_unique ON student_profiles(lower(trim(expected_email)));
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS activations (
  id TEXT PRIMARY KEY NOT NULL,
  student_profile_id TEXT NOT NULL REFERENCES student_profiles(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  token_hmac TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS activations_active_token_unique ON activations(token_hmac) WHERE used_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS activations_student_profile_idx ON activations(student_profile_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS activations_expiry_idx ON activations(expires_at);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY NOT NULL, code TEXT NOT NULL, name TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS groups_code_unique ON groups(code);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS group_members (
  id TEXT PRIMARY KEY NOT NULL,
  group_id TEXT NOT NULL REFERENCES groups(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'inactive')),
  joined_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
  left_at INTEGER, created_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
  CHECK (left_at IS NULL OR left_at >= joined_at)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS group_members_group_user_unique ON group_members(group_id, user_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS group_members_user_idx ON group_members(user_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS courses (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  slug TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', published_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS courses_slug_unique ON courses(slug);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS courses_owner_idx ON courses(owner_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS course_groups (
  id TEXT PRIMARY KEY NOT NULL, course_id TEXT NOT NULL REFERENCES courses(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  group_id TEXT NOT NULL REFERENCES groups(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS course_groups_pair_unique ON course_groups(course_id, group_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS course_groups_group_idx ON course_groups(group_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS lessons (
  id TEXT PRIMARY KEY NOT NULL, course_id TEXT NOT NULL REFERENCES courses(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position >= 0), title TEXT NOT NULL, content_metadata TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(content_metadata)),
  created_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS lessons_course_position_unique ON lessons(course_id, position);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS lesson_publications (
  id TEXT PRIMARY KEY NOT NULL, lesson_id TEXT NOT NULL REFERENCES lessons(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  group_id TEXT NOT NULL REFERENCES groups(id) ON UPDATE RESTRICT ON DELETE RESTRICT, published_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS lesson_publications_pair_unique ON lesson_publications(lesson_id, group_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS lesson_publications_group_idx ON lesson_publications(group_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS course_assignments (
  id TEXT PRIMARY KEY NOT NULL, course_id TEXT NOT NULL REFERENCES courses(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  author_id TEXT NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT, title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '', allow_resubmission INTEGER NOT NULL DEFAULT 0 CHECK (allow_resubmission IN (0,1)),
  created_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS course_assignments_course_idx ON course_assignments(course_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS course_assignments_author_idx ON course_assignments(author_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS group_assignments (
  id TEXT PRIMARY KEY NOT NULL, course_assignment_id TEXT NOT NULL REFERENCES course_assignments(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  group_id TEXT NOT NULL REFERENCES groups(id) ON UPDATE RESTRICT ON DELETE RESTRICT, deadline INTEGER, published_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
  CHECK (published_at IS NULL OR deadline IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS group_assignments_pair_unique ON group_assignments(course_assignment_id, group_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS group_assignments_group_idx ON group_assignments(group_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS repository_links (
  id TEXT PRIMARY KEY NOT NULL, group_assignment_id TEXT NOT NULL REFERENCES group_assignments(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  student_id TEXT NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT, gitea_repository_id INTEGER NOT NULL,
  full_name TEXT NOT NULL, is_private INTEGER NOT NULL DEFAULT 1 CHECK (is_private IN (0,1)),
  status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','submitted','revision_required','passed','failed')),
  created_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS repository_links_assignment_student_unique ON repository_links(group_assignment_id, student_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS repository_links_gitea_id_unique ON repository_links(gitea_repository_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS repository_links_full_name_unique ON repository_links(full_name);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS repository_links_student_idx ON repository_links(student_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY NOT NULL, repository_link_id TEXT NOT NULL REFERENCES repository_links(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  attempt INTEGER NOT NULL CHECK (typeof(attempt) = 'integer' AND attempt > 0), commit_sha TEXT NOT NULL CHECK (length(trim(commit_sha)) > 0),
  protected_ref TEXT NOT NULL CHECK (length(trim(protected_ref)) > 0), status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('in_progress','submitted','revision_required','passed','failed')),
  submitted_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS submissions_repository_attempt_unique ON submissions(repository_link_id, attempt);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS submissions_repository_ref_unique ON submissions(repository_link_id, protected_ref);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY NOT NULL, submission_id TEXT NOT NULL REFERENCES submissions(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  reviewer_id TEXT NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT, decision TEXT NOT NULL CHECK (decision IN ('revision_required','passed','failed')),
  feedback TEXT NOT NULL DEFAULT '', grade REAL, is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS reviews_one_active_per_submission ON reviews(submission_id) WHERE is_active = 1;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS test_definitions (
  id TEXT PRIMARY KEY NOT NULL, group_assignment_id TEXT NOT NULL REFERENCES group_assignments(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  name TEXT NOT NULL, source_ref TEXT NOT NULL, visibility TEXT NOT NULL CHECK (visibility IN ('visible','hidden')),
  created_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS test_runs (
  id TEXT PRIMARY KEY NOT NULL, test_definition_id TEXT NOT NULL REFERENCES test_definitions(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  submission_id TEXT NOT NULL REFERENCES submissions(id) ON UPDATE RESTRICT ON DELETE RESTRICT, run_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','passed','failed','error')),
  output_metadata TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(output_metadata)), started_at INTEGER, completed_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
  CHECK (completed_at IS NULL OR (started_at IS NOT NULL AND completed_at >= started_at))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS test_runs_idempotency_unique ON test_runs(test_definition_id, submission_id, run_key);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY NOT NULL, recipient_id TEXT NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  event_type TEXT NOT NULL, deduplication_key TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload)), read_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS notifications_recipient_dedup_unique ON notifications(recipient_id, deduplication_key);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS notification_preferences (
  id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  channel TEXT NOT NULL CHECK (channel IN ('in_app','email','telegram')), enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  created_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS notification_preferences_user_channel_unique ON notification_preferences(user_id, channel);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS outage_incidents (
  id TEXT PRIMARY KEY NOT NULL, service TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER,
  confirmed INTEGER NOT NULL DEFAULT 0 CHECK (confirmed IN (0,1)), details TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)), CHECK (ended_at IS NULL OR ended_at >= started_at)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS compensation_windows (
  id TEXT PRIMARY KEY NOT NULL, outage_incident_id TEXT NOT NULL REFERENCES outage_incidents(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL, reason TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)), CHECK (ends_at > starts_at)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY NOT NULL, actor_id TEXT REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  event_type TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload)),
  occurred_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS system_settings (
  id TEXT PRIMARY KEY NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL CHECK (json_valid(value)),
  updated_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS system_settings_key_unique ON system_settings(key);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS reviews_submission_idx ON reviews(submission_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS reviews_reviewer_idx ON reviews(reviewer_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS test_definitions_assignment_idx ON test_definitions(group_assignment_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS test_runs_submission_idx ON test_runs(submission_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS notifications_recipient_read_idx ON notifications(recipient_id, read_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS outage_incidents_service_start_idx ON outage_incidents(service, started_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS compensation_windows_incident_start_idx ON compensation_windows(outage_incident_id, starts_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS audit_events_actor_idx ON audit_events(actor_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS audit_events_target_idx ON audit_events(target_type, target_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS audit_events_time_idx ON audit_events(occurred_at);
--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS submissions_commit_sha_immutable
BEFORE UPDATE OF commit_sha ON submissions
WHEN OLD.commit_sha IS NOT NEW.commit_sha
BEGIN SELECT RAISE(ABORT, 'submission commit SHA is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS submissions_delete_forbidden
BEFORE DELETE ON submissions
BEGIN SELECT RAISE(ABORT, 'submissions cannot be deleted'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS users_email_cross_table_guard
BEFORE INSERT ON users
WHEN EXISTS (SELECT 1 FROM student_profiles WHERE lower(trim(expected_email)) = lower(trim(NEW.email)) AND user_id <> NEW.id)
BEGIN SELECT RAISE(ABORT, 'email belongs to another account'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS users_email_cross_table_update_guard
BEFORE UPDATE OF email, id ON users
WHEN EXISTS (SELECT 1 FROM student_profiles WHERE lower(trim(expected_email)) = lower(trim(NEW.email)) AND user_id <> NEW.id)
BEGIN SELECT RAISE(ABORT, 'email belongs to another account'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS student_email_cross_table_guard
BEFORE INSERT ON student_profiles
WHEN EXISTS (SELECT 1 FROM users WHERE lower(trim(email)) = lower(trim(NEW.expected_email)) AND id <> NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'email belongs to another account'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS student_email_cross_table_update_guard
BEFORE UPDATE OF expected_email, user_id ON student_profiles
WHEN EXISTS (SELECT 1 FROM users WHERE lower(trim(email)) = lower(trim(NEW.expected_email)) AND id <> NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'email belongs to another account'); END;
--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS compensation_window_no_overlap_insert
BEFORE INSERT ON compensation_windows
WHEN EXISTS (SELECT 1 FROM compensation_windows w WHERE w.outage_incident_id = NEW.outage_incident_id AND w.id <> NEW.id AND NEW.starts_at < w.ends_at AND NEW.ends_at > w.starts_at)
BEGIN SELECT RAISE(ABORT, 'overlapping compensation window'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS compensation_window_no_overlap_update
BEFORE UPDATE OF outage_incident_id, starts_at, ends_at ON compensation_windows
WHEN EXISTS (SELECT 1 FROM compensation_windows w WHERE w.outage_incident_id = NEW.outage_incident_id AND w.id <> NEW.id AND NEW.starts_at < w.ends_at AND NEW.ends_at > w.starts_at)
BEGIN SELECT RAISE(ABORT, 'overlapping compensation window'); END;
--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS audit_events_append_only_update
BEFORE UPDATE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS audit_events_append_only_delete
BEFORE DELETE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
