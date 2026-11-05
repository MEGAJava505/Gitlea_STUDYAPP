import { describe, expect, it } from 'vitest';
import { AvailabilityMonitor } from '../../src/domain/reliability/availability-monitor';

describe('independent availability monitor', () => {
  it('deduplicates an outage and confirms recovery exactly once', () => {
    const monitor = new AvailabilityMonitor(() => 100);
    const first = monitor.recordProbe({ service: 'web', available: false, checkedAt: 1_000, details: 'timeout' });
    const retry = monitor.recordProbe({ service: 'web', available: false, checkedAt: 2_000 });
    expect(retry?.id).toBe(first?.id);
    expect(retry?.startedAt).toBe(1_000);

    const recovered = monitor.recordProbe({ service: 'web', available: true, checkedAt: 3_000 });
    expect(recovered).toMatchObject({ id: first?.id, recoveredAt: 3_000, confirmed: true });
    const repeatedRecovery = monitor.recordProbe({ service: 'web', available: true, checkedAt: 4_000 });
    expect(repeatedRecovery?.recoveredAt).toBe(3_000);
  });

  it('starts a fresh incident after the previous one is persisted', () => {
    const monitor = new AvailabilityMonitor();
    const first = monitor.recordProbe({ service: 'gitea', available: false, checkedAt: 10 });
    monitor.recordProbe({ service: 'gitea', available: true, checkedAt: 20 });
    monitor.forgetRecovered('gitea');
    const second = monitor.recordProbe({ service: 'gitea', available: false, checkedAt: 30 });
    expect(second?.id).not.toBe(first?.id);
    expect(second?.startedAt).toBe(30);
  });
});
