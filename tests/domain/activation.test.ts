import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  ActivationServiceImpl,
  ActivationRepository,
  ActivationTokenRecord,
  StudentActivationRecord,
} from '../../src/domain/activation';
import { AuditEventId, AuditInput, DomainError, GroupId, UserId } from '../../src/shared/contracts';

const groupId = '00000000-0000-4000-8000-000000000001' as GroupId;
const userId = '00000000-0000-4000-8000-000000000002' as UserId;

function setup() {
  let now = 1_000;
  const tokens = new Map<string, ActivationTokenRecord>();
  const students = new Map<string, StudentActivationRecord>([
    ['2400051', { studentId: '2400051', userId, groupId, expectedEmail: '2400051a@jdu.uz', activationState: 'pending' }],
    ['2400052', { studentId: '2400052', userId: 'other-user' as UserId, groupId, expectedEmail: 'official.alias@jdu.uz', activationState: 'pending' }],
  ]);
  const events: AuditInput[] = [];
  const repository: ActivationRepository = {
    insertToken: async (record) => { tokens.set(record.tokenHmac, { ...record }); },
    findToken: async (hmac) => tokens.get(hmac) ?? null,
    revokeToken: async (hmac, at) => { const token = tokens.get(hmac); if (token) token.revokedAt = at; },
    findStudent: async (id) => students.get(id) ?? null,
    // This is one atomic database transaction in the real adapter.
    activate: async (input) => {
      const token = tokens.get(input.tokenHmac);
      const qr = tokens.get(input.qrTokenHmac);
      const student = students.get(input.studentId);
      if (!token || !qr || !student || token.usedAt !== null || token.revokedAt !== null ||
          qr.revokedAt !== null || token.expiresAt <= input.now || qr.expiresAt <= input.now ||
          token.kind !== 'email' || qr.kind !== 'qr' || token.qrTokenHmac !== qr.tokenHmac ||
          token.email !== input.email || token.groupId !== student.groupId || qr.groupId !== student.groupId ||
          student.expectedEmail.trim().toLowerCase() !== input.email || student.activationState !== 'pending') return false;
      token.usedAt = input.now;
      student.activationState = 'active';
      return true;
    },
  };
  const audit = { append: async (event: AuditInput) => { events.push(event); return 'audit-id' as AuditEventId; } };
  const service = () => new ActivationServiceImpl({ repository, audit, now: () => now, hmacSecret: 'a'.repeat(32) });
  const activation = service();
  const emailToken = async (email = '2400051a@jdu.uz') => {
    const qrToken = await activation.issueQr({ groupId, ttlMs: 10_000 });
    const token = await activation.issueEmailToken({ qrToken, email, ttlMs: 5_000 });
    return { qrToken, token };
  };
  return { activation, repository, audit, service, tokens, students, events, emailToken, setNow: (at: number) => { now = at; } };
}

