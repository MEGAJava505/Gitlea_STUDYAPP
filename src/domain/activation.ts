import { createHmac, randomBytes } from 'node:crypto';
import { AuditLogWriter, Clock, GroupId, UserId, errors } from '../shared/contracts';

export interface StudentActivationRecord {
  studentId: string;
  userId: UserId;
  groupId: GroupId;
  /** Official import value, including administrator-approved template exceptions. */
  expectedEmail: string;
  activationState: 'pending' | 'active' | 'disabled';
}

export interface ActivationTokenRecord {
  tokenHmac: string;
  kind: 'qr' | 'email';
  groupId: GroupId;
  email: string | null;
  qrTokenHmac: string | null;
  expiresAt: number;
  usedAt: number | null;
  revokedAt: number | null;
}

export interface CompleteActivationInput {
  tokenHmac: string;
  qrTokenHmac: string;
  studentId: string;
  email: string;
  now: number;
}

export interface ActivationRepository {
  insertToken(record: ActivationTokenRecord): Promise<void>;
  findToken(tokenHmac: string): Promise<ActivationTokenRecord | null>;
  revokeToken(tokenHmac: string, now: number): Promise<void>;
  findStudent(studentId: string): Promise<StudentActivationRecord | null>;
  /**
   * In one transaction, recheck both token expiries/revocations, email/group
   * matching and pending student state, consume the email token and activate
   * the student. Return false on any conflict, including concurrent requests.
   * Never consume the shared group QR. The adapter must enforce unique Student ID.
   */
  activate(input: CompleteActivationInput): Promise<boolean>;
}

interface ActivationDeps {
  repository: ActivationRepository;
  audit: AuditLogWriter;
  now: Clock;
  hmacSecret: string;
}

const TOKEN_PATTERN = /^(?:qr|email)_[A-Za-z0-9_-]{43}$/;

/** Opaque bearer tokens: only purpose-separated HMAC fingerprints are persisted. */
export class ActivationServiceImpl {
  constructor(private readonly deps: ActivationDeps) {
    if (Buffer.byteLength(deps.hmacSecret, 'utf8') < 32) throw errors.invalidInput('Activation key must contain at least 32 bytes');
  }

  /** The application authorizes the administrator/teacher before issuing a QR. */
  async issueQr(input: { groupId: GroupId; ttlMs: number }): Promise<string> {
    validateTtl(input.ttlMs);
    return this.issue('qr', input.groupId, null, null, this.deps.now() + input.ttlMs);
  }

  /** Deliver the returned token only to this email via the injected mail adapter. */
  async issueEmailToken(input: { qrToken: string; email: string; ttlMs: number }): Promise<string> {
    validateTtl(input.ttlMs);
    const normalized = input.email.trim().toLowerCase();
    if (!/^[^\s@]+@jdu\.uz$/.test(normalized)) throw errors.conflict('Activation could not be completed');
    const qr = await this.lookup(input.qrToken, 'qr');
    if (!qr) throw errors.conflict('Activation could not be completed');
    return this.issue('email', qr.groupId, normalized, qr.tokenHmac,
      Math.min(qr.expiresAt, this.deps.now() + input.ttlMs));
  }

  async revoke(raw: string): Promise<void> {
    if (!TOKEN_PATTERN.test(raw)) return;
    await this.deps.repository.revokeToken(this.fingerprint(raw), this.deps.now());
  }

  async activate(input: { token: string; studentId: string }): Promise<{ userId: UserId; studentId: string }> {
    const token = await this.lookup(input.token, 'email');
    if (!token?.email || !token.qrTokenHmac) return this.conflict(input.studentId, 'invalid_token');
    const student = await this.deps.repository.findStudent(input.studentId);
    if (!student) return this.conflict(input.studentId, 'unknown_student');
    if (student.expectedEmail.trim().toLowerCase() !== token.email || student.groupId !== token.groupId) {
      return this.conflict(input.studentId, 'identity_mismatch');
    }
    if (student.activationState !== 'pending') return this.conflict(input.studentId, 'not_pending');
    if (!await this.deps.repository.activate({
      tokenHmac: token.tokenHmac, qrTokenHmac: token.qrTokenHmac,
      studentId: student.studentId, email: token.email, now: this.deps.now(),
    })) return this.conflict(input.studentId, 'concurrent_conflict');
    await this.deps.audit.append({
      actorId: student.userId, eventType: 'activation.succeeded', targetType: 'student',
      targetId: student.studentId, payload: {},
    });
    return { userId: student.userId, studentId: student.studentId };
  }

  private async conflict(studentId: string, reason: string): Promise<never> {
    await this.deps.audit.append({
      actorId: null, eventType: 'activation.conflict', targetType: 'student', targetId: studentId,
      payload: { reason },
    });
    throw errors.conflict('Activation could not be completed');
  }

  private fingerprint(token: string): string {
    return createHmac('sha256', this.deps.hmacSecret)
      .update('local-github:activation:v1\0').update(token, 'utf8').digest('hex');
  }

  private async lookup(raw: string, kind: ActivationTokenRecord['kind']): Promise<ActivationTokenRecord | null> {
    if (!TOKEN_PATTERN.test(raw)) return null;
    const token = await this.deps.repository.findToken(this.fingerprint(raw));
    return token?.kind === kind && token.expiresAt > this.deps.now() &&
      token.revokedAt === null && token.usedAt === null ? token : null;
  }

  private async issue(kind: ActivationTokenRecord['kind'], groupId: GroupId, email: string | null,
    qrTokenHmac: string | null, expiresAt: number): Promise<string> {
    const token = `${kind}_${randomBytes(32).toString('base64url')}`;
    await this.deps.repository.insertToken({
      tokenHmac: this.fingerprint(token), kind, groupId, email, qrTokenHmac, expiresAt,
      usedAt: null, revokedAt: null,
    });
    return token;
  }
}

function validateTtl(ttlMs: number): void {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 30 * 24 * 60 * 60 * 1000) {
    throw errors.invalidInput('Activation lifetime is invalid');
  }
}
