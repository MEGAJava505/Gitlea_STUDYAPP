import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureServices, type AppServices } from '../../src/server/auth-context';
import { runDeadlineSweep, startDeadlineSweepSchedule } from '../../src/server/scheduled/deadline-sweeper-job';
import type { DeadlineSweeper } from '../../src/domain/assignments/deadline-sweeper';

function withSweeper(sweep: () => Promise<{ failedNoSubmission: number; failedUnresolvedRevision: number }>) {
  configureServices({ deadlineSweeper: { sweep } as unknown as DeadlineSweeper } as AppServices);
}

describe('deadline sweep schedule', () => {
  afterEach(() => vi.useRealTimers());

  it('runs the container sweeper', async () => {
    const sweep = vi.fn(async () => ({ failedNoSubmission: 2, failedUnresolvedRevision: 1 }));
    withSweeper(sweep);
    await expect(runDeadlineSweep()).resolves.toEqual({ failedNoSubmission: 2, failedUnresolvedRevision: 1 });
  });

  it('sweeps immediately and on every interval, surviving a failed sweep', async () => {
    vi.useFakeTimers();
    const sweep = vi.fn()
      .mockRejectedValueOnce(new Error('db locked'))
      .mockResolvedValue({ failedNoSubmission: 0, failedUnresolvedRevision: 0 });
    withSweeper(sweep);
    const logs: string[] = [];
    const stop = startDeadlineSweepSchedule(1000, (m) => logs.push(m));
    await vi.advanceTimersByTimeAsync(0);
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(logs[0]).toContain('db locked');
    await vi.advanceTimersByTimeAsync(2000);
    expect(sweep).toHaveBeenCalledTimes(3);
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(sweep).toHaveBeenCalledTimes(3);
  });
});
