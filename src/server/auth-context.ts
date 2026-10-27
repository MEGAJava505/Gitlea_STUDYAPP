import {
  AssignmentStateMachine,
  AuditLogWriter,
  IdentityService,
  PermissionChecker,
  SessionPrincipal,
  SessionStore,
} from '../shared/contracts';
import { SESSION_COOKIE_NAME } from '../domain/auth/session';
import { createProductionServices } from './production-services';
import type { CourseService } from '../domain/courses/service';
import type { DeadlineSweeper } from '../domain/assignments/deadline-sweeper';
import type { StudentAssignmentsQuery } from './student-assignments';
import type { ProvisioningService } from '../domain/git/provisioning';
import type { MaterialsService } from '../domain/materials/service';

/** Reads the opaque session token from the request's Cookie header. */
export function readSessionCookie(req: Request): string | null {
  const header = req.headers.get('cookie');
  if (!header) return null;
  for (const chunk of header.split(';')) {
    const eq = chunk.indexOf('=');
    if (eq === -1) continue;
    const name = chunk.slice(0, eq).trim();
    if (name === SESSION_COOKIE_NAME) {
      return chunk.slice(eq + 1).trim() || null;
    }
  }
  return null;
}

export interface AuthContextDeps {
  sessions: SessionStore;
  identities: IdentityService;
}

/**
 * Resolves the authenticated principal from a request cookie. Returns null for
 * missing, malformed, unknown, revoked or expired sessions — the caller maps
 * null to a 401 response.
 */
export function createAuthContext(deps: AuthContextDeps) {
  return {
    async principal(req: Request): Promise<SessionPrincipal | null> {
      const token = readSessionCookie(req);
      if (!token) return null;
      const session = await deps.sessions.get(token);
      if (!session) return null;
      const user = await deps.identities.getUser(session.userId);
      if (!user) return null;
      const roles = await deps.identities.listRoles(session.userId);
      return {
        userId: user.id,
        login: user.login,
        displayName: user.displayName,
        roles,
      };
    },
  };
}

export type AuthContext = ReturnType<typeof createAuthContext>;

/* ------------------------------------------------------------------ *
 * Service container (wired once at bootstrap; handlers never touch Db/Gitea)
 * ------------------------------------------------------------------ */

export interface AppServices {
  sessions: SessionStore;
  identities: IdentityService;
  assignments?: AssignmentStateMachine;
  deadlineSweeper?: DeadlineSweeper;
  studentAssignments?: StudentAssignmentsQuery;
  provisioning?: ProvisioningService;
  courses?: CourseService;
  permissions?: PermissionChecker;
  materials?: MaterialsService;
  audit: AuditLogWriter;
}

let container: AppServices | null = null;

export function configureServices(services: AppServices): void {
  container = services;
}

export function getServices(): AppServices {
  container ??= createProductionServices();
  return container;
}
