import type { SweepResult } from '../../domain/assignments/deadline-sweeper';
import { getServices } from '../auth-context';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Runs one deadline sweep through the service container, so it shares the
 * application's database handle and audit writer (PLAN_GITEA.md §9.3).
 */
export async function runDeadlineSweep(): Promise<SweepResult> {
  const sweeper = getServices().deadlineSweeper;
  if (!sweeper) throw new Error('Deadline sweeper is not configured');
  return sweeper.sweep();
}

/**
 * Starts the in-process sweep schedule: one sweep immediately, then every
 * `DEADLINE_SWEEP_INTERVAL_MS` (default 5 minutes). Sweeps never overlap and a
 * failed sweep is logged and retried on the next tick. Returns a stop function.
 */
export function startDeadlineSweepSchedule(
  intervalMs = Number(process.env.DEADLINE_SWEEP_INTERVAL_MS) || DEFAULT_INTERVAL_MS,
  log: (message: string) => void = console.log,
): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await runDeadlineSweep();
      if (result.failedNoSubmission || result.failedUnresolvedRevision) {
        log(`[DeadlineSweeper] failed ${result.failedNoSubmission} without submission, ${result.failedUnresolvedRevision} unresolved revision`);
      }
    } catch (err) {
      log(`[DeadlineSweeper] sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
