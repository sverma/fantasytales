import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import net from 'node:net';
import {DatabaseSync} from 'node:sqlite';
import {setupFixture} from './fixtures.mjs';

test('Admin activity records successful authentication and restricts feeds', async t => {
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

  const visitor=await new Client().init(),member=await new Client().init(),owner=await new Client().init(),admin=await new Client().init();
  const db=new DatabaseSync(join(data,'fantasytales.sqlite'));db.exec('PRAGMA foreign_keys=ON');t.after(()=>db.close());
  await member.signup('activity_member','Activity Member');await owner.login('alex');await admin.login('site-admin');
  await t.test('admin-only endpoint; successful logins are recorded without visit tracking',async()=>{
    assert.equal((await visitor.call('/api/admin/activity')).status,401);
    for(const client of [member,owner])assert.equal((await client.call('/api/admin/activity')).status,403);
    const noVisit=await new Client().init();noVisit.visit='';
    assert.equal((await noVisit.call('/api/auth/signup','POST',{username:'no_visit',pin:'012345',adultConsent:true,privacyConsent:true})).status,200);
    let rows=(await admin.call('/api/admin/activity')).body.logins.items;
    assert.equal(rows.find(r=>r.username==='no_visit').kind,'signup');assert.equal(rows.find(r=>r.username==='no_visit').setupComplete,false);
    const before=db.prepare("SELECT count(*) AS n FROM auth_activity WHERE user_id=?").get(noVisit.user.id).n;
    assert.equal((await noVisit.call('/api/auth/login','POST',{username:'no_visit',pin:'123456'})).status,401);
    assert.equal(db.prepare('SELECT count(*) AS n FROM auth_activity WHERE user_id=?').get(noVisit.user.id).n,before,'Failed login does not appear as a successful login');
    assert.equal((await noVisit.call('/api/auth/login','POST',{username:'no_visit',pin:'012345'})).status,200);
    assert.equal(db.prepare('SELECT count(*) AS n FROM auth_activity WHERE user_id=?').get(noVisit.user.id).n,before+1);
    assert.equal((await noVisit.call('/api/profiles')).status,403,'Logging does not bypass contact onboarding');
    const response=await admin.call('/api/admin/activity');assert.match(response.headers.get('cache-control'),/no-store/);
    assert.equal(response.body.logins.items[0].username,'no_visit');assert.equal(response.body.logins.items[0].kind,'login');
    for(const row of response.body.logins.items)for(const key of ['password','pin','csrf','whatsapp','telegram','line','ip','token_hash'])assert.ok(!(key in row));
    assert.equal((await noVisit.call('/api/me','DELETE',{pin:'012345'})).status,200);
    assert.equal(db.prepare('SELECT count(*) AS n FROM auth_activity WHERE user_id=?').get(noVisit.user.id).n,0,'Deleting an account removes login history');
  });
  await t.test('real introduction creation and response are reflected with no private message contents',async()=>{
    const sent=await member.call('/api/connections','POST',{profile:'admin',message:'Private test introduction contents should not be in the activity feed.'});assert.equal(sent.status,201);
    const id=sent.body.id;assert.ok(id);
    let result=await admin.call('/api/admin/activity?recipient=admin&status=pending');assert.equal(result.status,200);
    const entry=result.body.introductions.items.find(r=>r.id===id);assert.equal(entry.username,'activity_member');assert.equal(entry.recipientName,'Admin');assert.equal(entry.status,'pending');assert.equal(entry.toAdmin,1);
    assert.equal(result.body.summary.pendingToAdmin,1);assert.ok(!JSON.stringify(result.body).includes('Private test introduction'));
    assert.equal((await admin.call(`/api/connections/${id}/respond`,'POST',{action:'accepted'})).status,200);
    assert.equal((await admin.call('/api/admin/activity?recipient=admin&status=pending')).body.introductions.total,0);
    assert.equal((await admin.call('/api/admin/activity?recipient=admin&status=accepted')).body.introductions.items[0].id,id);
  });
  await t.test('stable pagination, status filters, limits, and retention',async()=>{
    const now=new Date().toISOString();
    for(let i=0;i<14;i++)db.prepare('INSERT INTO auth_activity(user_id,kind,created_at) VALUES(?,?,?)').run(member.user.id,'login',new Date(Date.now()-i*1000-60000).toISOString());
    db.prepare('INSERT INTO auth_activity(user_id,kind,created_at) VALUES(?,?,?)').run(member.user.id,'login',new Date(Date.now()-31*86400000).toISOString());
    for(let i=0;i<13;i++)db.prepare("INSERT INTO connections(id,user_id,profile_id,message,status,created_at,updated_at) VALUES(?,?,?,?,'declined',?,?)").run(`fixture-${String(i).padStart(3,'0')}`,member.user.id,i%2?'alex':'admin','not exposed',now,now);
    const first=(await admin.call('/api/admin/activity')).body,second=(await admin.call('/api/admin/activity?loginPage=2&introductionPage=2')).body;
    assert.equal(first.logins.items.length,10);assert.equal(first.logins.total,17);assert.equal(first.logins.pages,2);
    assert.equal(new Set([...first.logins.items,...second.logins.items].map(r=>r.id)).size,17);
    assert.equal(first.introductions.total,14);assert.equal(first.introductions.items.length,10);assert.equal(second.introductions.items.length,4);
    assert.equal(new Set([...first.introductions.items,...second.introductions.items].map(r=>r.id)).size,14);
    const filtered=(await admin.call('/api/admin/activity?recipient=admin&status=declined')).body.introductions;
    assert.equal(filtered.total,7);assert.ok(filtered.items.every(r=>r.toAdmin===1&&r.status==='declined'));
    for(const q of ['loginPage=0','loginPage=-1','loginPage=1.5','introductionPage=Infinity','loginPage=9999999','recipient=other','status=invalid',"status=' OR 1=1 --"])
      assert.equal((await admin.call('/api/admin/activity?'+q)).status,400,q);
    assert.equal((await admin.call('/api/admin/activity?loginPage=999999')).body.logins.page,2);
  });
});
