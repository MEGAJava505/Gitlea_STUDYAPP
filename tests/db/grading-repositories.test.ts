import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { DbReviewQueryRepository, DbSystemSettingsRepository } from '../../src/server/db-grading-repositories';
import { NumericGradingToggleImpl } from '../../src/domain/grading/toggle';
import * as tables from '../../src/db/schema';
import * as relations from '../../src/db/relations';
import type { SubmissionId } from '../../src/shared/contracts';

const sqlite = new Database(':memory:');
const db = drizzle(sqlite, { schema: { ...tables, ...relations } });
sqlite.exec(`CREATE TABLE reviews (
  id TEXT PRIMARY KEY, submission_id TEXT NOT NULL, reviewer_id TEXT NOT NULL,
  decision TEXT NOT NULL, feedback TEXT NOT NULL DEFAULT '', grade REAL,
  is_active INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE system_settings (
  id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, value TEXT, updated_at INTEGER NOT NULL
);`);
afterEach(() => { sqlite.exec('DELETE FROM reviews; DELETE FROM system_settings;'); });

describe('grading SQLite repositories', () => {
  it('finds the active review even when a newer inactive review exists', async () => {
    sqlite.prepare(`INSERT INTO reviews VALUES (?, 'sub1', 'teacher', 'passed', 'ok', ?, ?, ?, 1)`)
      .run('active', 4, 1, 10);
    sqlite.prepare(`INSERT INTO reviews VALUES (?, 'sub1', 'teacher', 'failed', 'old', ?, ?, ?, 1)`)
      .run('inactive', 1, 0, 20);
    const repo = new DbReviewQueryRepository(db);
    await expect(repo.getLatestActiveReview('sub1' as SubmissionId)).resolves.toMatchObject({ id: 'active', grade: 4, decision: 'pass' });
    await expect(repo.listReviewsForReview(['sub1' as SubmissionId])).resolves.toMatchObject([{ id: 'active' }]);
    await expect(repo.getLatestActiveReview('missing' as SubmissionId)).resolves.toBeNull();
    await expect(repo.listReviewsForReview([])).resolves.toEqual([]);
  });

  it('round trips both supported toggle shapes through SQLite and updates the same key', async () => {
    const settings = new DbSystemSettingsRepository(db);
    const toggle = new NumericGradingToggleImpl(settings);
    expect(await toggle.isEnabled()).toBe(false);
    await settings.set('numeric_grading.enabled', true);
    expect(await toggle.isEnabled()).toBe(true);
    await settings.set('numeric_grading.enabled', { enabled: false });
    expect(await toggle.isEnabled()).toBe(false);
    expect(sqlite.prepare('SELECT count(*) AS n FROM system_settings').get()).toEqual({ n: 1 });
  });
});
