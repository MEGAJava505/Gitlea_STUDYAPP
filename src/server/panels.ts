import { errors, Role, SessionPrincipal } from '../shared/contracts';

function requirePanelRole(
  principal: SessionPrincipal | null,
  role: Role,
): SessionPrincipal {
  if (!principal) throw errors.unauthenticated();
  if (!principal.roles.includes(role)) {
    throw errors.forbidden(`Missing role "${role}"`);
  }
  return principal;
}

export function requireStudentPanel(principal: SessionPrincipal | null): SessionPrincipal {
  return requirePanelRole(principal, 'student');
}

export function requireTeacherPanel(principal: SessionPrincipal | null): SessionPrincipal {
  return requirePanelRole(principal, 'teacher');
}

export function requireAdminPanel(principal: SessionPrincipal | null): SessionPrincipal {
  if (!principal) throw errors.unauthenticated();
  if (!principal.roles.includes('admin') && !principal.roles.includes('owner')) {
    throw errors.forbidden('Missing role "admin"');
  }
  return principal;
}
