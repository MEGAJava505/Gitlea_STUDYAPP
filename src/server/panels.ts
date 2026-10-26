import { errors, Role, SessionPrincipal } from '../shared/contracts';
import { forbidden, unauthorized } from 'next/navigation';
import { DomainError } from '../shared/contracts';

export function requirePageAccess(check: () => SessionPrincipal): SessionPrincipal {
  try {
    return check();
  } catch (error) {
    if (error instanceof DomainError && error.status === 401) unauthorized();
    if (error instanceof DomainError && error.status === 403) forbidden();
    throw error;
  }
}

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
