import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { describe, expect, it } from 'vitest';
import { migrateDatabase, openSqliteDatabase } from '../../src/db/migrate';

describe('persisted key migration', () => {
  it('upgrades populated old schema without losing references, guards, defaults or rows; repeats safely', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'key-upgrade-'));
    const filename = join(directory, 'db.sqlite');
    const oldMigrations = join(directory, 'old');
    mkdirSync(join(oldMigrations, 'meta'), { recursive: true });
    const journal = JSON.parse(readFileSync(resolve('drizzle/meta/_journal.json'), 'utf8'));
    journal.entries = journal.entries.slice(0, 3);
    writeFileSync(join(oldMigrations, 'meta/_journal.json'), JSON.stringify(journal));
    for (const entry of journal.entries) {
      writeFileSync(join(oldMigrations, entry.tag + '.sql'), readFileSync(resolve('drizzle', entry.tag + '.sql')));
    }
    const sqlite = openSqliteDatabase(filename);
    try {
      migrate(drizzle(sqlite), { migrationsFolder: oldMigrations });
      sqlite.exec(`
        INSERT INTO users (id,gitea_id,login,email,display_name) VALUES ('u',1,'user','u@example.org','User');
        INSERT INTO groups (id,code,name) VALUES ('g','g','Group');
        INSERT INTO courses (id,owner_id,slug,title) VALUES ('c','u','course','Course');
        INSERT INTO course_assignments (id,course_id,author_id,title) VALUES ('ca','c','u','Assignment');
        INSERT INTO group_assignments (id,course_assignment_id,group_id) VALUES ('ga','ca','g');
        INSERT INTO repository_links (id,group_assignment_id,student_id,gitea_repository_id,full_name)
          VALUES ('l','ga','u',1,'org/repo');
        INSERT INTO submissions (id,repository_link_id,attempt,commit_sha,protected_ref,submitted_at)
          VALUES ('s','l',1,'abc','submission/1',100);
        INSERT INTO reviews (id,submission_id,reviewer_id,decision) VALUES ('r','s','u','passed');
        INSERT INTO test_definitions (id,group_assignment_id,name,source_ref,visibility) VALUES ('td','ga','test','main','visible');
        INSERT INTO test_runs (id,test_definition_id,submission_id,run_key) VALUES ('tr','td','s','run');
      `);
      const before = sqlite.prepare('SELECT * FROM submissions').get() as Record<string, unknown>;
      const triggers = sqlite.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name='submissions' ORDER BY name").all();
      const foreignKeys = sqlite.pragma('foreign_key_list(submissions)');
      await migrateDatabase(filename);
      expect(sqlite.prepare('SELECT * FROM submissions').get()).toEqual({ ...before, idempotency_key: 'legacy:s' });
      expect(sqlite.prepare('SELECT submission_id FROM reviews').get()).toEqual({ submission_id: 's' });
      expect(sqlite.prepare('SELECT submission_id FROM test_runs').get()).toEqual({ submission_id: 's' });
      expect(sqlite.pragma('foreign_key_check')).toEqual([]);
      expect(sqlite.pragma('foreign_key_list(submissions)')).toEqual(foreignKeys);
      expect(sqlite.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name='submissions' ORDER BY name").all()).toEqual(expect.arrayContaining(triggers));
      expect(() => sqlite.prepare("UPDATE submissions SET commit_sha='changed'").run()).toThrow(/immutable/);
      expect(() => sqlite.prepare('DELETE FROM submissions').run()).toThrow(/cannot be deleted/);
      const insert = sqlite.prepare(`INSERT INTO submissions
        (id,repository_link_id,attempt,commit_sha,protected_ref,submitted_at,idempotency_key)
        VALUES (?, 'l', ?, 'abc', ?, 200, ?)`);
      expect(() => insert.run('blank',2,'submission/2',' ')).toThrow(/CHECK/);
      expect(() => insert.run('null',2,'submission/2',null)).toThrow(/NOT NULL/);
      expect(() => insert.run('dupkey',2,'submission/2','legacy:s')).toThrow(/UNIQUE/);
      expect(() => insert.run('dupattempt',1,'submission/2','new')).toThrow(/UNIQUE/);
      expect(() => insert.run('dupref',2,'submission/1','new')).toThrow(/UNIQUE/);
      expect(() => sqlite.exec("INSERT INTO submissions (id,repository_link_id,attempt,commit_sha,protected_ref,submitted_at) VALUES ('missing','l',2,'abc','submission/2',200)")).toThrow(/key is required/);
      insert.run('s2',2,'submission/2','new-key');
      expect(sqlite.prepare('SELECT status,created_at,updated_at FROM submissions WHERE id=?').get('s2')).toMatchObject({ status: 'submitted', created_at: expect.any(Number), updated_at: expect.any(Number) });
      const upgraded = sqlite.prepare('SELECT * FROM submissions ORDER BY id').all();
      await migrateDatabase(filename);
      expect(sqlite.prepare('SELECT * FROM submissions ORDER BY id').all()).toEqual(upgraded);
      expect(sqlite.pragma('foreign_key_check')).toEqual([]);
    } finally { sqlite.close(); rmSync(directory, { recursive: true, force: true }); }
  });
});
