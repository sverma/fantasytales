import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,statSync,rmSync,existsSync,symlinkSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {initRatings,profileSnapshot,validateAssessment,assessProfile,saveRatingKey,readRatingKey,adminRatings,publicRating,DAILY_RATING_LIMIT} from '../ratings.mjs';
import {runRatings} from '../scripts/rate-profiles.mjs';

const secret='sk-test_'+ 'a'.repeat(45);
function fixture(t) {
  const dataDir=mkdtempSync(join(tmpdir(),'ft-ratings-')),mediaDir=join(dataDir,'media'),db=new DatabaseSync(':memory:');
  db.exec("PRAGMA foreign_keys=ON;CREATE TABLE profiles(id TEXT PRIMARY KEY,name TEXT,bio TEXT,prompt TEXT,published INTEGER DEFAULT 1);INSERT INTO profiles(id,name,bio,prompt) VALUES('sample','Sample','A detailed biography.','A friendly headline.');");
  initRatings(db);db.prepare('UPDATE rating_settings SET enabled=1').run();
  mkdirSync(join(mediaDir,'sample'),{recursive:true});writeFileSync(join(mediaDir,'sample','portrait.jpg'),'sample image bytes');
  saveRatingKey(dataDir,secret);
  t.after(()=>{db.close();rmSync(dataDir,{recursive:true,force:true});});
  return {db,dataDir,mediaDir};
}
const good=()=>({quality:4,attractiveness:3,score:3.5});

test('production CLI runs through a release symlink and consumes a disabled queue without making API calls',t=>{
  const folder=mkdtempSync(join(tmpdir(),'ft-rating-cli-')),dataDir=join(folder,'data');
  t.after(()=>rmSync(folder,{recursive:true,force:true}));
  mkdirSync(dataDir);writeFileSync(join(dataDir,'ratings.queue'),'test');
  symlinkSync(resolve(import.meta.dirname,'..'),join(folder,'current'),'dir');
  const result=spawnSync(process.execPath,[join(folder,'current/scripts/rate-profiles.mjs')],{env:{...process.env,DATA_DIR:dataDir},encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),{status:'paused'});
  assert.equal(existsSync(join(dataDir,'ratings.queue')),false);
  const db=new DatabaseSync(join(dataDir,'fantasytales.sqlite'));
  try{assert.equal(db.prepare('SELECT last_status FROM rating_settings').get().last_status,'paused');assert.equal(db.prepare('SELECT request_count FROM rating_settings').get().request_count,0);}
  finally{db.close();}
});

