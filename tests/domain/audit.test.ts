import { describe, expect, it } from 'vitest';
import { AuditLogWriterImpl, redact } from '../../src/domain/audit';
import { AuditEvent, AuditRepository } from '../../src/shared/contracts';
import { InMemoryAuditRepository, uid } from './fakes';

describe('AuditLogWriter', () => {
  it('appends a structured event and returns its ID', async () => {
    const repo = new InMemoryAuditRepository();
    const writer = new AuditLogWriterImpl({ audit: repo, now: () => 42, newId: () => 'audit-1' as never });

    const id = await writer.append({
      actorId: uid('u1'),
      eventType: 'submission.created',
      targetType: 'submission',
      targetId: 'sub-1',
      payload: { attempt: 1 },
    });

    expect(id).toBe('audit-1' as never);
    expect(repo.events).toHaveLength(1);
    expect(repo.events[0]).toEqual({
      id: 'audit-1',
      actorId: uid('u1'),
      eventType: 'submission.created',
      targetType: 'submission',
      targetId: 'sub-1',
      payload: { attempt: 1 },
      createdAt: 42,
    });
  });

  it('passes actor/target indexes to the repository', async () => {
    const repo = new InMemoryAuditRepository();
    const writer = new AuditLogWriterImpl({ audit: repo, now: () => 1 });

    await writer.append({
      actorId: uid('actor'),
      eventType: 'role.granted',
      targetType: 'user',
      targetId: uid('target'),
      payload: { role: 'teacher' },
    });

    const event = repo.events[0];
    expect(event.actorId).toBe(uid('actor'));
    expect(event.targetType).toBe('user');
    expect(event.targetId).toBe(uid('target'));
  });

  it('redacts token/password/secret fields (shallow and nested)', async () => {
    const repo = new InMemoryAuditRepository();
    const writer = new AuditLogWriterImpl({ audit: repo, now: () => 1 });

    await writer.append({
      actorId: uid('u1'),
      eventType: 'integration.error',
      targetType: 'assignment',
      targetId: 'a1',
      payload: {
        token: 'raw-token',
        password: 'hunter2',
        api_key: 'abc',
        sessionToken: 'st',
        details: { giteaAccessToken: 'gitea-secret', note: 'kept' },
        list: [{ private_key: 'pk', ok: 1 }],
      },
    });

    const payload = repo.events[0].payload as Record<string, unknown>;
    expect(payload.token).toBe('[REDACTED]');
    expect(payload.password).toBe('[REDACTED]');
    expect(payload.api_key).toBe('[REDACTED]');
    expect(payload.sessionToken).toBe('[REDACTED]');
    expect(payload).not.toContain('raw-token');
    expect(payload).not.toContain('hunter2');

    const details = payload.details as Record<string, unknown>;
    expect(details.giteaAccessToken).toBe('[REDACTED]');
    expect(details.note).toBe('kept');

    const [item] = payload.list as Array<Record<string, unknown>>;
    expect(item.private_key).toBe('[REDACTED]');
    expect(item.ok).toBe(1);
  });

  it('redacts at the top level too', () => {
    const out = redact({ cookie: 'c=1', secure: true, authorization: 'Bearer x' }) as Record<
      string,
      unknown
    >;
    expect(out.cookie).toBe('[REDACTED]');
    expect(out.authorization).toBe('[REDACTED]');
    expect(out.secure).toBe(true);
  });

  it('propagates repository failures so the operation cannot be reported successful', async () => {
    const failing: AuditRepository = {
      append: async (_event: AuditEvent) => {
        throw new Error('audit write failed');
      },
    };
    const writer = new AuditLogWriterImpl({ audit: failing, now: () => 1 });

    await expect(
      writer.append({
        actorId: uid('u1'),
        eventType: 'submission.created',
        targetType: 'submission',
        targetId: 'sub-1',
        payload: {},
      }),
    ).rejects.toThrow('audit write failed');
  });
});
