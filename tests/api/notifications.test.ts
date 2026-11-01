import { beforeEach, describe, expect, it } from 'vitest';
import { GET as GET_NOTIFICATIONS } from '../../src/app/api/v1/notifications/route';
import { PATCH as PATCH_NOTIFICATION } from '../../src/app/api/v1/notifications/[notificationId]/route';
import { GET as GET_PREFERENCES, PATCH as PATCH_PREFERENCES } from '../../src/app/api/v1/notifications/preferences/route';
import { NotificationsService } from '../../src/domain/notifications';
import { IdentityServiceImpl } from '../../src/domain/identity';
import { configureServices, type AppServices } from '../../src/server/auth-context';
import { InMemoryAuditRepository, InMemoryRoleRepository, InMemorySessionRepository, makeAuditWriter, makeSessionStore, uid } from '../domain/fakes';
import type {
  NotificationChannel,
  NotificationPreferenceRecord,
  NotificationRecord,
  NotificationRepository,
  UserId,
} from '../../src/shared/contracts';

class MemoryNotifications implements NotificationRepository {
  rows: NotificationRecord[] = [];
  preferences = new Map<string, boolean>();
  nextId = 0;
  now = 1000;

  async create(input: Omit<NotificationRecord, 'id' | 'readAt' | 'createdAt'>): Promise<NotificationRecord> {
    const existing = this.rows.find((row) => row.recipientId === input.recipientId && row.deduplicationKey === input.deduplicationKey);
    if (existing) return existing;
    const row = { ...input, id: String(++this.nextId), readAt: null, createdAt: this.now++ };
    this.rows.push(row);
    return row;
  }

  async list(userId: UserId, options: { unreadOnly?: boolean } = {}): Promise<NotificationRecord[]> {
    return this.rows.filter((row) => row.recipientId === userId && (!options.unreadOnly || row.readAt === null));
  }

  async markRead(userId: UserId, id: string): Promise<boolean> {
    const row = this.rows.find((item) => item.id === id && item.recipientId === userId);
    if (!row) return false;
    row.readAt ??= this.now++;
    return true;
  }

  async getPreferences(userId: UserId): Promise<NotificationPreferenceRecord[]> {
    return (['in_app', 'email', 'telegram'] as const).map((channel) => ({
      channel,
      enabled: this.preferences.get(`${userId}:${channel}`) ?? channel !== 'email',
    }));
  }

  async setPreference(userId: UserId, channel: NotificationChannel, enabled: boolean): Promise<void> {
    this.preferences.set(`${userId}:${channel}`, enabled);
  }
}

let services: AppServices;
let tokens: Record<'student' | 'other', string>;
let repository: MemoryNotifications;

beforeEach(async () => {
  const now = () => 1000;
  const roles = new InMemoryRoleRepository({
    users: [
      { id: uid('notification-student'), login: 'student', email: 'student@example.test', displayName: 'Student' },
      { id: uid('notification-other'), login: 'other', email: 'other@example.test', displayName: 'Other' },
    ],
    roles: [
      { userId: uid('notification-student'), role: 'student' },
      { userId: uid('notification-other'), role: 'student' },
    ],
  });
  const audit = makeAuditWriter(new InMemoryAuditRepository(), now);
  const identities = new IdentityServiceImpl({ roles, audit });
  const sessions = makeSessionStore(new InMemorySessionRepository(), now);
  tokens = {
    student: (await sessions.create({ userId: uid('notification-student'), login: 'student', displayName: 'Student', roles: ['student'] }, 60_000)).token,
    other: (await sessions.create({ userId: uid('notification-other'), login: 'other', displayName: 'Other', roles: ['student'] }, 60_000)).token,
  };
  repository = new MemoryNotifications();
  services = { sessions, identities, audit, notifications: new NotificationsService(repository) };
  configureServices(services);
});

const request = (url: string, method = 'GET', token?: string, body?: unknown) => new Request(`http://localhost${url}`, {
  method,
  headers: { ...(token ? { cookie: `session=${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  body: body === undefined ? undefined : JSON.stringify(body),
});

describe('in-app notification API', () => {
  it('requires authentication and only lists the signed-in user’s notifications', async () => {
    await repository.create({ recipientId: uid('notification-student'), eventType: 'review.decision', deduplicationKey: 'r1', payload: { status: 'passed' } });
    await repository.create({ recipientId: uid('notification-other'), eventType: 'review.decision', deduplicationKey: 'r2', payload: { status: 'failed' } });

    expect((await GET_NOTIFICATIONS(request('/api/v1/notifications'))).status).toBe(401);
    const response = await GET_NOTIFICATIONS(request('/api/v1/notifications?unreadOnly=true', 'GET', tokens.student));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ notifications: [{ recipientId: 'notification-student', deduplicationKey: 'r1' }] });
  });

  it('persists read state and prevents another user from marking a notification read', async () => {
    const row = await repository.create({ recipientId: uid('notification-student'), eventType: 'review.decision', deduplicationKey: 'r1', payload: {} });

    const denied = await PATCH_NOTIFICATION(request(`/api/v1/notifications/${row.id}`, 'PATCH', tokens.other, { read: true }), { params: Promise.resolve({ notificationId: row.id }) });
    expect(denied.status).toBe(404);
    const marked = await PATCH_NOTIFICATION(request(`/api/v1/notifications/${row.id}`, 'PATCH', tokens.student, { read: true }), { params: Promise.resolve({ notificationId: row.id }) });
    expect(marked.status).toBe(200);
    await expect((await GET_NOTIFICATIONS(request('/api/v1/notifications?unreadOnly=true', 'GET', tokens.student))).json()).resolves.toMatchObject({ notifications: [] });
    expect((await PATCH_NOTIFICATION(request(`/api/v1/notifications/${row.id}`, 'PATCH', tokens.student, { read: 'yes' }), { params: Promise.resolve({ notificationId: row.id }) })).status).toBe(400);
  });

  it('returns enabled defaults, persists preference changes, and suppresses disabled in-app delivery', async () => {
    const initial = await GET_PREFERENCES(request('/api/v1/notifications/preferences', 'GET', tokens.student));
    expect(await initial.json()).toEqual({ preferences: [
      { channel: 'in_app', enabled: true }, { channel: 'email', enabled: false }, { channel: 'telegram', enabled: true },
    ] });

    expect((await PATCH_PREFERENCES(request('/api/v1/notifications/preferences', 'PATCH', tokens.student, { channel: 'in_app', enabled: false }))).status).toBe(200);
    expect(await GET_PREFERENCES(request('/api/v1/notifications/preferences', 'GET', tokens.student)).then((response) => response.json())).toEqual({ preferences: [
      { channel: 'in_app', enabled: false }, { channel: 'email', enabled: false }, { channel: 'telegram', enabled: true },
    ] });
    expect(await services.notifications?.notify({ recipientId: uid('notification-student'), eventType: 'review.decision', deduplicationKey: 'r3', payload: {} })).toBeNull();
    expect(repository.rows).toHaveLength(0);
  });

  it('rejects malformed preference input and reports missing service configuration', async () => {
    expect((await PATCH_PREFERENCES(request('/api/v1/notifications/preferences', 'PATCH', tokens.student, { channel: 'sms', enabled: true }))).status).toBe(400);
    configureServices({ ...services, notifications: undefined });
    expect((await GET_NOTIFICATIONS(request('/api/v1/notifications', 'GET', tokens.student))).status).toBe(503);
  });
});
