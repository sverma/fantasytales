import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { scryptSync, createHash } from 'node:crypto';
import net from 'node:net';

test('six-digit PIN authentication, legacy migration, and attempt limits',async t=>{
  const data=mkdtempSync(join(tmpdir(),'fantasytales-pin-'));
  const fixture=new DatabaseSync(join(data,'fantasytales.sqlite'));
  // This is the deployed schema before PIN support; startup must migrate it.
  fixture.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY,username TEXT NOT NULL UNIQUE,password TEXT NOT NULL,name TEXT NOT NULL DEFAULT '',whatsapp TEXT NOT NULL DEFAULT '',contact_done INTEGER NOT NULL DEFAULT 0,role TEXT NOT NULL DEFAULT 'member',profile_id TEXT UNIQUE,created_at TEXT NOT NULL,consent_at TEXT NOT NULL)`);
  const legacyPassword='Previous-account-password!',salt='legacy-test-salt';
  const legacyHash=`scrypt:${salt}:${scryptSync(legacyPassword,salt,64,{N:32768,r:8,p:1,maxmem:64*1024*1024}).toString('hex')}`;
  const now=new Date().toISOString();
  for(const username of ['legacy_member','legacy_session']) fixture.prepare('INSERT INTO users(username,password,name,whatsapp,contact_done,created_at,consent_at) VALUES(?,?,?,?,1,?,?)').run(username,legacyHash,'Kept Name','+12025550124',now,now);
  const socket=net.createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(r=>socket.close(r));
  const base=`http://127.0.0.1:${port}`;
  const server=spawn(process.execPath,['server.mjs'],{cwd:join(import.meta.dirname,'..'),env:{...process.env,DATA_DIR:data,PORT:String(port),HOST:'127.0.0.1',APP_ORIGIN:base,TRUST_PROXY:'1'},stdio:'pipe'});
  t.after(async()=>{server.kill('SIGTERM');await once(server,'exit');fixture.close();rmSync(data,{recursive:true,force:true});});
  for(let i=0;i<100;i++){try{if((await fetch(base+'/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,30));}
  assert.equal((await fetch(base+'/health')).status,200);
  let ip=0;
  class Client {
    cookie='';csrf='';visit='';address=`192.0.2.${++ip}`;
    async call(path,method='GET',input) {
      const r=await fetch(base+path,{method,headers:{Cookie:this.cookie,Origin:base,'Content-Type':'application/json','X-CSRF-Token':this.csrf,'X-Visit-ID':this.visit,'X-Real-IP':this.address},...(input===undefined?{}:{body:JSON.stringify(input)})});
      for(const c of r.headers.getSetCookie())if(c.startsWith('ft_session='))this.cookie=c.split(';')[0];
      const body=await r.json();if(body.csrf)this.csrf=body.csrf;if(body.visitId)this.visit=body.visitId;return {status:r.status,body};
    }
    async init(){await this.call('/api/session');return this;}
    async login(username,pin){return this.call('/api/auth/login','POST',{username,pin});}
  }
  const member=await new Client().init();
  await t.test('PIN accepts precisely six ASCII digits as a string and preserves leading zeroes',async()=>{
    for(const pin of ['',null,123456,'12345','1234567','abcdef','１２３４５６','123 45',' 123456']) {
      assert.equal((await member.call('/api/auth/signup','POST',{username:'pin_member',pin,adultConsent:true,privacyConsent:true})).status,400);
    }
    assert.equal((await member.call('/api/auth/signup','POST',{username:'pin_member',pin:'004219',adultConsent:true,privacyConsent:true})).status,200);
    const record=fixture.prepare("SELECT * FROM users WHERE username='pin_member'").get();
    assert.equal(record.auth_kind,'pin');assert.ok(record.password.startsWith('scrypt:'));assert.ok(!record.password.includes('004219'));
    await member.call('/api/me','PATCH',{name:'PIN Test',whatsapp:'+12025550123'});
    const second=await new Client().init();assert.equal((await second.login('pin_member','004219')).status,200);
    assert.equal((await second.login('pin_member','004218')).status,401);
    assert.equal((await second.call('/api/auth/login','POST',{username:'pin_member',password:'004219'})).status,400);
  });
  await t.test('legacy password migration verifies the old secret, preserves data and is one-time',async()=>{
    const legacy=await new Client().init();
    assert.equal((await legacy.login('legacy_member','123456')).status,401);
    assert.equal((await legacy.call('/api/auth/migrate-pin','POST',{username:'legacy_member',currentPassword:'Wrong-password-value!',pin:'042198'})).status,401);
    const saved=await legacy.call('/api/auth/migrate-pin','POST',{username:'legacy_member',currentPassword:legacyPassword,pin:'042198'});
    assert.equal(saved.status,200);assert.equal(saved.body.user.needs_pin,0);assert.equal(saved.body.user.name,'Kept Name');assert.equal(saved.body.user.whatsapp,'+12025550124');
    assert.equal((await legacy.call('/api/profiles')).status,200);
    assert.equal((await legacy.call('/api/auth/migrate-pin','POST',{username:'legacy_member',currentPassword:legacyPassword,pin:'999999'})).status,401);
    assert.equal((await legacy.login('legacy_member','042198')).status,200);
  });
  await t.test('legacy sessions require PIN setup; setup revokes every older session',async()=>{
    const legacy=await new Client().init(),other=await new Client().init();
    const id=fixture.prepare("SELECT id FROM users WHERE username='legacy_session'").get().id;
    for(const [client,token] of [[legacy,'legacy-session-one'],[other,'legacy-session-two']]) {
      fixture.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(createHash('sha256').update(token).digest('hex'),id,client.csrf,Date.now()+3600000);
      client.cookie=`ft_session=${token}`;
    }
    assert.equal((await legacy.call('/api/session')).body.user.needs_pin,1);
    for(const path of ['/api/profiles','/api/connections','/media/alex/portrait.jpg'])assert.equal((await legacy.call(path)).body.code,'PIN_REQUIRED');
    assert.equal((await legacy.call('/api/me/pin','POST',{currentPassword:legacyPassword,pin:'043219'})).status,200);
    assert.equal((await other.call('/api/session')).body.user,null);
    assert.equal((await legacy.call('/api/profiles')).status,200);
  });
  await t.test('PIN change needs the current PIN, revokes sessions, and rejects the previous PIN',async()=>{
    const second=await new Client().init();await second.login('pin_member','004219');
    assert.equal((await member.call('/api/me/pin','POST',{currentPin:'999999',pin:'041298'})).status,401);
    assert.equal((await member.call('/api/me/pin','POST',{currentPin:'004219',pin:'12345'})).status,400);
    assert.equal((await member.call('/api/me/pin','POST',{currentPin:'004219',pin:'041298'})).status,200);
    assert.equal((await second.call('/api/session')).body.user,null);
    assert.equal((await second.login('pin_member','004219')).status,401);
    assert.equal((await second.login('pin_member','041298')).status,200);
    assert.equal((await member.call('/api/me/password','POST',{currentPassword:'041298',password:'New-long-password!'})).status,404);
  });
  await t.test('guess limits persist in SQLite and follow the account across IP addresses',async()=>{
    const attacker=await new Client().init(),differentIP=await new Client().init();
    for(let i=0;i<5;i++)assert.equal((await attacker.login('legacy_member','999999')).status,401);
    assert.equal((await differentIP.login('legacy_member','042198')).status,429);
    assert.equal((await differentIP.call('/api/auth/migrate-pin','POST',{username:'legacy_member',currentPassword:legacyPassword,pin:'999999'})).status,429);
    assert.ok(fixture.prepare("SELECT count(*) AS n FROM rate_limits WHERE key LIKE 'credential:%' AND count=5").get().n>0);
  });
  await t.test('deleting an account verifies the PIN and secrets never appear in visit logs',async()=>{
    assert.equal((await member.call('/api/me','DELETE',{pin:'999999'})).status,401);
    assert.equal((await member.call('/api/me','DELETE',{pin:'041298'})).status,200);
    const files=readdirSync(join(data,'visits'),{recursive:true}).filter(f=>f.endsWith('.txt'));
    const logs=files.map(f=>readFileSync(join(data,'visits',f),'utf8')).join('\n');
    for(const secret of ['004219','041298','042198','043219',legacyPassword]) assert.ok(!logs.includes(secret));
    assert.match(logs,/PIN_CREATED/);assert.match(logs,/PIN_CHANGED/);
  });
});
