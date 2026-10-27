import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants, lstatSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, unlinkSync, readdirSync, realpathSync, fstatSync, fsyncSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { getServices, type AppServices } from './auth-context';
import { createGiteaOidcAdapter, findMappedGiteaUser, readOidcConfig, type OidcConfig } from './gitea-oidc-adapter';
import { serializeCookie } from '../domain/auth/session';
import type { UserId } from '../shared/contracts';

const TTL = 5 * 60 * 1000;
const COOKIE = '__Host-oidc';
const opaque = () => randomBytes(32).toString('base64url');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const valid = (value: string) => /^[A-Za-z0-9_-]{43}$/.test(value);
export interface OidcState { browserHash: string; nonce: string; verifier: string; returnTo: string; expiresAt: number }
export interface OidcStatePort {
  create(state: string, record: OidcState): Promise<void>;
  consume(state: string, browser: string): Promise<OidcState | null>;
}

/** Private local durable state; synchronous unlink is the one-time claim, across processes.
 * Deploy all workers against the same private filesystem, not separate replicas.
 * No OAuth access/ID tokens, codes or client secrets are persisted here.
 */
export function createFileOidcState(directory: string, now = Date.now): OidcStatePort {
  const dir = resolve(directory);
  const check = () => {
    // Reject symlinks in every ancestor, not only the final directory.
    let cursor = dir;
    while (true) {
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('State unavailable');
      if (dirname(cursor) === cursor) break;
      cursor = dirname(cursor);
    }
    const stat = lstatSync(dir);
    if ((stat.mode & 0o777) !== 0o700 || (process.getuid && stat.uid !== process.getuid()) || realpathSync(dir) !== dir) throw new Error('State unavailable');
  };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  check();
  const filename = (state: string) => { if (!valid(state)) throw new Error('Invalid state'); return join(dir, hash(state)); };
  const read = (path: string): OidcState => {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size > 4096 || (process.getuid && stat.uid !== process.getuid())) throw new Error('Invalid state');
      return JSON.parse(readFileSync(fd, 'utf8')) as OidcState;
    } finally { closeSync(fd); }
  };
  return {
    async create(state, record) {
      check();
      // Bound disk accumulation and expire abandoned logins. Never follow unknown paths.
      const entries = readdirSync(dir);
      if (entries.length > 10000) throw new Error('State unavailable');
      for (const entry of entries) {
        if (!/^[a-f0-9]{64}$/.test(entry)) continue;
        try { const path = join(dir, entry); if (read(path).expiresAt <= now()) unlinkSync(path); } catch { /* malformed state is never accepted */ }
      }
      const fd = openSync(filename(state), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, JSON.stringify(record)); fsyncSync(fd); } finally { closeSync(fd); }
    },
    async consume(state, browser) {
      if (!valid(state) || !valid(browser)) return null;
      check();
      try {
        const path = filename(state); const record = read(path);
        if (!Number.isFinite(record.expiresAt) || record.expiresAt <= now() || record.expiresAt > now() + TTL
          || !valid(record.nonce) || !valid(record.verifier) || !/^[a-f0-9]{64}$/.test(record.browserHash)
          || !timingSafeEqual(Buffer.from(record.browserHash), Buffer.from(hash(browser)))) return null;
        // No await between read and unlink: exactly one competing process can unlink.
        unlinkSync(path);
        return record;
      } catch { return null; }
    },
  };
}

export function localOidcReturn(value: string | null): string {
  if (!value) return '/';
  if (value.length > 1024 || !value.startsWith('/') || value.startsWith('//') || value.includes('\\') || Array.from(value).some(char => char.charCodeAt(0) < 33 || char.charCodeAt(0) === 127)) throw new Error('Invalid return');
  const decoded = decodeURIComponent(value);
  if (decoded.startsWith('//') || decoded.includes('\\') || Array.from(decoded).some(char => char.charCodeAt(0) < 33 || char.charCodeAt(0) === 127)) throw new Error('Invalid return');
  const parsed = new URL(value, 'https://local.invalid');
  if (parsed.origin !== 'https://local.invalid' || parsed.pathname.startsWith('/api/auth/oidc/')) throw new Error('Invalid return');
  return parsed.pathname + parsed.search + parsed.hash;
}

