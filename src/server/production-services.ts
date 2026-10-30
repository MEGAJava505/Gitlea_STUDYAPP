import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { AuditLogWriterImpl } from '../domain/audit';
import { CourseService } from '../domain/courses/service';
import { SessionStoreImpl } from '../domain/auth/session';
import { IdentityServiceImpl } from '../domain/identity';
import { AssignmentStateMachineImpl } from '../domain/assignments/state-machine';
import { PermissionCheckerImpl } from '../domain/permissions';
import { DbAssignmentRepository } from './db-assignment-repository';
import { DbDeadlineSweeperRepository } from './db-deadline-sweeper-repository';
import { DeadlineSweeper } from '../domain/assignments/deadline-sweeper';
import { StudentAssignmentsQuery } from './student-assignments';
import { TeacherSubmissionsQuery } from './teacher-submissions';
import { DbProvisioningRepository } from './db-provisioning-repository';
import { GiteaProvisioningAdapter } from './ports/gitea-provisioning';
import { ProvisioningService } from '../domain/git/provisioning';
import { GiteaSubmissionAdapter } from './ports/gitea-submission-adapter';
import { DbMaterialsRepository } from './db-materials-repository';
import { FilesystemBlobStorage } from './blob-storage-filesystem';
import { MaterialsService } from '../domain/materials/service';
import { DbSystemSettingsRepository, DbReviewQueryRepository } from './db-grading-repositories';
import { GradingService } from '../domain/grading/service';
import { openSqliteDatabase } from '../db/migrate';
import * as tables from '../db/schema';
import * as relations from '../db/relations';
import type {
  AuditEvent, AuditRepository, Role, RoleRepository, SessionRecord, SessionRepository,
  UserId, UserRecord,
} from '../shared/contracts';
import type { AppServices } from './auth-context';

export function createProductionServices(): AppServices {
  const sqlite = openSqliteDatabase();
  const migrationsFolder = process.env.MIGRATIONS_FOLDER ?? resolve(process.cwd(), 'drizzle');
  migrate(drizzle(sqlite), { migrationsFolder });
  // One database handle for the whole service container. Importing `db` from
  // `../db/client` would open a second connection to the same file.
  const db = drizzle(sqlite, { schema: { ...tables, ...relations } });
  const storageRoot = process.env.MATERIALS_STORAGE_ROOT;

  const roles: RoleRepository = {
    async getUserById(id: UserId) {
      const row = sqlite.prepare('SELECT id, login, email, display_name AS displayName, gitea_id AS giteaId FROM users WHERE id = ?')
        .get(id) as UserRecord | undefined;
      return row ?? null;
    },
    async listRoles(userId: UserId) {
      const rows = sqlite.prepare('SELECT role FROM user_roles WHERE user_id = ?').all(userId) as { role: Role }[];
      return rows.map((row) => row.role);
    },
    async listAllRoles() {
      return sqlite.prepare('SELECT user_id AS userId, role FROM user_roles').all() as { userId: UserId; role: Role }[];
    },
    async insertRole(userId: UserId, role: Role) {
      sqlite.prepare('INSERT INTO user_roles (id, user_id, role, created_at) VALUES (?, ?, ?, ?)')
        .run(randomUUID(), userId, role, Date.now());
    },
    async deleteRole(userId: UserId, role: Role) {
      sqlite.prepare('DELETE FROM user_roles WHERE user_id = ? AND role = ?').run(userId, role);
    },
  };
  const sessionRepository: SessionRepository = {
    async insert(record: SessionRecord) {
      sqlite.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
        .run(record.tokenHash, record.userId, record.expiresAt, record.createdAt);
    },
    async findByTokenHash(hash: string) {
      return (sqlite.prepare('SELECT token_hash AS tokenHash, user_id AS userId, expires_at AS expiresAt, created_at AS createdAt FROM sessions WHERE token_hash = ?')
        .get(hash) as SessionRecord | undefined) ?? null;
    },
    async deleteByTokenHash(hash: string) {
      sqlite.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash);
    },
  };
  const auditRepository: AuditRepository = {
    async append(event: AuditEvent) {
      sqlite.prepare('INSERT INTO audit_events (id, actor_id, event_type, target_type, target_id, payload, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(event.id, event.actorId, event.eventType, event.targetType, event.targetId,
          JSON.stringify(event.payload), event.createdAt);
      return event.id;
    },
  };
  const audit = new AuditLogWriterImpl({ audit: auditRepository, now: Date.now });
  // Successful submission audits are written by assignmentRepo on its own
  // synchronous transaction handle. This general writer serves replay/conflict
  // and other events only; never await it inside a SQLite transaction.
  const assignmentRepo = new DbAssignmentRepository(db);
  const permissions = new PermissionCheckerImpl({ resolver: assignmentRepo, audit });
  const giteaSubmissions = new GiteaSubmissionAdapter();
  const grading = new GradingService({
    settings: new DbSystemSettingsRepository(db),
    reviews: new DbReviewQueryRepository(db),
    audit,
    now: Date.now,
  });
  const assignments = new AssignmentStateMachineImpl({
    repo: assignmentRepo,
    gitea: giteaSubmissions,
    numericGrading: grading,
    permissions,
    audit,
    now: Date.now,
  });
  const services: AppServices = {
    sessions: new SessionStoreImpl({ sessions: sessionRepository, now: Date.now }),
    identities: new IdentityServiceImpl({ roles, audit }),
    courses: new CourseService({ db, now: Date.now }),
    assignments,
    provisioning: new ProvisioningService({
      repo: new DbProvisioningRepository(db),
      gitea: new GiteaProvisioningAdapter(),
      audit,
      now: Date.now,
      organization: process.env.GITEA_ORGANIZATION ?? 'local-github',
      cloneBaseUrl: process.env.GITEA_CLONE_BASE_URL ?? process.env.GITEA_BASE_URL ?? '',
      sshCloneBaseUrl: process.env.GITEA_SSH_CLONE_BASE_URL ?? '',
    }),
    studentAssignments: new StudentAssignmentsQuery(db),
    teacherSubmissions: new TeacherSubmissionsQuery(db),
    deadlineSweeper: new DeadlineSweeper({ repo: new DbDeadlineSweeperRepository(db), audit, now: Date.now }),
    permissions,
    audit,
    grading,
  };
  if (storageRoot) services.materials = new MaterialsService({
    repo: new DbMaterialsRepository(db), blobs: new FilesystemBlobStorage(storageRoot), now: Date.now,
  });
  return services;
}
