import type {
  AuditLogWriter,
  Clock,
  NumericGrade,
  ReviewQueryRepository,
  ReviewRecord,
  SubmissionId,
  SystemSettingsRepository,
} from '../../shared/contracts';
import { NumericGradingToggleImpl } from './toggle';

/**
 * Domain core for numeric grading (PLAN_GITEA.md §11.2, Phase 5).
 *
 * The toggle gates two things independently of where a grade is *stored*:
 *  - teachers may only attach a numeric grade to a review when enabled;
 *  - students can only *see* a recorded grade when enabled. A grade recorded
 *    before the toggle was on (or after it is turned off again) is preserved
 *    on disk but never exposed to students until re-enabled.
 */
export interface GradingDeps {
  settings: SystemSettingsRepository;
  reviews: ReviewQueryRepository;
  audit: AuditLogWriter;
  now: Clock;
}

/** Reads/writes the numeric grading feature toggle and student-visible grades. */
export class GradingService {
  constructor(private readonly deps: GradingDeps) {}

  async isEnabled(): Promise<boolean> {
    return new NumericGradingToggleImpl(this.deps.settings).isEnabled();
  }

  /** Enables or disables numeric grading; persists the setting and audits the change. */
  async setEnabled(enabled: boolean): Promise<void> {
    await this.deps.settings.set('numeric_grading.enabled', { enabled });
    await this.deps.audit.append({
      actorId: null,
      eventType: 'grading.updated',
      targetType: 'system',
      targetId: 'numeric_grading',
      payload: { enabled },
    });
  }

  /**
   * Returns the student's recorded numeric grade when grading is enabled and a
   * graded review exists; null otherwise. Hidden from students whenever the
   * toggle is off, even though the grade remains persisted on disk.
   */
  async getStudentGrade(submissionId: SubmissionId): Promise<NumericGrade | null> {
    if (!(await this.isEnabled())) return null;
    const review = await this.deps.reviews.getLatestActiveReview(submissionId);
    return review?.grade ?? null;
  }

  /** All graded reviews for the given submissions (teacher surface only). */
  async listReviews(submissionIds: readonly SubmissionId[]): Promise<ReviewRecord[]> {
    const enabled = await this.isEnabled();
    const reviews = await this.deps.reviews.listReviewsForReview(submissionIds);
    return enabled ? reviews : reviews.map((review) => ({ ...review, grade: null }));
  }
}
