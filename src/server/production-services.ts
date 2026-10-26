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
import { GiteaSubmissionAdapter } from './ports/gitea-submission-adapter';
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
  const assignmentRepo = new DbAssignmentRepository(db);
  const permissions = new PermissionCheckerImpl({ resolver: assignmentRepo, audit });
  const giteaSubmissions = new GiteaSubmissionAdapter();
  const assignments = new AssignmentStateMachineImpl({
    repo: assignmentRepo,
    gitea: giteaSubmissions,
    permissions,
    audit,
    now: Date.now,
  });
  return {
    sessions: new SessionStoreImpl({ sessions: sessionRepository, now: Date.now }),
    identities: new IdentityServiceImpl({ roles, audit }),
    courses: new CourseService({ db, now: Date.now }),
    assignments,
    deadlineSweeper: new DeadlineSweeper({ repo: new DbDeadlineSweeperRepository(db), audit, now: Date.now }),
    permissions,
    audit,
  };
}
