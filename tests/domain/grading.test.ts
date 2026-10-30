import { describe, expect, it } from 'vitest';
import { GradingService } from '../../src/domain/grading/service';
import type {
  AuditLogWriter,
  ReviewQueryRepository,
  SystemSettingsRepository,
} from '../../src/shared/contracts';

const now0 = 1_700_000_000_000;

function audit(): AuditLogWriter {
  const events: { eventType: string; payload: Record<string, unknown> }[] = [];
  return {
    async append(input) { events.push({ eventType: input.eventType, payload: input.payload }); },
    _events: events,
  } as AuditLogWriter & { _events: { eventType: string; payload: Record<string, unknown> }[] };
}

function settingsRepo(value: unknown | null, present = value !== null): SystemSettingsRepository {
  const rows = new Map<string, { id: string; key: string; value: unknown; updatedAt: number }>();
  if (present) rows.set('numeric_grading.enabled', { id: 's1', key: 'numeric_grading.enabled', value, updatedAt: now0 });
  return {
    async get(key) { return rows.get(key) ?? null; },
    async set(key, v) { rows.set(key, { id: 's1', key, value: v, updatedAt: now0 }); },
  };
}

function reviewRepo(reviews: { submissionId: string; reviewerId: string; decision: 'pass' | 'fail'; feedback: string; grade: number | null; createdAt: number }[]): ReviewQueryRepository {
  return {
    async getLatestActiveReview(submissionId) {
      const match = reviews.filter((r) => r.submissionId === submissionId);
      if (match.length === 0) return null;
      const latest = match.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));
      return {
        id: `rv-${submissionId}`,
        submissionId,
        reviewerId: latest.reviewerId,
        decision: latest.decision,
        feedback: latest.feedback,
        grade: latest.grade,
        isActive: true,
        createdAt: latest.createdAt,
      };
    },
    async listReviewsForReview(submissionIds) {
      const set = new Set(submissionIds);
      return reviews.filter((r) => set.has(r.submissionId)).map((r) => ({
        id: `rv-${r.submissionId}`, submissionId: r.submissionId, reviewerId: r.reviewerId,
        decision: r.decision, feedback: r.feedback, grade: r.grade, isActive: true, createdAt: r.createdAt,
      }));
    },
  };
}

describe('GradingService', () => {
  it('isEnabled is false by default (no setting row)', async () => {
    const s = new GradingService({ settings: settingsRepo(null, false), reviews: reviewRepo([]), audit: audit(), now: () => now0 });
    expect(await s.isEnabled()).toBe(false);
  });

  it('isEnabled reflects the stored setting', async () => {
    const off = new GradingService({ settings: settingsRepo({ enabled: false }), reviews: reviewRepo([]), audit: audit(), now: () => now0 });
    const on = new GradingService({ settings: settingsRepo({ enabled: true }), reviews: reviewRepo([]), audit: audit(), now: () => now0 });
    expect(await off.isEnabled()).toBe(false);
    expect(await on.isEnabled()).toBe(true);
  });

  it('setEnabled persists the toggle and audits grading.updated', async () => {
    const settings = settingsRepo(null, false);
    const a = audit() as ReturnType<typeof audit> & { _events: { eventType: string; payload: Record<string, unknown> }[] };
    const s = new GradingService({ settings, reviews: reviewRepo([]), audit: a, now: () => now0 });
    await s.setEnabled(true);
    expect(await s.isEnabled()).toBe(true);
    const ev = a._events.find((e) => e.eventType === 'grading.updated');
    expect(ev).toBeTruthy();
    expect(ev?.payload).toMatchObject({ enabled: true });
  });

  it('getStudentGrade is null when grading is disabled, even if a grade is stored (hidden from students)', async () => {
    const reviews = [
      { submissionId: 'sub1', reviewerId: 't1', decision: 'pass' as const, feedback: 'ok', grade: 5, createdAt: now0 + 1 },
    ];
    const off = new GradingService({ settings: settingsRepo({ enabled: false }), reviews: reviewRepo(reviews), audit: audit(), now: () => now0 });
    expect(await off.getStudentGrade('sub1')).toBeNull();
  });

  it('getStudentGrade returns the grade when enabled and a review exists', async () => {
    const reviews = [
      { submissionId: 'sub1', reviewerId: 't1', decision: 'pass' as const, feedback: 'ok', grade: 4, createdAt: now0 + 1 },
    ];
    const on = new GradingService({ settings: settingsRepo({ enabled: true }), reviews: reviewRepo(reviews), audit: audit(), now: () => now0 });
    expect(await on.getStudentGrade('sub1')).toBe(4);
  });

  it('preserves a recorded grade while disabled and exposes it again after re-enabling', async () => {
    const reviews = [{ submissionId: 'sub1', reviewerId: 't1', decision: 'pass' as const, feedback: 'ok', grade: 5, createdAt: now0 }];
    const service = new GradingService({ settings: settingsRepo(true), reviews: reviewRepo(reviews), audit: audit(), now: () => now0 });
    expect(await service.getStudentGrade('sub1')).toBe(5);
    await service.setEnabled(false);
    expect(await service.getStudentGrade('sub1')).toBeNull();
    await service.setEnabled(true);
    expect(await service.getStudentGrade('sub1')).toBe(5);
    expect(reviews[0]?.grade).toBe(5);
  });

  it('getStudentGrade is null when enabled but no review exists yet', async () => {
    const on = new GradingService({ settings: settingsRepo({ enabled: true }), reviews: reviewRepo([]), audit: audit(), now: () => now0 });
    expect(await on.getStudentGrade('sub1')).toBeNull();
  });

  it('getStudentGrade is null for a review that carried no numeric grade', async () => {
    const reviews = [
      { submissionId: 'sub1', reviewerId: 't1', decision: 'pass' as const, feedback: 'ok', grade: null, createdAt: now0 + 1 },
    ];
    const on = new GradingService({ settings: settingsRepo({ enabled: true }), reviews: reviewRepo(reviews), audit: audit(), now: () => now0 });
    expect(await on.getStudentGrade('sub1')).toBeNull();
  });
});