export interface OidcLoginDeps {
  config: OidcConfig; state: OidcStatePort;
  provider: { exchange(code: string, verifier: string, nonce: string): Promise<{ giteaId: number }> };
  mappedUser(giteaId: number): Promise<UserId | null>;
  services(): Pick<AppServices, 'sessions' | 'identities'>;
  now?: () => number;
}
const browserCookie = (value: string, seconds: number) => COOKIE + '=' + value + '; Max-Age=' + seconds + '; Path=/; HttpOnly; Secure; SameSite=Lax';
const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
export const oidcUnavailable = () => Response.json({ error: 'Login unavailable' }, { status: 503, headers });
export function createOidcLoginServices(deps: OidcLoginDeps) {
  const now = deps.now ?? Date.now;
  const failure = () => { const response = Response.json({ error: 'Login failed' }, { status: 400, headers }); response.headers.set('Set-Cookie', browserCookie('', 0)); return response; };
  return {
    async start(req: Request): Promise<Response> {
      try {
        const returnTo = localOidcReturn(new URL(req.url).searchParams.get('returnTo'));
        const state = opaque(); const browser = opaque(); const nonce = opaque(); const verifier = opaque();
        await deps.state.create(state, { browserHash: hash(browser), nonce, verifier, returnTo, expiresAt: now() + TTL });
        const url = new URL(deps.config.authorizationEndpoint);
        url.search = new URLSearchParams({ response_type: 'code', client_id: deps.config.clientId, redirect_uri: deps.config.callbackUrl,
          scope: 'openid', state, nonce, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
        return new Response(null, { status: 302, headers: { ...headers, Location: url.toString(), 'Set-Cookie': browserCookie(browser, TTL / 1000) } });
      } catch { return failure(); }
    },
    async callback(req: Request): Promise<Response> {
      try {
        const params = new URL(req.url).searchParams;
        const states = params.getAll('state'); const codes = params.getAll('code');
        const cookies = (req.headers.get('cookie') ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith(COOKIE + '='));
        if (states.length !== 1 || cookies.length !== 1) return failure();
        const record = await deps.state.consume(states[0]!, cookies[0]!.slice(COOKIE.length + 1));
        if (!record || params.has('error') || codes.length !== 1 || !codes[0] || codes[0].length > 4096) return failure();
        const identity = await deps.provider.exchange(codes[0], record.verifier, record.nonce);
        const id = await deps.mappedUser(identity.giteaId);
        if (!id) return failure();
        const { sessions, identities } = deps.services();
        const user = await identities.getUser(id);
        if (!user) return failure();
        const returnTo = localOidcReturn(record.returnTo);
        const { cookie } = await sessions.create({ userId: user.id, login: user.login, displayName: user.displayName, roles: await identities.listRoles(user.id) }, 30 * 24 * 60 * 60 * 1000);
        const response = new Response(null, { status: 303, headers: { ...headers, Location: returnTo } });
        response.headers.append('Set-Cookie', browserCookie('', 0));
        response.headers.append('Set-Cookie', serializeCookie({ ...cookie, secure: true, httpOnly: true, sameSite: 'lax', path: '/' }));
        return response;
      } catch { return failure(); }
    },
  };
}
let singleton: ReturnType<typeof createOidcLoginServices> | undefined;
export function getOidcLoginServices() {
  if (!singleton) {
    const config = readOidcConfig();
    singleton = createOidcLoginServices({ config, state: createFileOidcState(process.env.OIDC_STATE_DIR ?? resolve('data/oidc-state')),
      provider: createGiteaOidcAdapter(config), mappedUser: findMappedGiteaUser, services: getServices });
  }
  return singleton;
}
