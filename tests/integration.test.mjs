import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import net from 'node:net';
import {setupFixture} from './fixtures.mjs';

test('complete dating lifecycle, consent, authorization, privacy, and persistence', async t => {
  const root=join(import.meta.dirname,'..'), data=mkdtempSync(join(tmpdir(),'fantasytales-test-'));
  const socket=net.createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(r=>socket.close(r));
  const base=`http://127.0.0.1:${port}`, credentials=join(data,'credentials.txt');
  const env={...process.env,DATA_DIR:data,PORT:String(port),HOST:'127.0.0.1',APP_ORIGIN:base,NODE_ENV:'test',TRUST_PROXY:'0',CREDENTIALS_FILE:credentials};
  const media=await setupFixture(data);env.MEDIA_DIR=media;
  execFileSync(process.execPath,['scripts/accounts.mjs','seed'],{cwd:root,env,stdio:'pipe'});
  const server=spawn(process.execPath,['server.mjs'],{cwd:root,env,stdio:['ignore','pipe','pipe']});
  let output='';server.stderr.on('data',b=>output+=b);server.stdout.on('data',b=>output+=b);
  t.after(async()=>{server.kill('SIGTERM');await once(server,'exit');rmSync(data,{recursive:true,force:true});});
  for(let i=0;i<50;i++) {try {if((await fetch(base+'/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,50));}
  assert.equal((await fetch(base+'/health')).status,200,output);
  const creds=readFileSync(credentials,'utf8');
  const pinFor=name=>creds.match(new RegExp(`Username: ${name}\\nPIN: ([^\\n]+)`))[1];
  class Client {
    cookie='';csrf='';visit='';user=null;
    async call(path,method='GET',body,override={}) {
      const response=await fetch(base+path,{method,headers:{Cookie:this.cookie,Origin:base,'Content-Type':'application/json','X-CSRF-Token':this.csrf,'X-Visit-ID':this.visit,...override},...(body!==undefined?{body:JSON.stringify(body)}:{})});
      for(const c of response.headers.getSetCookie()) if(c.startsWith('ft_session=')) this.cookie=c.split(';')[0];
      const text=await response.text();let value;try{value=JSON.parse(text);}catch{value=text;}
      if(value.csrf)this.csrf=value.csrf;if(value.visitId)this.visit=value.visitId;if(value.user)this.user=value.user;
      return {status:response.status,body:value,headers:response.headers};
    }
    async init(){assert.equal((await this.call('/api/session')).status,200);return this;}
    async login(name){assert.equal((await this.call('/api/auth/login','POST',{username:name,pin:pinFor(name)})).status,200);}
    async signup(username,name){assert.equal((await this.call('/api/auth/signup','POST',{username,pin:'012345',adultConsent:true,privacyConsent:true})).status,200);assert.equal((await this.call('/api/me','PATCH',{name,whatsapp:'+12025550142'})).status,200);}
  }
  const visitor=await new Client().init();
  await t.test('private routes and photos require authentication; records cannot be downloaded',async()=>{
    for(const path of ['/api/profiles','/media/alex/portrait.png','/media/alex/photo-02.png','/media/admin/portrait.png','/api/admin/export'])assert.equal((await visitor.call(path)).status,401);
    for(const path of ['/data/connections.csv','/private/credentials.txt','/.env','/lib.mjs','/private/media/alex/portrait.png'])assert.equal((await visitor.call(path)).status,404);
    const r=await fetch(base+'/');assert.equal(r.status,200);assert.match(r.headers.get('content-security-policy'),/frame-ancestors 'none'/);assert.equal(r.headers.get('x-content-type-options'),'nosniff');
  });
  await t.test('signup enforces adult consent, CSRF, origin, and PIN format',async()=>{
    const input={username:'tester',pin:'012345',adultConsent:true,privacyConsent:true};
    assert.equal((await visitor.call('/api/auth/signup','POST',input,{'X-CSRF-Token':'bad'})).status,403);
    assert.equal((await visitor.call('/api/auth/signup','POST',input,{Origin:'https://attacker.example'})).status,403);
    assert.equal((await visitor.call('/api/auth/signup','POST',{...input,adultConsent:false})).status,400);
    assert.equal((await visitor.call('/api/auth/signup','POST',{...input,pin:'12345'})).status,400);
  });
  const member=await new Client().init(), stranger=await new Client().init(), owner=await new Client().init(), admin=await new Client().init();
  await member.signup('tester','=HYPERLINK("evil")');await stranger.signup('stranger','Another Member');await owner.login('alex');await admin.login('site-admin');
  const incomplete=await new Client().init();
  await t.test('WhatsApp is required on the server before profiles, photos, favorites, or introductions',async()=>{
    assert.equal((await incomplete.call('/api/auth/signup','POST',{username:'phone_gate',pin:'012345',adultConsent:true,privacyConsent:true})).status,200);
    await incomplete.call('/api/me','PATCH',{name:'Contact Gate Test'});
    for(const path of ['/api/profiles','/media/alex/portrait.png','/media/alex/photo-02.png']) {
      const r=await incomplete.call(path);assert.equal(r.status,403);assert.equal(r.body.code,'WHATSAPP_REQUIRED');
    }
    assert.equal((await incomplete.call('/api/favorites/alex','POST',{saved:true})).status,403);
    assert.equal((await incomplete.call('/api/connections','POST',{profile:'alex',message:'Attempt before a number is provided'})).status,403);
    assert.equal((await admin.call('/api/profiles')).status,403,'Administrator profile browsing also requires WhatsApp.');
    assert.equal((await admin.call('/api/admin')).status,200,'Account administration remains available.');
  });
  await t.test('empty and invalid WhatsApp values are rejected without completing onboarding',async()=>{
    for(const whatsapp of ['',null,'   ','9876543210','+0123456789','+123','+1234567890123456','invalid']) {
      assert.equal((await incomplete.call('/api/me','PATCH',{whatsapp})).status,400,String(whatsapp));
    }
    assert.equal((await incomplete.call('/api/session')).body.user.contact_done,0);
    assert.equal((await incomplete.call('/api/profiles')).status,403);
  });
  await t.test('legacy skipped-contact accounts must enter a number despite their old completion flag',async()=>{
    const {DatabaseSync}=await import('node:sqlite');const fixture=new DatabaseSync(join(data,'fantasytales.sqlite'));
    fixture.prepare("UPDATE users SET contact_done=1,whatsapp='' WHERE username='phone_gate'").run();fixture.close();
    assert.equal((await incomplete.call('/api/session')).body.user.contact_done,0);
    assert.equal((await incomplete.call('/api/profiles')).status,403);
    const saved=await incomplete.call('/api/me','PATCH',{whatsapp:'+1 (202) 555-0142'});
    assert.equal(saved.status,200);assert.equal(saved.body.user.whatsapp,'+12025550142');assert.equal(saved.body.user.contact_done,1);
    assert.equal((await incomplete.call('/api/profiles')).status,200);
    assert.equal((await incomplete.call('/api/me','PATCH',{name:'Must not be saved',whatsapp:''})).status,400);
    const preserved=(await incomplete.call('/api/session')).body.user;
    assert.equal(preserved.name,'Contact Gate Test');assert.equal(preserved.whatsapp,'+12025550142');
  });
  await t.test('onboarding validates contact and profile favorites persist',async()=>{
    assert.equal((await member.call('/api/me','PATCH',{whatsapp:'invalid'})).status,400);
    assert.equal((await member.call('/api/profiles')).body.profiles.length,7);
    const photo=await member.call('/media/alex/portrait.png');assert.equal(photo.status,200);assert.equal(photo.headers.get('cache-control'),'no-store');
    assert.equal((await member.call('/api/favorites/alex','POST',{saved:true})).status,200);
    assert.equal((await member.call('/api/profiles')).body.profiles.find(p=>p.id==='alex').saved,1);
    assert.equal((await member.call('/api/admin')).status,403);
  });
  await t.test('every supplied gallery photo is listed, protected, and served',async()=>{
    const profiles=(await member.call('/api/profiles')).body.profiles;
    assert.deepEqual(Object.fromEntries(profiles.map(p=>[p.id,p.photos.length])),{alex:6,blair:9,casey:10,drew:9,admin:1,eden:2,frankie:4});
    for(const p of profiles) {
      assert.equal(p.photos[0],p.image);
      for(const url of p.photos) {
        const image=await member.call(url);
        assert.equal(image.status,200,url);
        assert.equal(image.headers.get('content-type'),url.endsWith('.png')?'image/png':'image/jpeg');
        assert.equal(image.headers.get('cache-control'),'no-store');
      }
    }
    assert.equal((await member.call('/media/casey/photo-99.png')).status,404);
    assert.equal(profiles.find(p=>p.id==='admin').image,'/media/admin/portrait.png');
    assert.equal((await member.call('/media/admin/portrait.jpg')).status,404,'The replaced Admin photo is no longer served.');
  });
  await t.test('featured-profile requests identify the real Admin and protect contact-gated and featured accounts',async()=>{
    assert.equal((await visitor.call('/api/featured-request')).status,401);
    const waiting=await new Client().init();
    await waiting.call('/api/auth/signup','POST',{username:'feature_waiting',pin:'012345',adultConsent:true,privacyConsent:true});
    assert.deepEqual((await waiting.call('/api/featured-request')).body,{eligible:true,requiresContact:true});
    const request=await member.call('/api/featured-request');
    assert.equal(request.headers.get('cache-control'),'no-store');
    assert.deepEqual(request.body,{eligible:true,admin:{id:'admin',name:'Admin'},connection:null});
    assert.deepEqual((await admin.call('/api/featured-request')).body,{eligible:false});
    assert.deepEqual((await owner.call('/api/featured-request')).body,{eligible:false});
    await owner.call('/api/me','PATCH',{name:'Alex',whatsapp:'+12025550142'});
    await admin.call('/api/admin/profiles/alex','PATCH',{published:false});
    assert.equal((await owner.call('/api/featured-request')).body.eligible,true);
    await admin.call('/api/admin/profiles/alex','PATCH',{published:true});
    assert.equal((await owner.call('/api/featured-request')).body.eligible,false);
    assert.equal((await waiting.call('/api/me','DELETE',{pin:'012345'})).status,200);
  });
  await t.test('featured requests reuse pending/accepted Admin connections and do not publish a profile',async()=>{
    const candidate=await new Client().init();await candidate.signup('feature_candidate','Featured Candidate');
    const recipient=(await candidate.call('/api/featured-request')).body.admin.id;
    const hello=await candidate.call('/api/connections','POST',{profile:recipient,message:'Hello Admin, please share the email for my description, photos, and profile details.',shareContact:false});
    assert.equal(hello.status,201);
    assert.deepEqual((await candidate.call('/api/featured-request')).body.connection,{id:hello.body.id,status:'pending'});
    assert.equal((await stranger.call('/api/featured-request')).body.connection,null,'Another member cannot see this request.');
    assert.equal((await candidate.call('/api/connections','POST',{profile:recipient,message:'Duplicate hello to request featuring.'})).status,409);
    await admin.call(`/api/connections/${hello.body.id}/respond`,'POST',{action:'accepted'});
    assert.equal((await candidate.call('/api/featured-request')).body.connection.status,'accepted');
    assert.equal((await candidate.call(`/api/connections/${hello.body.id}/messages`,'POST',{message:'Please send the submission email address.'})).status,201);
    assert.equal((await candidate.call('/api/session')).body.user.profile_id,null);
    assert.equal((await candidate.call('/api/featured-request')).body.eligible,true);
    await candidate.call(`/api/connections/${hello.body.id}/block`,'POST',{});
    assert.equal((await candidate.call('/api/featured-request')).body.admin,null,'Blocked Admin is not suggested.');
    await admin.call('/api/admin/profiles/admin','PATCH',{published:false});
    assert.equal((await member.call('/api/featured-request')).body.admin,null,'Hidden Admin profile is not disclosed.');
    await admin.call('/api/admin/profiles/admin','PATCH',{published:true});
    assert.equal((await candidate.call('/api/me','DELETE',{pin:'012345'})).status,200);
  });
  let connection;
  await t.test('an introduction is pending and contact remains private',async()=>{
    const r=await member.call('/api/connections','POST',{profile:'alex',message:'Hello Alex! What made you smile today?',shareContact:true});
    assert.equal(r.status,201);assert.equal(r.body.status,'pending');connection=r.body.id;
    const received=(await owner.call('/api/connections')).body.connections[0];assert.equal(received.contact,'');
    assert.equal((await stranger.call('/api/connections')).body.connections.length,0);
    assert.equal((await member.call(`/api/connections/${connection}/messages`,'POST',{message:'Hello'})).status,403);
    assert.equal((await member.call(`/api/connections/${connection}/respond`,'POST',{action:'accepted'})).status,403);
    assert.equal((await stranger.call(`/api/connections/${connection}/respond`,'POST',{action:'accepted'})).status,404);
    assert.equal((await member.call('/api/connections','POST',{profile:'alex',message:'Duplicate introduction test'})).status,409);
  });
  await t.test('only the owner accepts; mutual chat opens and explicit contact sharing is honored',async()=>{
    assert.equal((await owner.call(`/api/connections/${connection}/respond`,'POST',{action:'accepted'})).status,200);
    assert.equal((await owner.call(`/api/connections/${connection}/respond`,'POST',{action:'declined'})).status,409);
    assert.equal((await owner.call('/api/connections')).body.connections[0].contact,'+12025550142');
    assert.equal((await member.call(`/api/connections/${connection}/messages`,'POST',{message:'Nice to meet you! <script>alert(1)</script>'})).status,201);
    assert.equal((await stranger.call(`/api/connections/${connection}/messages`,'POST',{message:'Intrusion attempt'})).status,404);
    const r=await owner.call('/api/connections');assert.equal(r.body.connections[0].messages.length,1);assert.equal(r.body.connections[0].messages[0].mine,false);
  });
  await t.test('CSV is private, formula-safe, and reflects acceptance',async()=>{
    assert.equal((await member.call('/api/admin/export')).status,403);
    const csv=await admin.call('/api/admin/export');assert.equal(csv.status,200);assert.match(csv.body,/'=HYPERLINK/);assert.match(csv.body,/accepted/);assert.ok(csv.body.includes(connection));
    assert.ok(csv.body.split('\r\n')[0].includes('"WhatsApp"'));
    assert.ok(csv.body.split('\r\n').find(line=>line.includes(connection)).includes('"\'+12025550142"'));
  });
  await t.test('updating WhatsApp refreshes existing CSV rows immediately',async()=>{
    assert.equal((await member.call('/api/me','PATCH',{whatsapp:'+12025550123'})).status,200);
    const row=readFileSync(join(data,'connections.csv'),'utf8').split('\r\n').find(line=>line.includes(connection));
    assert.ok(row.includes('"\'+12025550123"'));assert.ok(!row.includes('+12025550142'));
    assert.equal((await member.call('/api/me','PATCH',{whatsapp:''})).status,400);
    assert.ok(readFileSync(join(data,'connections.csv'),'utf8').includes('+12025550123'));
    await member.call('/api/me','PATCH',{whatsapp:'+12025550142'});
  });
  await t.test('each browser visit has chronological activity logs without passwords or messages',async()=>{
    await member.call('/api/events','POST',{event:'page_open',page:'discover'});
    await member.call('/api/events','POST',{event:'profile_open',profile:'alex'});
    const day=readdirSync(join(data,'visits'))[0],files=readdirSync(join(data,'visits',day));assert.ok(files.length>=5);
    const all=files.map(f=>readFileSync(join(data,'visits',day,f),'utf8')).join('');
    assert.match(all,/PAGE_OPENED/);assert.match(all,/INTRODUCTION_SENT/);assert.match(all,/PROFILE_OPENED/);assert.match(all,/NAME_SAVED/);
    assert.ok(!all.includes('Test-password-2026!'));assert.ok(!all.includes('What made you smile'));assert.ok(!all.includes('+12025550142'));
    for(const file of files){const dates=readFileSync(join(data,'visits',day,file),'utf8').trim().split('\n').map(l=>l.slice(0,24));assert.deepEqual(dates,[...dates].sort());}
  });
  await t.test('reports reach admin and profile publishing is role protected',async()=>{
    assert.equal((await member.call('/api/reports','POST',{profile:'blair',reason:'Please review this test concern.'})).status,201);
    assert.equal((await admin.call('/api/admin')).body.reports.length,1);
    assert.equal((await member.call('/api/admin/profiles/blair','PATCH',{published:false})).status,403);
    await admin.call('/api/admin/profiles/blair','PATCH',{published:false});assert.equal((await member.call('/api/profiles')).body.profiles.length,6);
    await admin.call('/api/admin/profiles/blair','PATCH',{published:true});
  });
  await t.test('blocking ends access symmetrically and prevents new introductions',async()=>{
    assert.equal((await owner.call(`/api/connections/${connection}/block`,'POST',{})).status,200);
    assert.equal((await member.call('/api/connections')).body.connections.length,0);
    assert.equal((await member.call('/api/profiles')).body.profiles.length,6);
    assert.equal((await member.call('/api/connections','POST',{profile:'alex',message:'Trying to reconnect after being blocked'})).status,400);
    assert.equal((await member.call(`/api/connections/${connection}/messages`,'POST',{message:'Another message'})).status,403);
  });
  await t.test('the fifth profile routes introductions to the existing administrator account only',async()=>{
    assert.equal((await admin.call('/api/session')).body.user.profile_id,'admin');
    assert.equal((await admin.call('/api/owner/profile')).body.profile.name,'Admin');
    const r=await stranger.call('/api/connections','POST',{profile:'admin',message:'Hello Admin, this is an isolated integration test.',shareContact:false});
    assert.equal(r.status,201);
    const incoming=(await admin.call('/api/connections')).body.connections.find(c=>c.id===r.body.id);
    assert.ok(incoming.incoming);assert.equal(incoming.name,'Another Member');
    assert.equal(incoming.image,'/media/admin/portrait.png');
    assert.equal((await owner.call(`/api/connections/${r.body.id}/respond`,'POST',{action:'accepted'})).status,404);
    assert.equal((await admin.call(`/api/connections/${connection}/respond`,'POST',{action:'accepted'})).status,404);
    assert.equal((await admin.call(`/api/connections/${r.body.id}/respond`,'POST',{action:'accepted'})).status,200);
  });
  await t.test('Discover includes each owner’s own profile while self-introductions stay blocked',async()=>{
    for(const [client,profile] of [[admin,'admin'],[owner,'alex']]) {
      assert.equal((await client.call('/api/me','PATCH',{whatsapp:'+12025550124'})).status,200);
      const list=(await client.call('/api/profiles')).body.profiles;
      assert.equal(list.length,7);
      assert.ok(list.some(p=>p.id===profile));
      assert.equal((await client.call('/api/connections','POST',{profile,message:'Attempting to introduce myself to my own profile'})).status,400);
    }
  });
  await t.test('PIN changes invalidate other sessions',async()=>{
    const second=await new Client().init();await second.call('/api/auth/login','POST',{username:'stranger',pin:'012345'});
    const r=await stranger.call('/api/me/pin','POST',{currentPin:'012345',pin:'654321'});assert.equal(r.status,200);
    assert.equal((await second.call('/api/profiles')).status,401);assert.equal((await stranger.call('/api/profiles')).status,200);
  });
  const managed=await new Client().init(),managedSecond=await new Client().init();
  let managedId,newManagedPin;
  await t.test('member directory is administrator-only, searchable, filtered, and excludes credentials',async()=>{
    await managed.signup('managed_test','Managed Member');managedId=managed.user.id;
    await managedSecond.call('/api/auth/login','POST',{username:'managed_test',pin:'012345'});
    for(const client of [visitor,member,owner])assert.ok([401,403].includes((await client.call('/api/admin/members')).status));
    const response=await admin.call('/api/admin/members?search=managed_test');assert.equal(response.status,200);
    assert.equal(response.body.total,1);assert.equal(response.body.members[0].whatsapp,'+12025550142');
    for(const key of ['password','pin','csrf','auth_kind'])assert.ok(!(key in response.body.members[0]));
    assert.ok((await admin.call('/api/admin/members')).body.members.every(m=>!['alex','site-admin'].includes(m.username)));
    assert.equal((await admin.call('/api/admin/members?search='+encodeURIComponent("' OR 1=1 --"))).body.total,0);
    assert.equal((await admin.call('/api/admin/members?page=0')).status,400);
    assert.equal((await admin.call('/api/admin/members?status=invalid')).status,400);
    assert.equal((await admin.call('/api/admin/members?search='+encodeURIComponent('+12025550142'))).body.members.some(m=>m.id===managedId),true);
  });
  await t.test('member directory pagination returns distinct results and stable totals',async()=>{
    const {DatabaseSync}=await import('node:sqlite'),fixture=new DatabaseSync(join(data,'fantasytales.sqlite'));
    const hash=fixture.prepare('SELECT password FROM users WHERE id=?').get(managedId).password;
    for(let i=0;i<21;i++)fixture.prepare("INSERT INTO users(username,password,auth_kind,name,created_at,consent_at) VALUES(?,?,'pin',?,?,?)").run(`pager_${i}`,hash,`Paging Member ${i}`,new Date().toISOString(),new Date().toISOString());
    const first=(await admin.call('/api/admin/members?search=pager_')).body;
    const second=(await admin.call('/api/admin/members?search=pager_&page=2')).body;
    assert.equal(first.total,21);assert.equal(first.members.length,20);assert.equal(second.members.length,1);
    assert.equal(new Set([...first.members,...second.members].map(m=>m.id)).size,21);
    fixture.prepare("DELETE FROM users WHERE username LIKE 'pager_%'").run();fixture.close();
  });
  await t.test('suspension revokes all sessions and blocks sign-in while preserving member data',async()=>{
    await managed.call('/api/connections','POST',{profile:'admin',message:'An introduction retained during suspension.'});
    const path=`/api/admin/members/${managedId}`;
    assert.equal((await owner.call(path,'PATCH',{suspended:true,reason:'Not authorized'})).status,403);
    assert.equal((await admin.call(path,'PATCH',{suspended:true,reason:'x'})).status,400);
    assert.equal((await admin.call(path,'PATCH',{suspended:true,reason:'Security review'},{'X-CSRF-Token':'bad'})).status,403);
    assert.equal((await admin.call(path,'PATCH',{suspended:true,reason:'Security review'})).status,200);
    assert.equal((await managed.call('/api/session')).body.user,null);
    assert.equal((await managedSecond.call('/api/session')).body.user,null);
    assert.equal((await managed.call('/api/profiles')).status,401);
    assert.equal((await managed.call('/media/admin/portrait.png')).status,401);
    assert.equal((await managed.call('/api/auth/login','POST',{username:'managed_test',pin:'012345'})).status,403);
    const saved=(await admin.call('/api/admin/members?search=managed_test&status=suspended')).body;
    assert.equal(saved.total,1);assert.equal(saved.members[0].introductions,1);assert.equal(saved.members[0].name,'Managed Member');
    assert.equal(saved.members[0].whatsapp,'+12025550142');assert.equal(saved.members[0].suspension_reason,'Security review');
    assert.equal((await admin.call('/api/admin/members?search=managed_test&status=active')).body.total,0);
    assert.equal((await admin.call(path,'PATCH',{suspended:false,reason:'Review completed'})).status,200);
    assert.equal((await managed.call('/api/profiles')).status,401,'Reactivation does not restore old sessions.');
    assert.equal((await managed.call('/api/auth/login','POST',{username:'managed_test',pin:'012345'})).status,200);
    assert.equal((await managed.call('/api/connections')).body.connections.length,1);
  });
  await t.test('PIN resets protect privileged accounts and require the administrator’s current PIN',async()=>{
    const path=`/api/admin/members/${managedId}/reset-pin`;
    for(const user of [admin.user,owner.user]) {
      assert.equal((await admin.call(`/api/admin/members/${user.id}`,'PATCH',{suspended:true,reason:'Attempt to suspend a protected account'})).status,404);
      assert.equal((await admin.call(`/api/admin/members/${user.id}/reset-pin`,'POST',{adminPin:pinFor('site-admin'),reason:'Protected reset attempt'})).status,404);
    }
    assert.equal((await member.call(path,'POST',{adminPin:'012345',reason:'Unauthorized reset attempt'})).status,403);
    const wrong=pinFor('site-admin')==='000000'?'111111':'000000';
    assert.equal((await admin.call(path,'POST',{adminPin:wrong,reason:'Forgotten PIN request'})).status,401);
    assert.equal((await managedSecond.call('/api/auth/login','POST',{username:'managed_test',pin:'012345'})).status,200);
    const result=await admin.call(path,'POST',{adminPin:pinFor('site-admin'),reason:'Forgotten PIN request'});
    assert.equal(result.status,200);assert.match(result.body.pin,/^[0-9]{6}$/);assert.notEqual(result.body.pin,'012345');newManagedPin=result.body.pin;
    assert.equal((await managed.call('/api/session')).body.user,null);assert.equal((await managedSecond.call('/api/session')).body.user,null);
    assert.equal((await managed.call('/api/auth/login','POST',{username:'managed_test',pin:'012345'})).status,401);
    assert.equal((await managed.call('/api/auth/login','POST',{username:'managed_test',pin:newManagedPin})).status,200);
    assert.equal(managed.user.name,'Managed Member');assert.equal(managed.user.whatsapp,'+12025550142');
  });
  await t.test('management actions are audited without PINs and remain after member deletion',async()=>{
    const result=(await admin.call('/api/admin/members?search=managed_test')).body;
    const actions=result.audit.filter(entry=>entry.target_username==='managed_test');
    assert.deepEqual(actions.map(entry=>entry.action),['MEMBER_PIN_RESET','MEMBER_REACTIVATED','MEMBER_SUSPENDED']);
    assert.ok(actions.every(entry=>entry.actor_username==='site-admin' && entry.reason));
    assert.ok(!JSON.stringify(result).includes(newManagedPin));assert.ok(!JSON.stringify(result).includes(pinFor('site-admin')));
    const day=readdirSync(join(data,'visits'))[0];
    const logs=readdirSync(join(data,'visits',day)).map(file=>readFileSync(join(data,'visits',day,file),'utf8')).join('\n');
    assert.ok(!logs.includes(newManagedPin));assert.ok(!logs.includes(pinFor('site-admin')));
    assert.equal((await managed.call('/api/me','DELETE',{pin:newManagedPin})).status,200);
    const remaining=(await admin.call('/api/admin/members?search=managed_test')).body;
    assert.equal(remaining.total,0);assert.equal(remaining.audit.filter(entry=>entry.target_username==='managed_test').length,3);
  });
  await t.test('AI settings require administrator PIN, keep the API key private, and queue only authorized work',async()=>{
    const key='sk-test_'+ 'z'.repeat(45),input={apiKey:key,adminPin:pinFor('site-admin'),enabled:true};
    assert.equal((await visitor.call('/api/admin/ratings')).status,401);
    assert.equal((await member.call('/api/admin/ratings')).status,403);
    assert.equal((await member.call('/api/admin/ratings','PATCH',input)).status,403);
    assert.equal((await member.call('/api/admin/ratings/run','POST',{})).status,403);
    assert.equal((await admin.call('/api/admin/ratings','PATCH',input,{'X-CSRF-Token':'bad'})).status,403);
    assert.equal((await admin.call('/api/admin/ratings','PATCH',{...input,adminPin:input.adminPin==='000000'?'111111':'000000'})).status,401);
    const saved=await admin.call('/api/admin/ratings','PATCH',input);assert.equal(saved.status,200);
    assert.equal(saved.body.configured,true);assert.equal(saved.body.queued,true);assert.ok(!JSON.stringify(saved.body).includes(key));
    assert.equal((await admin.call('/api/admin/ratings/run','POST',{})).status,202);
    assert.equal((await member.call('/data/rating-key.json')).status,404);
    assert.ok(!JSON.stringify((await admin.call('/api/admin')).body).includes(key));
    const paused=await admin.call('/api/admin/ratings','PATCH',{adminPin:input.adminPin,enabled:false});assert.equal(paused.status,200);assert.equal(paused.body.queued,false);
    assert.equal((await admin.call('/api/admin/ratings/run','POST',{})).status,400);
    const day=readdirSync(join(data,'visits'))[0],logs=readdirSync(join(data,'visits',day)).map(f=>readFileSync(join(data,'visits',day,f),'utf8')).join('\n');
    assert.ok(!logs.includes(key));assert.ok(!logs.includes(input.adminPin));
  });
  await t.test('member-visible ratings expose only scores and become pending after profile edits',async()=>{
    const {DatabaseSync}=await import('node:sqlite');const fixture=new DatabaseSync(join(data,'fantasytales.sqlite'));
    fixture.prepare("INSERT INTO profile_ratings(profile_id,score,quality,attractiveness,assessed_at,status) VALUES('alex',4,4.5,3.5,?,'ready')").run(new Date().toISOString());
    const before=(await owner.call('/api/profiles')).body.profiles.find(p=>p.id==='alex').rating;
    assert.equal(before.score,4);assert.equal(before.pending,false);assert.equal('content_hash' in before,false);
    assert.equal((await owner.call('/api/owner/profile','PATCH',{bio:'A changed biography for this isolated test.',prompt:'A new friendly headline.'})).status,200);
    assert.equal((await owner.call('/api/profiles')).body.profiles.find(p=>p.id==='alex').rating.pending,true);
    fixture.close();
  });
  await t.test('account deletion removes private records and CSV entries',async()=>{
    assert.equal((await member.call('/api/me','DELETE',{pin:'012345'})).status,200);
    assert.equal((await member.call('/api/profiles')).status,401);
    assert.ok(!(await admin.call('/api/admin/export')).body.includes(connection));
    const { DatabaseSync }=await import('node:sqlite');const check=new DatabaseSync(join(data,'fantasytales.sqlite'));
    assert.equal(check.prepare('SELECT count(*) AS n FROM messages').get().n,0);check.close();
  });
  await t.test('logout invalidates authentication',async()=>{
    assert.equal((await stranger.call('/api/auth/logout','POST',{})).status,200);assert.equal((await stranger.call('/api/profiles')).status,401);
  });
});
