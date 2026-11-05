import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { migrateDatabase, openSqliteDatabase } from '../../src/db/migrate';
import { runAvailabilityOnce } from '../../scripts/reliability/probe-once';

it('runs independently over real HTTP, persists failure and recovery across SQLite reopen, and executes as a CLI', async () => {
  let appStatus = 503;
  let giteaHangs = false;
  const app = createServer((_req, res) => { res.writeHead(appStatus); res.end(); });
  const gitea = createServer((_req, res) => { if (!giteaHangs) { res.writeHead(200); res.end(); } });
  const listen = (server: typeof app) => new Promise<string>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address !== 'string') resolve(`http://127.0.0.1:${address.port}`);
    });
  });
  const directory = mkdtempSync(join(tmpdir(), 'availability-cli-'));
  const databaseUrl = `file:${join(directory, 'probe.sqlite')}`;
  try {
    const appUrl = await listen(app);
    const giteaUrl = await listen(gitea);
    await migrateDatabase(databaseUrl);
    const read = () => {
      const db = openSqliteDatabase(databaseUrl);
      try { return db.prepare('SELECT service, started_at, ended_at, confirmed, details FROM outage_incidents ORDER BY started_at').all(); }
      finally { db.close(); }
    };
    // Give ordinary local HTTP responses a realistic budget. The hanging
    // fixture below deliberately uses a short, deterministic timeout instead
    // of making healthy responses race the abort deadline.
    const options = { appUrl, giteaUrl, databaseUrl, timeoutMs: 1000 };
    await runAvailabilityOnce({ ...options, now: () => 100 });
    expect(read()).toEqual([{ service: 'app', started_at: 100, ended_at: null, confirmed: 0, details: 'HTTP unavailable' }]);
    appStatus = 200; giteaHangs = true;
    await runAvailabilityOnce({ ...options, timeoutMs: 100, now: () => 200 });
    expect(read()).toMatchObject([
      { service: 'app', ended_at: 200, confirmed: 1 },
      { service: 'gitea', started_at: 200, ended_at: null, details: 'Availability probe failed' },
    ]);
    giteaHangs = false;
    await runAvailabilityOnce({ ...options, now: () => 300 });
    expect(read()).toMatchObject([{ ended_at: 200 }, { ended_at: 300, confirmed: 1 }]);
    await runAvailabilityOnce({ ...options, now: () => 400, fetch: () => { throw new Error('secret-url'); } });
    expect(JSON.stringify(read())).not.toContain('secret-url');
    expect(read()).toHaveLength(4);
    const result = await new Promise<{ code: number | null; output: string }>((resolve) => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/reliability/probe-once.ts', '--once'], {
        env: { ...process.env, AVAILABILITY_APP_URL: appUrl, AVAILABILITY_GITEA_URL: giteaUrl, DATABASE_URL: databaseUrl },
      });
      let output = '';
      child.stdout.on('data', (data) => { output += data; });
      child.stderr.on('data', (data) => { output += data; });
      child.on('close', (code) => resolve({ code, output }));
    });
    expect(result).toEqual({ code: 0, output: 'Availability probes persisted\n' });
    expect(read()).toMatchObject([{ confirmed: 1 }, { confirmed: 1 }, { confirmed: 1 }, { confirmed: 1 }]);
  } finally {
    app.closeAllConnections(); gitea.closeAllConnections();
    await Promise.all([new Promise<void>((resolve) => app.close(() => resolve())), new Promise<void>((resolve) => gitea.close(() => resolve()))]);
    rmSync(directory, { recursive: true, force: true });
  }
}, 15000);
