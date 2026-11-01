import { and, desc, eq, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type {
  NotificationChannel,
  NotificationPreferenceRecord,
  NotificationRecord,
  NotificationRepository,
  UserId,
} from '../shared/contracts';
import { notificationChannels, notificationPreferences, notifications } from '../db/schema';
import * as relations from '../db/relations';

type Db = BetterSQLite3Database<typeof relations>;

const channels: readonly NotificationChannel[] = notificationChannels;

/** SQLite-backed persistence for notification delivery and preferences. */
export class DbNotificationsRepository implements NotificationRepository {
  constructor(private readonly db: Db, private readonly now: () => number = Date.now) {}

  async create(input: Omit<NotificationRecord, 'id' | 'readAt' | 'createdAt'>): Promise<NotificationRecord> {
    this.db.insert(notifications).values({
      recipientId: input.recipientId,
      eventType: input.eventType,
      deduplicationKey: input.deduplicationKey,
      payload: input.payload,
    }).onConflictDoNothing({ target: [notifications.recipientId, notifications.deduplicationKey] }).run();
    const row = this.db.select().from(notifications)
      .where(and(eq(notifications.recipientId, input.recipientId), eq(notifications.deduplicationKey, input.deduplicationKey)))
      .get();
    if (!row) throw new Error('Notification insert did not produce a row');
    return toNotification(row);
  }

  async list(recipientId: UserId, options: { unreadOnly?: boolean } = {}): Promise<NotificationRecord[]> {
    const query = this.db.select().from(notifications).where(options.unreadOnly
      ? and(eq(notifications.recipientId, recipientId), isNull(notifications.readAt))
      : eq(notifications.recipientId, recipientId));
    return query.orderBy(desc(notifications.createdAt), desc(notifications.id)).all().map(toNotification);
  }

  async markRead(recipientId: UserId, notificationId: string): Promise<boolean> {
    const result = this.db.update(notifications).set({ readAt: this.now() })
      .where(and(eq(notifications.id, notificationId), eq(notifications.recipientId, recipientId), isNull(notifications.readAt)))
      .run();
    if (result.changes > 0) return true;
    return Boolean(this.db.select({ id: notifications.id }).from(notifications)
      .where(and(eq(notifications.id, notificationId), eq(notifications.recipientId, recipientId))).get());
  }

  async getPreferences(userId: UserId): Promise<NotificationPreferenceRecord[]> {
    const stored = this.db.select().from(notificationPreferences).where(eq(notificationPreferences.userId, userId)).all();
    const byChannel = new Map(stored.map((row) => [row.channel, row.enabled]));
    return channels.map((channel) => ({ channel, enabled: byChannel.get(channel) ?? true }));
  }

  async setPreference(userId: UserId, channel: NotificationChannel, enabled: boolean): Promise<void> {
    this.db.insert(notificationPreferences).values({ userId, channel, enabled })
      .onConflictDoUpdate({
        target: [notificationPreferences.userId, notificationPreferences.channel],
        set: { enabled, updatedAt: this.now() },
      }).run();
  }
}

function toNotification(row: typeof notifications.$inferSelect): NotificationRecord {
  return {
    id: row.id,
    recipientId: row.recipientId as UserId,
    eventType: row.eventType,
    deduplicationKey: row.deduplicationKey,
    payload: row.payload,
    readAt: row.readAt,
    createdAt: row.createdAt,
  };
}
