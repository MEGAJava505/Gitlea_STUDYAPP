import { afterEach, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { migrateDatabase, openSqliteDatabase } from '../../src/db/migrate';
import { DbAvailabilityIncidentRepository } from '../../src/server/db-availability-incident-repository';
import * as tables from '../../src/db/schema';
import * as relations from '../../src/db/relations';

type Handle = ReturnType<typeof openSqliteDatabase>;
const handles: Handle[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'availability-'));
  directories.push(directory);
  const databaseUrl = `file:${join(directory, 'probe.sqlite')}`;
  await migrateDatabase(databaseUrl);
  const sqlite = openSqliteDatabase(databaseUrl);
  handles.push(sqlite);
  return { databaseUrl, sqlite };
}

function repository(sqlite: Handle, now = () => 50_000) {
  return new DbAvailabilityIncidentRepository(drizzle(sqlite, { schema: { ...tables, ...relations } }), now);
}

describe('durable independent availability incidents', () => {
  it('deduplicates an outage, hydrates it after restart, and persists recovery', async () => {
    const { databaseUrl, sqlite } = await setup();
    const first = repository(sqlite, () => 10_000);

    const opened = first.recordProbe({ service: 'gitea', available: false, checkedAt: 100, details: 'timeout' });
    expect(opened).toMatchObject({ service: 'gitea', startedAt: 100, recoveredAt: null, confirmed: false, details: 'timeout' });
    expect(first.recordProbe({ service: 'gitea', available: false, checkedAt: 200, details: 'retry' })).toEqual(opened);
    expect(sqlite.prepare('SELECT count(*) AS count FROM outage_incidents WHERE service = ?').get('gitea')).toEqual({ count: 1 });

    sqlite.close();
    handles.splice(handles.indexOf(sqlite), 1);
    const reopened = openSqliteDatabase(databaseUrl);
    handles.push(reopened);
    const afterRestart = repository(reopened);
    expect(afterRestart.listOpen('gitea')).toMatchObject([{ id: opened?.id, startedAt: 100, recoveredAt: null }]);

    const recovered = afterRestart.recordProbe({ service: 'gitea', available: true, checkedAt: 300 });
    expect(recovered).toMatchObject({ id: opened?.id, startedAt: 100, recoveredAt: 300, confirmed: true });
    expect(afterRestart.listOpen('gitea')).toEqual([]);
    expect(reopened.prepare('SELECT ended_at, confirmed FROM outage_incidents WHERE id = ?').get(opened?.id)).toEqual({ ended_at: 300, confirmed: 1 });

    reopened.close();
    handles.splice(handles.indexOf(reopened), 1);
    const secondRestart = openSqliteDatabase(databaseUrl);
    handles.push(secondRestart);
    const newIncident = repository(secondRestart);
    expect(newIncident.recordProbe({ service: 'gitea', available: false, checkedAt: 400, details: 'second outage' })).toMatchObject({
      service: 'gitea', startedAt: 400, recoveredAt: null, details: 'second outage',
    });
    expect(secondRestart.prepare('SELECT count(*) AS count FROM outage_incidents WHERE service = ?').get('gitea')).toEqual({ count: 2 });
  });

  it('migrates the open-service uniqueness guard', async () => {
    const { sqlite } = await setup();
    const index = sqlite.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'outage_incidents_one_open_per_service'").get() as { sql: string } | undefined;
    expect(index?.sql).toMatch(/UNIQUE INDEX/i);
    sqlite.prepare("INSERT INTO outage_incidents (id, service, started_at) VALUES ('one', 'web', 1)").run();
    expect(() => sqlite.prepare("INSERT INTO outage_incidents (id, service, started_at) VALUES ('two', 'web', 2)").run()).toThrow(/UNIQUE/i);
    sqlite.prepare("UPDATE outage_incidents SET ended_at = 3, confirmed = 1 WHERE id = 'one'").run();
    expect(() => sqlite.prepare("INSERT INTO outage_incidents (id, service, started_at) VALUES ('two', 'web', 2)").run()).not.toThrow();
  });
});