describe('ActivationService', () => {
  it('activates an imported student after matching the email-link identity and Student ID', async () => {
    const { activation, emailToken } = setup();
    const { token } = await emailToken();
    await expect(activation.activate({ token, studentId: '2400051' })).resolves.toEqual({ userId, studentId: '2400051' });
  });

  it('audits a mismatched Student ID without disclosing the email or bearer token', async () => {
    const { activation, emailToken, events } = setup();
    const { token } = await emailToken();
    await expect(activation.activate({ token, studentId: '2400052' })).rejects.toMatchObject({
      code: 'CONFLICT', status: 409, message: 'Activation could not be completed',
    });
    expect(events).toEqual([{
      actorId: null, eventType: 'activation.conflict', targetType: 'student', targetId: '2400052',
      payload: { reason: 'identity_mismatch' },
    }]);
    expect(JSON.stringify(events)).not.toContain(token);
    expect(JSON.stringify(events)).not.toContain('2400051a@jdu.uz');
    await expect(activation.activate({ token, studentId: '2400051' })).resolves.toMatchObject({ userId });
  });

  it('refuses to start an email challenge from a QR at its exact expiry', async () => {
    const { activation, setNow } = setup();
    const qrToken = await activation.issueQr({ groupId, ttlMs: 10 });
    setNow(1_010);
    await expect(activation.issueEmailToken({ qrToken, email: '2400051a@jdu.uz', ttlMs: 100 }))
      .rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('persists only HMAC fingerprints of cryptographically random tokens', async () => {
    const { emailToken, tokens } = setup();
    const { qrToken, token } = await emailToken();
    expect(qrToken).toMatch(/^qr_[A-Za-z0-9_-]{43}$/);
    expect(token).toMatch(/^email_[A-Za-z0-9_-]{43}$/);
    const expected = createHmac('sha256', 'a'.repeat(32)).update('local-github:activation:v1\0').update(token).digest('hex');
    expect(tokens.has(expected)).toBe(true);
    expect(JSON.stringify([...tokens.values()])).not.toContain(token);
    expect(JSON.stringify([...tokens.values()])).not.toContain(qrToken);
  });

  it('allows only one concurrent activation across service instances', async () => {
    const { activation, service, emailToken, events } = setup();
    const { token } = await emailToken();
    const results = await Promise.allSettled([
      activation.activate({ token, studentId: '2400051' }),
      service().activate({ token, studentId: '2400051' }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  it('keeps the shared QR usable by different students', async () => {
    const { activation } = setup();
    const qrToken = await activation.issueQr({ groupId, ttlMs: 10_000 });
    const first = await activation.issueEmailToken({ qrToken, email: '2400051a@jdu.uz', ttlMs: 100 });
    const second = await activation.issueEmailToken({ qrToken, email: 'official.alias@jdu.uz', ttlMs: 100 });
    await expect(activation.activate({ token: first, studentId: '2400051' })).resolves.toMatchObject({ studentId: '2400051' });
    await expect(activation.activate({ token: second, studentId: '2400052' })).resolves.toMatchObject({ studentId: '2400052' });
  });

  it('matches normalized official addresses, including administrator-approved exceptions', async () => {
    const { activation, emailToken } = setup();
    const { token } = await emailToken(' Official.Alias@JDU.UZ ');
    await expect(activation.activate({ token, studentId: '2400052' })).resolves.toMatchObject({ studentId: '2400052' });
  });

  it('rejects the email link at its exact expiry', async () => {
    const { activation, emailToken, setNow } = setup();
    const { token } = await emailToken();
    setNow(6_000);
    await expect(activation.activate({ token, studentId: '2400051' })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('caps the email-link lifetime at the parent QR expiry', async () => {
    const { activation, tokens } = setup();
    const qrToken = await activation.issueQr({ groupId, ttlMs: 100 });
    await activation.issueEmailToken({ qrToken, email: '2400051a@jdu.uz', ttlMs: 10_000 });
    expect([...tokens.values()].find((token) => token.kind === 'email')?.expiresAt).toBe(1_100);
  });

  it.each(['qr', 'email'] as const)('rejects a revoked %s and its pending activation', async (kind) => {
    const { activation, emailToken } = setup();
    const { qrToken, token } = await emailToken();
    await activation.revoke(kind === 'qr' ? qrToken : token);
    await expect(activation.activate({ token, studentId: '2400051' })).rejects.toMatchObject({ code: 'CONFLICT' });
    if (kind === 'qr') {
      await expect(activation.issueEmailToken({ qrToken, email: '2400051a@jdu.uz', ttlMs: 100 }))
        .rejects.toMatchObject({ code: 'CONFLICT' });
    }
  });

  it('audits replay of a used link and reactivation with a fresh link', async () => {
    const { activation, emailToken, events } = setup();
    const { token } = await emailToken();
    await activation.activate({ token, studentId: '2400051' });
    const second = await emailToken();
    for (const link of [token, second.token]) {
      await expect(activation.activate({ token: link, studentId: '2400051' })).rejects.toMatchObject({ code: 'CONFLICT' });
    }
    expect(events.map((event) => event.payload.reason)).toEqual(['invalid_token', 'not_pending']);
  });

  it.each(['active', 'disabled'] as const)('refuses students in state %s', async (state) => {
    const { activation, emailToken, students } = setup();
    const { token } = await emailToken();
    students.get('2400051')!.activationState = state;
    await expect(activation.activate({ token, studentId: '2400051' })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('rejects an imported student outside the QR group', async () => {
    const { activation, emailToken, students } = setup();
    const { token } = await emailToken();
    students.get('2400051')!.groupId = 'another-group' as GroupId;
    await expect(activation.activate({ token, studentId: '2400051' })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('rejects fabricated, tampered, wrong-purpose, and missing tokens with the same error', async () => {
    const { activation, emailToken, events } = setup();
    const { token, qrToken } = await emailToken();
    const tampered = `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`;
    for (const candidate of ['', 'email_' + 'x'.repeat(43), tampered, qrToken, token + '\n']) {
      await expect(activation.activate({ token: candidate, studentId: '2400051' })).rejects.toMatchObject({
        code: 'CONFLICT', status: 409, message: 'Activation could not be completed',
      });
    }
    expect(events).toHaveLength(5);
  });

  it('reports unknown students identically to identity mismatches', async () => {
    const { activation, emailToken, events } = setup();
    const { token } = await emailToken();
    await expect(activation.activate({ token, studentId: '9999999' })).rejects.toMatchObject({
      code: 'CONFLICT', status: 409, message: 'Activation could not be completed',
    });
    expect(events[0]?.payload.reason).toBe('unknown_student');
  });

  it('propagates audit failure and leaves the student pending', async () => {
    const { activation, emailToken, audit, students } = setup();
    const { token } = await emailToken();
    audit.append = async () => { throw new Error('audit offline'); };
    await expect(activation.activate({ token, studentId: '2400052' })).rejects.toThrow('audit offline');
    expect(students.get('2400051')?.activationState).toBe('pending');
    expect(students.get('2400052')?.activationState).toBe('pending');
  });

  it.each(['outside@example.com', 'a@jdu.uz.evil', 'a@evil@jdu.uz', 'a b@jdu.uz', ''])('rejects non-university or malformed email %j', async (email) => {
    const { activation } = setup();
    const qrToken = await activation.issueQr({ groupId, ttlMs: 100 });
    await expect(activation.issueEmailToken({ qrToken, email, ttlMs: 100 })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it.each([0, -1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER])('rejects an invalid token lifetime %s', async (ttlMs) => {
    const { activation } = setup();
    await expect(activation.issueQr({ groupId, ttlMs })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const qrToken = await activation.issueQr({ groupId, ttlMs: 100 });
    await expect(activation.issueEmailToken({ qrToken, email: '2400051a@jdu.uz', ttlMs }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('rejects an empty HMAC key', () => {
    const { repository, audit } = setup();
    expect(() => new ActivationServiceImpl({ repository, audit, now: () => 1_000, hmacSecret: '' })).toThrow(DomainError);
  });
});
