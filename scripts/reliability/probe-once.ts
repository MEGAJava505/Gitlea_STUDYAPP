import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { openSqliteDatabase } from '../../src/db/migrate';
import * as relations from '../../src/db/relations';
import { AvailabilityProbeRunner } from '../../src/server/availability-probe-runner';
import { DbAvailabilityIncidentRepository } from '../../src/server/db-availability-incident-repository';

interface ProbeOptions {
  appUrl: string;
  giteaUrl: string;
  databaseUrl: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

/** Run against an already migrated database. Schedule externally; no web process dependency. */
export async function runAvailabilityOnce(options: ProbeOptions): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 5000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) {
    throw new Error('Invalid probe timeout');
  }
  const services = [['app', options.appUrl], ['gitea', options.giteaUrl]] as const;
  for (const [, value] of services) {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('Invalid probe URL');
    }
  }
  const sqlite = openSqliteDatabase(options.databaseUrl);
  try {
    const repository = new DbAvailabilityIncidentRepository(drizzle(sqlite, { schema: relations }));
    // Wait for both independent services before closing the shared connection,
    // including when one persistence operation fails.
    const results = await Promise.allSettled(services.map(([service, url]) =>
      new AvailabilityProbeRunner(repository, service, async () => {
        const response = await (options.fetch ?? globalThis.fetch)(url, {
          signal: AbortSignal.timeout(timeoutMs), redirect: 'manual',
        });
        await response.body?.cancel();
        return { available: response.ok, details: response.ok ? '' : 'HTTP unavailable' };
      }, options.now).runOnce(),
    ));
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  } finally {
    sqlite.close();
  }
}

// Usage: DATABASE_URL=file:... AVAILABILITY_APP_URL=http://.../health
// AVAILABILITY_GITEA_URL=http://.../api/healthz npm run availability:once -- --once
// The configured database must be migrated and accessible to this external process.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { AVAILABILITY_APP_URL, AVAILABILITY_GITEA_URL, DATABASE_URL, AVAILABILITY_TIMEOUT_MS } = process.env;
  if (process.argv.slice(2).join(' ') !== '--once' || !AVAILABILITY_APP_URL || !AVAILABILITY_GITEA_URL || !DATABASE_URL) {
    console.error('Use --once with AVAILABILITY_APP_URL, AVAILABILITY_GITEA_URL and DATABASE_URL');
    process.exitCode = 1;
  } else {
    runAvailabilityOnce({
      appUrl: AVAILABILITY_APP_URL, giteaUrl: AVAILABILITY_GITEA_URL, databaseUrl: DATABASE_URL,
      timeoutMs: AVAILABILITY_TIMEOUT_MS === undefined ? undefined : Number(AVAILABILITY_TIMEOUT_MS),
    }).then(() => {
      console.log('Availability probes persisted');
    }).catch(() => {
      console.error('Availability probe run failed');
      process.exitCode = 1;
    });
  }
}
