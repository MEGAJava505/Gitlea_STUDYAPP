import { createHash, randomBytes } from 'node:crypto';
import {
  Clock,
  CookieSpec,
  SessionPrincipal,
  SessionRecord,
  SessionRepository,
  SessionStore,
  UserId,
  ValidSession,
} from '../../shared/contracts';

export const SESSION_COOKIE_NAME = 'session';
export const MAX_SESSION_SECONDS = 30 * 24 * 60 * 60; // bounded Max-Age: 30 days

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function isWellFormedToken(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}

export function serializeCookie(cookie: CookieSpec): string {
  const parts: string[] = [`${cookie.name}=${cookie.value}`];
  parts.push(`Max-Age=${cookie.maxAge}`);
  parts.push(`Path=${cookie.path}`);
  if (cookie.httpOnly) parts.push('HttpOnly');
  if (cookie.secure) parts.push('Secure');
  parts.push(`SameSite=${cookie.sameSite === 'lax' ? 'Lax' : cookie.sameSite}`);
  return parts.join('; ');
}

interface SessionDeps {
  sessions: SessionRepository;
  now: Clock;
  hash?: (token: string) => string;
  randomToken?: () => string;
  /** When true (production) the session cookie is marked Secure. */
  secureCookies?: boolean;
  maxAgeSeconds?: number;
}

/**
 * Server-side session store. Only a SHA-256 hash of the opaque token is ever
 * persisted; the raw token exists solely in the caller's cookie. Expiry is an
 * absolute epoch-ms timestamp enforced on every lookup.
 */
export class SessionStoreImpl implements SessionStore {
  private readonly sessions: SessionRepository;
  private readonly now: Clock;
  private readonly hash: (token: string) => string;
  private readonly randomToken: () => string;
  private readonly secure: boolean;
  private readonly maxAgeSeconds: number;

  constructor(deps: SessionDeps) {
    this.sessions = deps.sessions;
    this.now = deps.now;
    this.hash = deps.hash ?? hashToken;
    this.randomToken =
      deps.randomToken ?? (() => randomBytes(32).toString('base64url'));
    this.secure = deps.secureCookies ?? process.env.NODE_ENV === 'production';
    this.maxAgeSeconds = deps.maxAgeSeconds ?? MAX_SESSION_SECONDS;
  }

  async create(
    principal: SessionPrincipal,
    ttlMs: number,
  ): Promise<{ token: string; cookie: CookieSpec }> {
    const token = this.randomToken();
    const now = this.now();
    const record: SessionRecord = {
      tokenHash: this.hash(token),
      userId: principal.userId,
      expiresAt: now + ttlMs,
      createdAt: now,
    };
    await this.sessions.insert(record);

    const cookie: CookieSpec = {
      name: SESSION_COOKIE_NAME,
      value: token,
      maxAge: clampSeconds(Math.ceil(ttlMs / 1000), this.maxAgeSeconds),
      httpOnly: true,
      secure: this.secure,
      sameSite: 'lax',
      path: '/',
    };
    return { token, cookie };
  }

  async get(token: string): Promise<ValidSession | null> {
    if (!isWellFormedToken(token)) {
      return null; // malformed token
    }
    const record = await this.sessions.findByTokenHash(this.hash(token));
    if (!record) {
      return null; // unknown or revoked
    }
    if (record.expiresAt <= this.now()) {
      return null; // expired (absolute expiry)
    }
    return { userId: record.userId, expiresAt: record.expiresAt, createdAt: record.createdAt };
  }

  async revoke(token: string): Promise<void> {
    if (!isWellFormedToken(token)) {
      return;
    }
    await this.sessions.deleteByTokenHash(this.hash(token));
  }
}

function clampSeconds(seconds: number, max: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 1;
  return Math.min(seconds, max);
}

/** Convenience type re-export for handlers that only need the user id. */
export type { UserId };
