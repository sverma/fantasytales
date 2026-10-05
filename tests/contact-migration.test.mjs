import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setupFixture} from './fixtures.mjs';

test('contact migration preserves existing accounts, connections, and WhatsApp consent on repeated startup',async t=>{
  const data=mkdtempSync(join(tmpdir(),'ft-contact-migration-'));
  t.after(()=>rmSync(data,{recursive:true,force:true}));
  await setupFixture(data);
  const path=join(data,'fantasytales.sqlite');
  let db=new DatabaseSync(path);
  const now=new Date().toISOString();
  db.prepare("INSERT INTO users(username,password,auth_kind,name,whatsapp,contact_done,created_at,consent_at) VALUES(?,?,'pin',?,?,1,?,?)").run('existing_member','unchanged-fixture-hash','Existing Member','+12025550123',now,now);
  db.prepare("INSERT INTO connections(id,user_id,profile_id,message,status,share_contact,created_at,updated_at) VALUES('legacy-hello',1,'alex','Existing hello','accepted',1,?,?)").run(now,now);
  db.exec('ALTER TABLE users DROP COLUMN telegram; ALTER TABLE users DROP COLUMN line; ALTER TABLE connections DROP COLUMN share_messengers;');
  const before=db.prepare('SELECT * FROM users').get();db.close();
  for(let i=0;i<2;i++)execFileSync(process.execPath,['--input-type=module','-e',"import {db,exportCSV} from './lib.mjs';exportCSV();db.close();"],{cwd:join(import.meta.dirname,'..'),env:{...process.env,DATA_DIR:data},stdio:'pipe'});
  db=new DatabaseSync(path);
  try{
    const after=db.prepare('SELECT * FROM users').get(),connection=db.prepare('SELECT * FROM connections').get();
    assert.deepEqual({...after},{...before,telegram:'',line:''});
    assert.equal(connection.message,'Existing hello');assert.equal(connection.status,'accepted');
    assert.equal(connection.share_contact,1);assert.equal(connection.share_messengers,0);
    assert.equal(db.prepare('PRAGMA quick_check').get().quick_check,'ok');
  }finally{db.close();}
});
