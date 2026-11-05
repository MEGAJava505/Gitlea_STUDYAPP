import { afterEach, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { migrateDatabase, openSqliteDatabase } from '../../src/db/migrate';
import { AvailabilityProbeRunner } from '../../src/server/availability-probe-runner';
import { DbAvailabilityIncidentRepository } from '../../src/server/db-availability-incident-repository';
import * as tables from '../../src/db/schema';
import * as relations from '../../src/db/relations';

const handles: Array<ReturnType<typeof openSqliteDatabase>> = [];
const directories: string[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('availability probe runner', () => {
  it('persists probe results through restart with independently injected probes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'probe-runner-'));
    directories.push(directory);
    const url = `file:${join(directory, 'runner.sqlite')}`;
    await migrateDatabase(url);
    const firstDb = openSqliteDatabase(url); handles.push(firstDb);
    const firstRepo = new DbAvailabilityIncidentRepository(drizzle(firstDb, { schema: { ...tables, ...relations } }));
    const down = new AvailabilityProbeRunner(firstRepo, 'gitea', async () => ({ available: false, details: 'timeout' }), () => 100);
    const opened = await down.runOnce();
    expect(opened).toMatchObject({ service: 'gitea', startedAt: 100, recoveredAt: null, details: 'timeout' });

    firstDb.close(); handles.splice(handles.indexOf(firstDb), 1);
    const secondDb = openSqliteDatabase(url); handles.push(secondDb);
    const secondRepo = new DbAvailabilityIncidentRepository(drizzle(secondDb, { schema: { ...tables, ...relations } }));
    const up = new AvailabilityProbeRunner(secondRepo, 'gitea', () => ({ available: true }), () => 200);
    const recovered = await up.runOnce();
    expect(recovered).toMatchObject({ id: opened?.id, startedAt: 100, recoveredAt: 200, confirmed: true });
    expect(secondRepo.listOpen('gitea')).toEqual([]);
  });
});
