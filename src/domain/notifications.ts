import type {
  NotificationChannel,
  NotificationPreferenceRecord,
  NotificationRecord,
  NotificationRepository,
  UserId,
} from '../shared/contracts';

/** Persists in-app notifications and user delivery preferences. */
export class NotificationsService {
  constructor(private readonly repository: NotificationRepository) {}

  async notify(input: {
    recipientId: UserId;
    eventType: string;
    deduplicationKey: string;
    payload: Record<string, unknown>;
  }): Promise<NotificationRecord | null> {
    const preferences = await this.repository.getPreferences(input.recipientId);
    if (!preferences.find((preference) => preference.channel === 'in_app')?.enabled) return null;
    return this.repository.create(input);
  }

  list(userId: UserId, unreadOnly = false): Promise<NotificationRecord[]> {
    return this.repository.list(userId, { unreadOnly });
  }

  markRead(userId: UserId, notificationId: string): Promise<boolean> {
    return this.repository.markRead(userId, notificationId);
  }

  getPreferences(userId: UserId): Promise<NotificationPreferenceRecord[]> {
    return this.repository.getPreferences(userId);
  }

  setPreference(userId: UserId, channel: NotificationChannel, enabled: boolean): Promise<void> {
    return this.repository.setPreference(userId, channel, enabled);
  }
}
