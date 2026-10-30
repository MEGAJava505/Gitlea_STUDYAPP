import { SystemSettingsRepository } from '../../shared/contracts';

export type { SystemSettingsRepository } from '../../shared/contracts';

export interface NumericGradingToggle {
  /** Returns true when numeric grading (1–5) is enabled for teachers to record. */
  isEnabled(): Promise<boolean>;
}

/**
 * Minimal numeric grading toggle backed by a system setting key.
 * Default OFF (disabled) per PLAN_GITEA.md §11.2.
 */
export class NumericGradingToggleImpl implements NumericGradingToggle {
  constructor(
    private readonly repo: SystemSettingsRepository,
    private readonly key = 'numeric_grading.enabled',
  ) {}

  async isEnabled(): Promise<boolean> {
    const row = await this.repo.get(this.key);
    if (!row) return false;
    const v = row.value as { enabled?: boolean } | boolean | null;
    if (typeof v === 'boolean') return v;
    if (v && typeof v === 'object' && typeof v.enabled === 'boolean') return v.enabled;
    return false;
  }
}
