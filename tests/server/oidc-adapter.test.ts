import { afterEach, describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readOidcConfig, findMappedGiteaUser, createGiteaOidcAdapter } from '../../src/server/gitea-oidc-adapter';
const env = { OIDC_ISSUER: 'https://git.example', OIDC_CLIENT_ID: 'app', OIDC_CLIENT_SECRET: 'test-only', OIDC_CALLBACK_URL: 'https://app.example/api/auth/oidc/callback', OIDC_AUTHORIZATION_ENDPOINT: 'https://git.example/login/oauth/authorize', OIDC_TOKEN_ENDPOINT: 'https://git.example/login/oauth/access_token', OIDC_JWKS_URI: 'https://git.example/login/oauth/keys' };
const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true }); });
describe('production OIDC adapter boundary', () => {
  it('requires explicit HTTPS fixed provider endpoints and callback', () => {
    expect(readOidcConfig(env)).toMatchObject({ issuer: env.OIDC_ISSUER, callbackUrl: env.OIDC_CALLBACK_URL });
    expect(() => readOidcConfig({})).toThrow();
    for (const patch of [{ OIDC_JWKS_URI: 'https://evil.example/keys' }, { OIDC_CALLBACK_URL: 'http://app.example/api/auth/oidc/callback' }, { OIDC_CALLBACK_URL: 'https://app.example/api/auth/oidc/callback?next=evil' }, { OIDC_ISSUER: 'https://user:secret@git.example' }]) expect(() => readOidcConfig({ ...env, ...patch })).toThrow();
  });
  it('looks up only existing gitea_id mappings without creating rows', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oidc-map-')); dirs.push(dir); const path = join(dir, 'users.db');
    const db = new Database(path); db.exec("CREATE TABLE users (id TEXT PRIMARY KEY, gitea_id INTEGER UNIQUE); INSERT INTO users VALUES ('student',42)");
    vi.stubEnv('DATABASE_URL', 'file:' + path);
    expect(await findMappedGiteaUser(42)).toBe('student'); expect(await findMappedGiteaUser(99)).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS count FROM users').get()).toEqual({ count: 1 }); db.close();
  });
  it('sends fixed callback and PKCE only to configured token endpoint and rejects failed exchanges', async () => {
    const fetcher = vi.fn(async () => Response.json({ error: 'secret authorization-code' }, { status: 400 }));
    const provider = createGiteaOidcAdapter(readOidcConfig(env), fetcher);
    await expect(provider.exchange('code', 'pkce', 'nonce')).rejects.toThrow('Login failed');
    const [url, options] = fetcher.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe(env.OIDC_TOKEN_ENDPOINT); expect(options.redirect).toBe('error');
    const body = options.body as URLSearchParams; expect(body.get('redirect_uri')).toBe(env.OIDC_CALLBACK_URL); expect(body.get('code_verifier')).toBe('pkce');
  });
});
