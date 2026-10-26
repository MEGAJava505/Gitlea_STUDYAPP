import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

export function openSqliteDatabase(databaseUrl = process.env.DATABASE_URL ?? 'file:./data/local-github.sqlite'): Database.Database {
  const filename = databaseUrl.startsWith('file:') ? databaseUrl.slice(5) : databaseUrl;
  if (filename !== ':memory:') mkdirSync(dirname(resolve(filename)), { recursive: true });
  const sqlite = new Database(filename);
  sqlite.pragma('foreign_keys = ON');
  // REPLACE must also fire the append-only and immutable-submission delete guards.
  sqlite.pragma('recursive_triggers = ON');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('busy_timeout = 5000');
  return sqlite;
}

export async function migrateDatabase(databaseUrl = process.env.DATABASE_URL ?? 'file:./data/local-github.sqlite'): Promise<void> {
  const sqlite = openSqliteDatabase(databaseUrl);
  try {
    // Resolved at runtime so bundlers do not try to statically bundle the SQL folder.
    const migrationsFolder = process.env.MIGRATIONS_FOLDER ?? resolve(process.cwd(), 'drizzle');
    migrate(drizzle(sqlite), { migrationsFolder });
  } finally {
    sqlite.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  migrateDatabase().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
