import { describe, expect, it } from 'vitest';
import { CredentialVerifier, LoginServiceImpl, parseStudentLogin, studentLogin } from '../../src/domain/login';
import { SessionStoreImpl } from '../../src/domain/auth/session';
import { SessionPrincipal, SessionRecord, UserId } from '../../src/shared/contracts';
import { hashToken } from '../../src/domain/auth/session';

const principal: SessionPrincipal = {
  userId: '00000000-0000-4000-8000-000000000001' as UserId,
  login: 'jdu-2400051', displayName: 'Student Owner', roles: ['student', 'owner'],
};

function setup() {
  let now = 1_000;
  const records = new Map<string, SessionRecord>();
  const sessions = new SessionStoreImpl({
    sessions: {
      insert: async (record) => { records.set(record.tokenHash, record); },
      findByTokenHash: async (hash) => records.get(hash) ?? null,
      deleteByTokenHash: async (hash) => { records.delete(hash); },
    },
    now: () => now, secureCookies: true,
  });
  const credentials: CredentialVerifier = {
    authenticate: async (login: string, password: string) =>
      login === principal.login && password === 'abcd123' ? { principal, activationState: 'active' as const } : null,
  };
  const login = new LoginServiceImpl({ credentials, sessions, ttlMs: 60_000 });
  return { login, sessions, credentials, records, setNow: (at: number) => { now = at; } };
}

describe('LoginService', () => {
  it('hands verified credentials to SessionStore and creates a usable session', async () => {
    const { login, sessions, setNow } = setup();
    const result = await login.login({ login: principal.login, password: 'abcd123' });
    expect(result.cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'lax', value: result.token });
    expect(await sessions.get(result.token)).toEqual({ userId: principal.userId, createdAt: 1_000, expiresAt: 61_000 });
    setNow(61_000);
    expect(await sessions.get(result.token)).toBeNull();
  });

  it.each([
    ['', 'abcd123'], ['JDU-2400051', 'abcd123'], ['jdu-', 'abcd123'], ['jdu-24x0051', 'abcd123'],
    ['jdu-2400051', 'abcdef1'], ['jdu-2400051', 'wrong12'], ['jdu-2400051', ''],
  ])('returns the same unauthenticated error for invalid login %j/password', async (login, password) => {
    const { login: service, records } = setup();
    await expect(service.login({ login, password })).rejects.toMatchObject({ code: 'UNAUTHENTICATED', status: 401 });
    expect(records.size).toBe(0);
  });

  it('accepts only canonical lowercase jdu-<numeric ID> logins', async () => {
    const { login: service, credentials } = setup();
    credentials.authenticate = async (login) => login === 'jdu-00051' ? { principal: { ...principal, login }, activationState: 'active' } : null;
    await expect(service.login({ login: 'jdu-00051', password: 'abcd123' })).resolves.toHaveProperty('token');
    for (const login of ['jdu-00051 ', 'jdu-+51', 'jdu-1.0', 'jdu-１２３', 'jdu-00051\n', 'jdu-0'.repeat(40)]) {
      await expect(service.login({ login, password: 'abcd123' })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    }
  });

  it.each(['pending', 'disabled'] as const)('does not open a session for %s imported accounts', async (activationState) => {
    const { login: service, credentials } = setup();
    credentials.authenticate = async () => ({ principal, activationState });
    await expect(service.login({ login: principal.login, password: 'abcd123' })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('does not trust a credential adapter record with a mismatched login', async () => {
    const { login: service, credentials } = setup();
    credentials.authenticate = async () => ({ principal: { ...principal, login: 'jdu-999' }, activationState: 'active' });
    await expect(service.login({ login: principal.login, password: 'abcd123' })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('propagates credential store failures and never creates a session', async () => {
    const { login: service, credentials, records } = setup();
    credentials.authenticate = async () => { throw new Error('credential store offline'); };
    await expect(service.login({ login: principal.login, password: 'abcd123' })).rejects.toThrow('credential store offline');
    expect(records.size).toBe(0);
  });

  it('propagates session store failures after successful credential verification', async () => {
    const { login: service, sessions } = setup();
    sessions.create = async () => { throw new Error('session store offline'); };
    await expect(service.login({ login: principal.login, password: 'abcd123' })).rejects.toThrow('session store offline');
  });

  it('uses the exact bounded TTL supplied to the session handoff', async () => {
    const { login: service, sessions } = setup();
    let received = 0;
    sessions.create = async (_principal, ttlMs) => { received = ttlMs; return { token: 'token', cookie: { name: 'session', value: 'token', maxAge: 60, httpOnly: true, secure: true, sameSite: 'lax', path: '/' } }; };
    await service.login({ login: principal.login, password: 'abcd123' });
    expect(received).toBe(60_000);
  });

  it('persists only the session hash and user reference after login', async () => {
    const { login: service, records } = setup();
    const { token } = await service.login({ login: principal.login, password: 'abcd123' });
    expect([...records.values()]).toEqual([{
      tokenHash: hashToken(token), userId: principal.userId, createdAt: 1_000, expiresAt: 61_000,
    }]);
    expect(JSON.stringify([...records.values()])).not.toContain('abcd123');
    expect(JSON.stringify([...records.values()])).not.toContain(token);
  });

  it('rejects a trailing newline before querying credentials', async () => {
    const { login: service, credentials } = setup();
    credentials.authenticate = async () => { throw new Error('must not reach credentials'); };
    expect(parseStudentLogin('jdu-2400051\n')).toBeNull();
    await expect(service.login({ login: 'jdu-2400051\n', password: 'abcd123' }))
      .rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('checks changed passwords against the credential source without applying the issuance policy', async () => {
    const { login: service, credentials } = setup();
    credentials.authenticate = async (login, password) =>
      login === principal.login && password === '  Changed-Passphrase!  '
        ? { principal, activationState: 'active' } : null;
    await expect(service.login({ login: principal.login, password: '  Changed-Passphrase!  ' }))
      .resolves.toHaveProperty('token');
  });

  it('formats numeric Student IDs without losing leading zeroes', () => {
    expect(studentLogin('00051')).toBe('jdu-00051');
    expect(() => studentLogin('51\n')).toThrow();
    expect(() => studentLogin('')).toThrow();
  });

  it.each([0, -1, NaN, Infinity, 0.5, 30 * 24 * 60 * 60 * 1000 + 1])('rejects invalid session lifetime %s', (ttlMs) => {
    const { credentials, sessions } = setup();
    expect(() => new LoginServiceImpl({ credentials, sessions, ttlMs })).toThrow();
  });
});
