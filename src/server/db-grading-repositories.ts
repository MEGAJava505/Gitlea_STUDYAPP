import { and, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { desc, inArray } from 'drizzle-orm';
import {
  type ReviewQueryRepository,
  type ReviewRecord,
  type SubmissionId,
  type SystemSetting,
  type SystemSettingsRepository,
} from '../shared/contracts';
import { reviews as reviewsTable, systemSettings as systemSettingsTable } from '../db/schema';
import * as relations from '../db/relations';

type Db = BetterSQLite3Database<typeof relations>;

/**
 * SQLite SystemSettingsRepository (drizzle). `system_settings.value` is a JSON
 * column; the stored value is round-tripped unchanged so callers decide shape.
 */
export class DbSystemSettingsRepository implements SystemSettingsRepository {
  constructor(private readonly db: Db) {}

  async get(key: string): Promise<SystemSetting | null> {
    const row = this.db
      .select()
      .from(systemSettingsTable)
      .where(eq(systemSettingsTable.key, key))
      .get();
    if (!row) return null;
    return { id: row.id, key: row.key, value: row.value, updatedAt: row.updatedAt };
  }

  async set(key: string, value: unknown): Promise<void> {
    const now = Date.now();
    // UPSERT: a toggle may be flipped repeatedly over the product's lifetime.
    this.db
      .insert(systemSettingsTable)
      .values({ key, value })
      .onConflictDoUpdate({
        target: systemSettingsTable.key,
        set: { value, updatedAt: now },
      })
      .run();
  }
}

/**
 * SQLite ReviewQueryRepository (drizzle) for the grading / review-UI read
 * surfaces. Only the single active review per submission is ever returned.
 */
export class DbReviewQueryRepository implements ReviewQueryRepository {
  constructor(private readonly db: Db) {}

  async getLatestActiveReview(submissionId: SubmissionId): Promise<ReviewRecord | null> {
    const row = this.db
      .select()
      .from(reviewsTable)
      .where(and(eq(reviewsTable.submissionId, submissionId), eq(reviewsTable.isActive, true)))
      .orderBy(desc(reviewsTable.createdAt))
      .get();
    if (!row) return null;
    return toReviewRecord(row);
  }

  async listReviewsForReview(submissionIds: readonly SubmissionId[]): Promise<ReviewRecord[]> {
    if (submissionIds.length === 0) return [];
    const rows = this.db
      .select()
      .from(reviewsTable)
      .where(and(inArray(reviewsTable.submissionId, [...submissionIds]), eq(reviewsTable.isActive, true)))
      .orderBy(desc(reviewsTable.createdAt))
      .all();
    return rows.map(toReviewRecord);
  }
}

function toReviewRecord(row: typeof reviewsTable.$inferSelect): ReviewRecord {
  const grade = typeof row.grade === 'number' && Number.isInteger(row.grade) && row.grade >= 1 && row.grade <= 5
    ? (row.grade as ReviewRecord['grade'])
    : null;
  // `reviews.decision` stores the terminal status ('passed'/'failed');
  // ReviewRecord.decision is the teacher's action ('pass'/'fail').
  const decision = row.decision === 'passed' ? 'pass' : 'fail';
  return {
    id: row.id as ReviewRecord['id'],
    submissionId: row.submissionId as SubmissionId,
    reviewerId: row.reviewerId as ReviewRecord['reviewerId'],
    decision,
    feedback: row.feedback,
    grade,
    isActive: row.isActive,
    createdAt: row.createdAt,
  };
}
