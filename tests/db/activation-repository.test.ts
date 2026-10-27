import { mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { expect,it } from 'vitest';
import { openSqliteDatabase } from '../../src/db/migrate';
it('upgrades existing activations without changing legacy rows and repeats safely',()=>{
 const dir=mkdtempSync(join(tmpdir(),'activation-migrate-'));const old=join(dir,'old');mkdirSync(join(old,'meta'),{recursive:true});
 const journal=JSON.parse(readFileSync('drizzle/meta/_journal.json','utf8'));journal.entries=journal.entries.slice(0,4);
 writeFileSync(join(old,'meta/_journal.json'),JSON.stringify(journal));for(const e of journal.entries)writeFileSync(join(old,e.tag+'.sql'),readFileSync('drizzle/'+e.tag+'.sql'));
 const db=openSqliteDatabase(join(dir,'db.sqlite'));
 try {
  migrate(drizzle(db),{migrationsFolder:old});
  db.exec("INSERT INTO users(id,gitea_id,login,email,display_name)VALUES('u',1,'u','u@jdu.uz','U'); INSERT INTO student_profiles(id,user_id,student_id,expected_email)VALUES('p','u','S','u@jdu.uz');INSERT INTO activations(id,student_profile_id,token_hmac,expires_at)VALUES('a','p','legacy',1000)");
  const before=db.prepare('SELECT * FROM activations').all();migrate(drizzle(db),{migrationsFolder:'drizzle'});migrate(drizzle(db),{migrationsFolder:'drizzle'});
  expect(db.prepare('SELECT * FROM activations').all()).toEqual(before);expect(db.pragma('foreign_key_check')).toEqual([]);
  expect(db.prepare('SELECT count(*) AS n FROM activation_tokens').get()).toEqual({n:0});
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
