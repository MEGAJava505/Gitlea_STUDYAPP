import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as tables from './schema';
import * as relations from './relations';
import { openSqliteDatabase } from './migrate';

const schema = { ...tables, ...relations };
export type Db = BetterSQLite3Database<typeof schema>;

const sqlite = openSqliteDatabase();
export const db: Db = drizzle(sqlite, { schema });
