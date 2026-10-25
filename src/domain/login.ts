import { CookieSpec, SessionPrincipal, SessionStore, errors } from '../shared/contracts';
import { MAX_SESSION_SECONDS } from './auth/session';

export interface CredentialRecord {
  principal: SessionPrincipal;
  activationState: 'pending' | 'active' | 'disabled';
}

export interface CredentialVerifier {
  /** The adapter performs password-hash verification and constant-time handling. */
  authenticate(login: string, password: string): Promise<CredentialRecord | null>;
}

interface LoginDeps {
  credentials: CredentialVerifier;
  sessions: SessionStore;
  ttlMs: number;
}

export class LoginServiceImpl {
  constructor(private readonly deps: LoginDeps) {
    if (!Number.isSafeInteger(deps.ttlMs) || deps.ttlMs <= 0 || deps.ttlMs > MAX_SESSION_SECONDS * 1000) {
      throw errors.invalidInput('Session lifetime is invalid');
    }
  }

  async login(input: { login: string; password: string }): Promise<{ token: string; cookie: CookieSpec }> {
    const studentId = parseStudentLogin(input.login);
    if (!studentId || input.password.length === 0) throw errors.unauthenticated();
    const login = studentLogin(studentId);
    const record = await this.deps.credentials.authenticate(login, input.password);
    if (!record || record.activationState !== 'active' || record.principal.login !== login) {
      throw errors.unauthenticated();
    }
    return this.deps.sessions.create(record.principal, this.deps.ttlMs);
  }
}

export function parseStudentLogin(login: string): string | null {
  const match = /^jdu-([0-9]+)$/.exec(login);
  return match?.[1] ?? null;
}

export function studentLogin(studentId: string): string {
  if (studentId.length === 0 || /[^0-9]/.test(studentId)) throw errors.invalidInput('Student ID must contain only digits');
  return `jdu-${studentId}`;
}
