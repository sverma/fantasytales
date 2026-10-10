import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initActivity,recordAuthentication,pruneAuthentication} from '../activity.mjs';
import {importLoginHistory} from '../scripts/import-login-history.mjs';
test('history migration is additive, bounded, idempotent, and excludes stale identities',()=>{
 const dir=mkdtempSync(join(tmpdir(),'ft-history-')),db=new DatabaseSync(':memory:');
 try{
  db.exec(`PRAGMA foreign_keys=ON;CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,created_at TEXT);CREATE TABLE connections(id TEXT,created_at TEXT);`);
  const now=Date.parse('2026-01-10T12:00:00Z'),joined='2026-01-09T12:00:00.000Z';
  db.prepare('INSERT INTO users VALUES(?,?,?)').run(1,'fixture',joined);initActivity(db);initActivity(db);
  const folder=join(dir,'visits','2026-01-10');mkdirSync(folder,{recursive:true});
  writeFileSync(join(folder,'events.txt'),[
   '2026-01-10T10:00:00.000Z SIGNED_IN {"userId":1,"username":"fixture"}',
   '2026-01-10T11:00:00.000Z ACCOUNT_CREATED {"userId":1,"username":"fixture"}',
   '2026-01-10T11:05:00.000Z SIGNED_IN {"userId":1,"username":"old-owner-of-id"}',
   '2026-01-10T11:05:00.000Z SIGNED_IN {"userId":999,"username":"deleted"}',
   '2026-01-10T11:06:00.000Z SIGNED_IN invalid-json',
   '2026-01-10T11:07:00.000Z SIGNED_IN null',
   '2026-01-10T11:08:00.000Z PASSWORD_CHANGED {"userId":1,"username":"fixture"}',
   '2026-01-10T13:00:00.000Z SIGNED_IN {"userId":1,"username":"fixture"}',
   '2026-01-08T12:00:00.000Z SIGNED_IN {"userId":1,"username":"fixture"}'
  ].join('\n'));
  writeFileSync(join(dir,'outside.txt'),'2026-01-10T09:00:00.000Z SIGNED_IN {"userId":1,"username":"fixture"}');symlinkSync(join(dir,'outside.txt'),join(folder,'link.txt'));
  const result=importLoginHistory(db,dir,{now});assert.equal(result.imported,2);assert.equal(result.skippedFiles,1);
  assert.equal(importLoginHistory(db,dir,{now}).imported,0);assert.equal(db.prepare('SELECT count(*) AS n FROM auth_activity').get().n,2);
  assert.deepEqual({...db.prepare('SELECT * FROM users').get()},{id:1,username:'fixture',created_at:joined});
  recordAuthentication(db,1,'pin_migration','2025-12-01T00:00:00.000Z');pruneAuthentication(db,now);assert.equal(db.prepare('SELECT count(*) AS n FROM auth_activity').get().n,2);
  db.prepare('DELETE FROM users WHERE id=1').run();assert.equal(db.prepare('SELECT count(*) AS n FROM auth_activity').get().n,0);
  db.prepare('INSERT INTO users VALUES(?,?,?)').run(1,'fixture','2026-01-10T11:30:00.000Z');assert.equal(importLoginHistory(db,dir,{now}).imported,0,'Reused IDs cannot inherit old login history');
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
