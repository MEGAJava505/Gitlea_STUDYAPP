import { afterEach, describe, expect, it } from 'vitest';
import { migrateDatabase, openSqliteDatabase } from '../../src/db/migrate';
import { DbNotificationsRepository } from '../../src/server/db-notifications-repository';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as tables from '../../src/db/schema';
import * as relations from '../../src/db/relations';
import type { UserId } from '../../src/shared/contracts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directories: string[] = [];
const handles: ReturnType<typeof openSqliteDatabase>[] = [];

afterEach(() => {
  for (const db of handles.splice(0)) db.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'notifications-'));
  directories.push(directory);
  const databaseUrl = `file:${join(directory, 'test.sqlite')}`;
  await migrateDatabase(databaseUrl);
  const db = openSqliteDatabase(databaseUrl);
  handles.push(db);
  db.prepare(`INSERT INTO users (id, gitea_id, login, email, display_name) VALUES ('student-1', 1, 'student', 's@example.test', 'Student')`).run();
  const repo = new DbNotificationsRepository(drizzle(db, { schema: { ...tables, ...relations } }), () => 1234);
  return { db, repo, userId: 'student-1' as UserId };
}

describe('notification SQLite repository', () => {
  it('persists in-app preferences and deduplicates by recipient and key', async () => {
    const { db, repo, userId } = await setup();

    expect(await repo.getPreferences(userId)).toEqual([
      { channel: 'in_app', enabled: true },
      { channel: 'email', enabled: false },
      { channel: 'telegram', enabled: true },
    ]);
    await expect(repo.setPreference(userId, 'in_app', false)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    db.prepare("INSERT INTO notification_preferences (id, user_id, channel, enabled) VALUES ('legacy-in-app', ?, 'in_app', 0)").run(userId);
    expect(await repo.getPreferences(userId)).toEqual([
      { channel: 'in_app', enabled: true },
      { channel: 'email', enabled: false },
      { channel: 'telegram', enabled: true },
    ]);

    const input = {
      recipientId: userId,
      eventType: 'review.decision',
      deduplicationKey: 'review:submission-1:passed',
      payload: { submissionId: 'submission-1', status: 'passed' },
    };
    const first = await repo.create(input);
    const duplicate = await repo.create({ ...input, payload: { changed: true } });
    expect(duplicate).toEqual(first);
    expect(await repo.list(userId, { unreadOnly: true })).toHaveLength(1);
  });

  it('lists only the recipient’s notifications and persists read state', async () => {
    const { db, repo, userId } = await setup();
    db.prepare(`INSERT INTO users (id, gitea_id, login, email, display_name) VALUES ('student-2', 2, 'student2', 's2@example.test', 'Student 2')`).run();
    const notification = await repo.create({
      recipientId: userId,
      eventType: 'review.decision',
      deduplicationKey: 'review:submission-2:failed',
      payload: { status: 'failed' },
    });
    await repo.create({
      recipientId: 'student-2' as UserId,
      eventType: 'review.decision',
      deduplicationKey: 'review:submission-2:failed',
      payload: { status: 'failed' },
    });

    expect(await repo.list(userId)).toMatchObject([{ id: notification.id, readAt: null }]);
    expect(await repo.markRead(userId, notification.id)).toBe(true);
    expect(await repo.list(userId, { unreadOnly: true })).toEqual([]);
    expect(await repo.list(userId)).toMatchObject([{ id: notification.id, readAt: 1234 }]);
    expect(await repo.markRead('student-2' as UserId, notification.id)).toBe(false);
  });
});