test('snapshot includes all photo content and profile details, excluding private account fields',t=>{
  const f=fixture(t),profile={...f.db.prepare('SELECT * FROM profiles').get(),whatsapp:'private-phone',telegram:'private-telegram',line:'private-line',password:'private-pin'};
  const a=profileSnapshot(profile,f.mediaDir);
  assert.deepEqual(a.text,{headline:profile.prompt,biography:profile.bio});
  assert.equal(profileSnapshot(profile,f.mediaDir).hash,a.hash);
  assert.notEqual(profileSnapshot({...profile,bio:'Changed biography'},f.mediaDir).hash,a.hash);
  writeFileSync(join(f.mediaDir,'sample','portrait.jpg'),'replaced photo bytes');
  const b=profileSnapshot(profile,f.mediaDir);assert.notEqual(b.hash,a.hash);
  writeFileSync(join(f.mediaDir,'sample','photo-02.png'),'second photo bytes');
  const c=profileSnapshot(profile,f.mediaDir);assert.equal(c.photos.length,2);assert.notEqual(c.hash,b.hash);
});
test('worker scores once, skips unchanged profiles, and re-scores changed text or photos',async t=>{
  const f=fixture(t);let calls=0;const options={...f,assess:async()=>{calls++;return good();}};
  assert.equal((await runRatings(f.db,options)).scored,1);
  assert.equal(publicRating(f.db,'sample').score,3.5);
  assert.equal((await runRatings(f.db,options)).skipped,1);assert.equal(calls,1);
  f.db.prepare("UPDATE profiles SET bio='New details'").run();
  assert.equal((await runRatings(f.db,options)).scored,1);
  writeFileSync(join(f.mediaDir,'sample','portrait.jpg'),'updated photo');
  assert.equal((await runRatings(f.db,options)).scored,1);assert.equal(calls,3);
  f.db.prepare('UPDATE profiles SET published=0').run();await runRatings(f.db,options);assert.equal(calls,3);
});
test('failed or refused assessments keep the previous score without exposing secrets',async t=>{
  const f=fixture(t);await runRatings(f.db,{...f,assess:good});
  f.db.prepare("UPDATE profiles SET bio='Changed biography'").run();
  await runRatings(f.db,{...f,assess:()=>{throw new Error('Network payload contained '+secret);}});
  assert.equal(publicRating(f.db,'sample').score,3.5);assert.equal(publicRating(f.db,'sample').pending,true);
  assert.ok(!JSON.stringify(adminRatings(f.db,f.dataDir)).includes(secret));
  await runRatings(f.db,{...f,assess:()=>null});assert.equal(publicRating(f.db,'sample').score,3.5);
  f.db.prepare('DELETE FROM profile_ratings').run();await runRatings(f.db,{...f,assess:()=>null});
  assert.equal(publicRating(f.db,'sample'),null);
});
test('concurrent runs and profile edits during assessment cannot publish a stale score',async t=>{
  const f=fixture(t);let finish;
  const pending=runRatings(f.db,{...f,assess:()=>new Promise(resolve=>{finish=resolve;})});
  writeFileSync(join(f.dataDir,'ratings.queue'),'duplicate request');
  assert.equal((await runRatings(f.db,{...f,assess:good})).status,'already_running');
  assert.equal(existsSync(join(f.dataDir,'ratings.queue')),false,'A locked worker must not cause a path-watcher restart loop.');
  f.db.prepare("UPDATE profiles SET bio='Edited during API request'").run();finish(good());await pending;
  assert.equal(publicRating(f.db,'sample'),null);
  await runRatings(f.db,{...f,assess:good});assert.equal(publicRating(f.db,'sample').score,3.5);
});
test('daily request cap, pause, missing keys, and account-level API failures stop unnecessary calls',async t=>{
  const f=fixture(t);let calls=0;const options={...f,assess:()=>{calls++;return good();}};
  f.db.prepare('UPDATE rating_settings SET request_day=?,request_count=?').run(new Date().toISOString().slice(0,10),DAILY_RATING_LIMIT);
  assert.equal((await runRatings(f.db,options)).status,'daily_limit');assert.equal(calls,0);
  f.db.prepare("UPDATE rating_settings SET request_day='yesterday'").run();await runRatings(f.db,options);assert.equal(calls,1);
  f.db.prepare('UPDATE rating_settings SET enabled=0').run();assert.equal((await runRatings(f.db,options)).status,'paused');
  f.db.prepare('UPDATE rating_settings SET enabled=1').run();rmSync(join(f.dataDir,'rating-key.json'));
  assert.equal((await runRatings(f.db,options)).status,'not_configured');assert.equal(calls,1);
});
test('API key is private, not returned in settings, and invalid replacements are rejected',t=>{
  const f=fixture(t);assert.equal(readRatingKey(f.dataDir),secret);
  assert.equal(statSync(join(f.dataDir,'rating-key.json')).mode&0o777,0o600);
  assert.throws(()=>saveRatingKey(f.dataDir,'invalid'));
  assert.equal(readRatingKey(f.dataDir),secret);
  assert.ok(!JSON.stringify(adminRatings(f.db,f.dataDir)).includes(secret));
});
test('Responses request uses all images, strict numeric output, no storage, and bounded validated scores',async t=>{
  const f=fixture(t);const snapshot=profileSnapshot(f.db.prepare('SELECT * FROM profiles').get(),f.mediaDir);
  const response=await assessProfile(snapshot,secret,async(url,options)=>{
    assert.equal(url,'https://api.openai.com/v1/responses');assert.equal(options.redirect,'error');
    const body=JSON.parse(options.body);assert.equal(body.store,false);assert.equal(body.text.format.strict,true);
    assert.equal(body.input[0].content.filter(c=>c.type==='input_image').length,snapshot.photos.length);
    assert.ok(!options.body.includes(secret));assert.equal(options.headers.Authorization,'Bearer '+secret);
    return {ok:true,json:async()=>({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify({scorable:true,profile_quality:4.1,attractiveness:3.7})}]}]})};
  });
  assert.deepEqual(response,{quality:4.1,attractiveness:3.7,score:3.9});
  for(const value of [0,6,'4',NaN])assert.throws(()=>validateAssessment({scorable:true,profile_quality:value,attractiveness:3}));
  assert.equal(validateAssessment({scorable:false,profile_quality:null,attractiveness:null}),null);
  await assert.rejects(assessProfile(snapshot,secret,async()=>({ok:false,status:401})),e=>e.stopBatch && !e.message.includes(secret));
});
