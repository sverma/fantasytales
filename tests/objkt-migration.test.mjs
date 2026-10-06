import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setupFixture} from './fixtures.mjs';

test('objkt migration preserves account data and saved links across restarts',async t=>{
  const data=mkdtempSync(join(tmpdir(),'ft-objkt-migration-'));t.after(()=>rmSync(data,{recursive:true,force:true}));
  await setupFixture(data);const path=join(data,'fantasytales.sqlite');
  let db=new DatabaseSync(path);const now=new Date().toISOString();
  db.prepare("INSERT INTO users(username,password,auth_kind,name,telegram,contact_done,role,profile_id,created_at,consent_at) VALUES('nft-owner','existing-hash','pin','NFT Owner','existing-contact',1,'owner','alex',?,?)").run(now,now);
  db.exec('ALTER TABLE users DROP COLUMN objkt_url');const before=db.prepare('SELECT * FROM users').get();db.close();
  const initialize=()=>execFileSync(process.execPath,['--input-type=module','-e',"import {db} from './lib.mjs';db.close();"],{cwd:join(import.meta.dirname,'..'),env:{...process.env,DATA_DIR:data},stdio:'pipe'});
  initialize();db=new DatabaseSync(path);
  assert.deepEqual({...db.prepare('SELECT * FROM users').get()},{...before,objkt_url:''});
  db.prepare("UPDATE users SET objkt_url='https://objkt.com/@fixture'").run();db.close();
  initialize();db=new DatabaseSync(path);
  try {assert.deepEqual({...db.prepare('SELECT * FROM users').get()},{...before,objkt_url:'https://objkt.com/@fixture'});assert.equal(db.prepare('PRAGMA quick_check').get().quick_check,'ok');}
  finally {db.close();}
});
