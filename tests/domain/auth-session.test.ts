import { describe, expect, it } from 'vitest';
import {
  MAX_SESSION_SECONDS,
  SessionStoreImpl,
  hashToken,
  serializeCookie,
} from '../../src/domain/auth/session';
import { InMemorySessionRepository, principal, uid } from './fakes';

describe('SessionStore', () => {
  it('stores only a hash of the opaque token, never the raw token', async () => {
    const repo = new InMemorySessionRepository();
    const store = new SessionStoreImpl({ sessions: repo, now: () => 1_000, secureCookies: false });

    const { token } = await store.create(principal(uid('u1'), ['student']), 60_000);

    expect(token).toBeTruthy();
    const stored = [...repo.rows.values()];
    expect(stored).toHaveLength(1);
    expect(stored[0].tokenHash).toBe(hashToken(token));
    expect(stored[0].tokenHash).not.toBe(token);
    // The raw token must not appear anywhere in the persisted record.
    expect(JSON.stringify(stored)).not.toContain(token);
    expect('token' in stored[0]).toBe(false);
  });

  it('expires exactly at the expiry boundary', async () => {
    let now = 1_000;
    const repo = new InMemorySessionRepository();
    const store = new SessionStoreImpl({ sessions: repo, now: () => now, secureCookies: false });

    const { token } = await store.create(principal(uid('u1'), ['student']), 1_000);
    const stored = [...repo.rows.values()][0];
    expect(stored.expiresAt).toBe(2_000);

    now = 1_999;
    expect(await store.get(token)).not.toBeNull();

    now = 2_000; // expiresAt <= now -> expired
    expect(await store.get(token)).toBeNull();
  });

  it('rejects a revoked token', async () => {
    const repo = new InMemorySessionRepository();
    const store = new SessionStoreImpl({ sessions: repo, now: () => 1_000, secureCookies: false });

    const { token } = await store.create(principal(uid('u1'), ['student']), 60_000);
    expect(await store.get(token)).not.toBeNull();

    await store.revoke(token);
    expect(await store.get(token)).toBeNull();
    expect(repo.rows.size).toBe(0);
  });

  it('rejects malformed and unknown tokens', async () => {
    const repo = new InMemorySessionRepository();
    const store = new SessionStoreImpl({ sessions: repo, now: () => 1_000, secureCookies: false });

    expect(await store.get('not a valid token!')).toBeNull();
    expect(await store.get('')).toBeNull();
    expect(await store.get('short')).toBeNull();
    expect(await store.get('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).toBeNull(); // well-formed but unknown
  });

  it('emits secure cookie attributes', async () => {
    const repo = new InMemorySessionRepository();
    const secureStore = new SessionStoreImpl({ sessions: repo, now: () => 1_000, secureCookies: true });
    const insecureStore = new SessionStoreImpl({
      sessions: new InMemorySessionRepository(),
      now: () => 1_000,
      secureCookies: false,
    });

    const { cookie: secure } = await secureStore.create(principal(uid('u1'), ['student']), 60_000);
    const { cookie: insecure } = await insecureStore.create(
      principal(uid('u1'), ['student']),
      60_000,
    );

    expect(secure.httpOnly).toBe(true);
    expect(secure.secure).toBe(true);
    expect(secure.sameSite).toBe('lax');
    expect(secure.path).toBe('/');
    expect(insecure.secure).toBe(false);

    const header = serializeCookie(secure);
    expect(header).toContain('HttpOnly');
    expect(header).toContain('Secure');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Path=/');
  });

  it('bounds the Max-Age cookie attribute', async () => {
    const repo = new InMemorySessionRepository();
    const store = new SessionStoreImpl({ sessions: repo, now: () => 1_000, secureCookies: false });

    const { cookie } = await store.create(principal(uid('u1'), ['student']), 400 * 24 * 60 * 60 * 1000);

    expect(cookie.maxAge).toBe(MAX_SESSION_SECONDS);
  });
});
