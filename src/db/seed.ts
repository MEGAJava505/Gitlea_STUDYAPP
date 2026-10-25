import { openSqliteDatabase } from './migrate';

// Static UUIDs make fixture identity stable across fresh databases and process runs.
const ids = {
  teacher: '10000000-0000-4000-8000-000000000001',
  student: '10000000-0000-4000-8000-000000000002',
  profile: '10000000-0000-4000-8000-000000000003',
  group: '10000000-0000-4000-8000-000000000004',
  course: '10000000-0000-4000-8000-000000000005',
  courseAssignment: '10000000-0000-4000-8000-000000000006',
  groupAssignment: '10000000-0000-4000-8000-000000000007',
  testDefinition: '10000000-0000-4000-8000-000000000008',
  lesson: '10000000-0000-4000-8000-000000000014',
  repository: '10000000-0000-4000-8000-000000000015',
  submission: '10000000-0000-4000-8000-000000000016',
  outage: '10000000-0000-4000-8000-000000000017',
};

export async function seedDatabase(databaseUrl = process.env.DATABASE_URL ?? 'file:./data/local-github.sqlite'): Promise<void> {
  const sqlite = openSqliteDatabase(databaseUrl);
  try {
    const seedTime = Date.UTC(2025, 0, 1);
    sqlite.transaction(() => {
      sqlite.prepare(`INSERT OR IGNORE INTO users (id, gitea_id, login, email, display_name, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(ids.teacher, 900001, 'seed-teacher', 'seed-teacher@university.example', 'Seed Teacher', seedTime, seedTime);
      sqlite.prepare(`INSERT OR IGNORE INTO users (id, gitea_id, login, email, display_name, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(ids.student, 900002, 'seed-student', 'seed-student@university.example', 'Seed Student', seedTime, seedTime);
      sqlite.prepare(`INSERT OR IGNORE INTO user_roles (id, user_id, role, created_at) VALUES (?, ?, ?, ?)`)
        .run('10000000-0000-4000-8000-000000000009', ids.teacher, 'teacher', seedTime);
      sqlite.prepare(`INSERT OR IGNORE INTO user_roles (id, user_id, role, created_at) VALUES (?, ?, ?, ?)`)
        .run('10000000-0000-4000-8000-000000000010', ids.student, 'student', seedTime);
      sqlite.prepare(`INSERT OR IGNORE INTO student_profiles
        (id, user_id, student_id, expected_email, activation_state, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'active', ?, ?)`)
        .run(ids.profile, ids.student, 'SEED-001', 'seed-student@university.example', seedTime, seedTime);
      sqlite.prepare(`INSERT OR IGNORE INTO groups (id, code, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
        .run(ids.group, 'SEED-101', 'Seed Cohort', seedTime, seedTime);
      sqlite.prepare(`INSERT OR IGNORE INTO group_members
        (id, group_id, user_id, state, joined_at, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?, ?)`)
        .run('10000000-0000-4000-8000-000000000011', ids.group, ids.student, seedTime, seedTime, seedTime);
      sqlite.prepare(`INSERT OR IGNORE INTO courses
        (id, owner_id, slug, title, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(ids.course, ids.teacher, 'seed-introduction', 'Seed Introduction', 'Deterministic local sample course.', seedTime, seedTime);
      sqlite.prepare(`INSERT OR IGNORE INTO course_groups (id, course_id, group_id, created_at) VALUES (?, ?, ?, ?)`)
        .run('10000000-0000-4000-8000-000000000012', ids.course, ids.group, seedTime);
      sqlite.prepare(`INSERT OR IGNORE INTO lessons
        (id, course_id, position, title, content_metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(ids.lesson, ids.course, 1, 'Getting Started', JSON.stringify({ format: 'markdown', source: 'seed' }), seedTime, seedTime);
      sqlite.prepare(`INSERT OR IGNORE INTO lesson_publications
        (id, lesson_id, group_id, published_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run('10000000-0000-4000-8000-000000000018', ids.lesson, ids.group, seedTime, seedTime, seedTime);
      sqlite.prepare(`INSERT OR IGNORE INTO course_assignments
        (id, course_id, author_id, title, description, allow_resubmission, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?)`)
        .run(ids.courseAssignment, ids.course, ids.teacher, 'Seed Assignment', 'Reusable sample assignment.', seedTime, seedTime);
      sqlite.prepare(`INSERT OR IGNORE INTO group_assignments
        (id, course_assignment_id, group_id, deadline, published_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(ids.groupAssignment, ids.courseAssignment, ids.group, Date.UTC(2030, 0, 1), seedTime, seedTime, seedTime);
      sqlite.prepare(`INSERT OR IGNORE INTO repository_links
        (id, group_assignment_id, student_id, gitea_repository_id, full_name, is_private, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, 'in_progress', ?, ?)`)
        .run(ids.repository, ids.groupAssignment, ids.student, 900002, 'seed-student/seed-introduction', seedTime, seedTime);
      sqlite.prepare(`INSERT OR IGNORE INTO submissions
        (id, repository_link_id, attempt, commit_sha, protected_ref, status, submitted_at, created_at, updated_at)
        VALUES (?, ?, 1, ?, 'submission/1', 'submitted', ?, ?, ?)`)
        .run(ids.submission, ids.repository, '0'.repeat(40), seedTime, seedTime, seedTime);
      sqlite.prepare(`INSERT OR IGNORE INTO reviews
        (id, submission_id, reviewer_id, decision, feedback, grade, is_active, created_at, updated_at)
        VALUES (?, ?, ?, 'revision_required', 'Seed review.', NULL, 1, ?, ?)`)
        .run('10000000-0000-4000-8000-000000000019', ids.submission, ids.teacher, seedTime, seedTime);
      sqlite.prepare(`INSERT OR IGNORE INTO test_definitions
        (id, group_assignment_id, name, source_ref, visibility, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(ids.testDefinition, ids.groupAssignment, 'seed-visible-check', 'main:tests/sample', 'visible', seedTime, seedTime);
      sqlite.prepare(`INSERT OR IGNORE INTO test_runs
        (id, test_definition_id, submission_id, run_key, status, output_metadata, started_at, completed_at, created_at, updated_at)
        VALUES (?, ?, ?, 'seed-run-1', 'passed', ?, ?, ?, ?, ?)`)
        .run('10000000-0000-4000-8000-000000000020', ids.testDefinition, ids.submission, JSON.stringify({ passed: 1 }), seedTime, seedTime, seedTime, seedTime);
      sqlite.prepare(`INSERT OR IGNORE INTO notifications
        (id, recipient_id, event_type, deduplication_key, payload, created_at, updated_at)
        VALUES (?, ?, 'assignment_published', 'seed:assignment:1', ?, ?, ?)`)
        .run('10000000-0000-4000-8000-000000000021', ids.student, JSON.stringify({ assignmentId: ids.groupAssignment }), seedTime, seedTime);
      sqlite.prepare(`INSERT OR IGNORE INTO notification_preferences
        (id, user_id, channel, enabled, created_at, updated_at) VALUES (?, ?, 'in_app', 1, ?, ?)`)
        .run('10000000-0000-4000-8000-000000000022', ids.student, seedTime, seedTime);
      sqlite.prepare(`INSERT OR IGNORE INTO activations
        (id, student_profile_id, token_hmac, expires_at, used_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run('10000000-0000-4000-8000-000000000023', ids.profile, 'seed-fixture-hmac-not-a-credential', Date.UTC(2030, 0, 1), seedTime, seedTime);
      sqlite.prepare(`INSERT OR IGNORE INTO outage_incidents
        (id, service, started_at, ended_at, confirmed, details, created_at, updated_at)
        VALUES (?, 'gitea', ?, ?, 1, 'Synthetic seed incident.', ?, ?)`)
        .run(ids.outage, seedTime, seedTime + 60000, seedTime, seedTime);
      sqlite.prepare(`INSERT OR IGNORE INTO compensation_windows
        (id, outage_incident_id, starts_at, ends_at, reason, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'Synthetic seed compensation.', ?, ?)`)
        .run('10000000-0000-4000-8000-000000000024', ids.outage, seedTime + 60000, seedTime + 120000, seedTime, seedTime);
      sqlite.prepare(`INSERT OR IGNORE INTO audit_events
        (id, actor_id, event_type, target_type, target_id, payload, occurred_at)
        VALUES (?, ?, 'seeded', 'course', ?, ?, ?)`)
        .run('10000000-0000-4000-8000-000000000025', ids.teacher, ids.course, JSON.stringify({ source: 'seed' }), seedTime);
      sqlite.prepare('INSERT OR IGNORE INTO system_settings (id, key, value, updated_at) VALUES (?, ?, ?, ?)')
        .run('10000000-0000-4000-8000-000000000013', 'seed.schema_version', JSON.stringify(1), seedTime);
    })();
  } finally {
    sqlite.close();
  }
}
