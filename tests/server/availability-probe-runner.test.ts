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

  it.each(['throw', 'reject'] as const)('persists a %s from the probe through restart and recovery', async (failure) => {
    const directory = mkdtempSync(join(tmpdir(), 'probe-failure-'));
    directories.push(directory);
    const url = `file:${join(directory, 'runner.sqlite')}`;
    await migrateDatabase(url);
    const firstDb = openSqliteDatabase(url); handles.push(firstDb);
    const firstRepo = new DbAvailabilityIncidentRepository(drizzle(firstDb, { schema: { ...tables, ...relations } }));
    const probe = () => {
      const error = new Error('network failure with sensitive remote details');
      if (failure === 'throw') throw error;
      return Promise.reject(error);
    };
    const down = new AvailabilityProbeRunner(firstRepo, 'gitea', probe, () => 100);
    await expect(down.runOnce()).resolves.toMatchObject({
      service: 'gitea', startedAt: 100, recoveredAt: null, confirmed: false,
      details: 'Availability probe failed',
    });
    const [opened] = firstRepo.listOpen('gitea');
    await expect(down.runOnce()).resolves.toEqual(opened);

    firstDb.close(); handles.splice(handles.indexOf(firstDb), 1);
    const secondDb = openSqliteDatabase(url); handles.push(secondDb);
    const secondRepo = new DbAvailabilityIncidentRepository(drizzle(secondDb, { schema: { ...tables, ...relations } }));
    expect(secondRepo.listOpen('gitea')).toEqual([opened]);
    const up = new AvailabilityProbeRunner(secondRepo, 'gitea', () => ({ available: true }), () => 200);
    await expect(up.runOnce()).resolves.toMatchObject({
      id: opened.id, startedAt: 100, recoveredAt: 200, confirmed: true,
    });
    expect(secondRepo.listOpen('gitea')).toEqual([]);
    expect(secondDb.prepare('SELECT count(*) AS count FROM outage_incidents').get()).toEqual({ count: 1 });
    expect(secondDb.prepare('SELECT ended_at, confirmed FROM outage_incidents').get()).toEqual({ ended_at: 200, confirmed: 1 });
  });

  it.each([false, true])('propagates database failure when probe throws=%s', async (throws) => {
    const directory = mkdtempSync(join(tmpdir(), 'probe-db-failure-'));
    directories.push(directory);
    const url = `file:${join(directory, 'runner.sqlite')}`;
    await migrateDatabase(url);
    const sqlite = openSqliteDatabase(url); handles.push(sqlite);
    sqlite.exec("CREATE TRIGGER reject_incident BEFORE INSERT ON outage_incidents BEGIN SELECT RAISE(ABORT, 'incident persistence failed'); END");
    const repository = new DbAvailabilityIncidentRepository(drizzle(sqlite, { schema: { ...tables, ...relations } }));
    const runner = new AvailabilityProbeRunner(repository, 'gitea', () => {
      if (throws) throw new Error('network failure');
      return { available: false };
    }, () => 100);
    await expect(runner.runOnce()).rejects.toThrow('incident persistence failed');
    expect(repository.listOpen('gitea')).toEqual([]);
  });

});
