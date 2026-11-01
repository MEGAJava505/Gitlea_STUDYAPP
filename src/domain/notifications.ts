import { errors } from '../shared/contracts';
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
    return this.repository.create(input);
  }

  list(userId: UserId, unreadOnly = false): Promise<NotificationRecord[]> {
    return this.repository.list(userId, { unreadOnly });
  }

  markRead(userId: UserId, notificationId: string): Promise<boolean> {
    return this.repository.markRead(userId, notificationId);
  }

  async getPreferences(userId: UserId): Promise<NotificationPreferenceRecord[]> {
    const preferences = await this.repository.getPreferences(userId);
    return preferences.map((preference) => preference.channel === 'in_app' ? { ...preference, enabled: true } : preference);
  }

  async setPreference(userId: UserId, channel: NotificationChannel, enabled: boolean): Promise<void> {
    if (channel === 'in_app' && !enabled) throw errors.invalidInput('In-app notifications are always available');
    return this.repository.setPreference(userId, channel, enabled);
  }
}
