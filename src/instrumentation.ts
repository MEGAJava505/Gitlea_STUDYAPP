/**
 * Next.js server bootstrap hook. Starts the automatic deadline sweep in the
 * Node.js server process. Set DEADLINE_SWEEP_DISABLED=1 to opt out (e.g. when
 * running more than one app instance against the same database).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs' || process.env.DEADLINE_SWEEP_DISABLED === '1') return;
  const { startDeadlineSweepSchedule } = await import('./server/scheduled/deadline-sweeper-job');
  startDeadlineSweepSchedule();
}
