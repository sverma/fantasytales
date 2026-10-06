import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import net from 'node:net';
import {setupFixture} from './fixtures.mjs';

test('objkt profile links preserve privacy and account boundaries', async t => {
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
  const member=await new Client().init(),owner=await new Client().init(),admin=await new Client().init();
  await member.signup('nft_reader','NFT Reader');await owner.login('alex');await admin.login('site-admin');
  await t.test('optional objkt URLs save independently, validate atomically, and appear only on linked featured profiles',async()=>{
    const url='https://objkt.com/@fictional-artist';
    const waiting=await new Client().init();
    assert.equal((await waiting.call('/api/auth/signup','POST',{username:'nft_waiting',pin:'012345',adultConsent:true,privacyConsent:true,objkt_url:url})).body.user.objkt_url,'','Signup does not collect NFT links');
    const saved=await waiting.call('/api/me','PATCH',{objkt_url:'  '+url+'  '});
    assert.equal(saved.status,200);assert.equal(saved.body.user.objkt_url,url);assert.equal(saved.body.user.contact_done,0);
    assert.equal((await waiting.call('/api/profiles')).status,403,'NFT links do not replace messenger contact details');
    assert.equal((await visitor.call('/api/me','PATCH',{objkt_url:url})).status,401);
    assert.equal((await owner.call('/api/me','PATCH',{objkt_url:url},{'X-CSRF-Token':'bad'})).status,403);
    assert.equal((await owner.call('/api/me','PATCH',{objkt_url:url})).status,200);
    assert.equal((await owner.call('/api/session')).body.user.objkt_url,url);
    let list=(await member.call('/api/profiles')).body.profiles;
    assert.equal(list.find(p=>p.id==='alex').objkt_url,url);
    assert.ok(list.filter(p=>p.id!=='alex').every(p=>p.objkt_url===''));
    for(const invalid of [null,{},42,'javascript:alert(1)','http://objkt.com/@name','https://objkt.com.evil.example/@name','https://objkt.com@evil.example/@name','https://evil.example/@name','https://objkt.com:8443/@name','https://user:password@objkt.com/@name','https://objkt.com/','https://objkt.com/tokens/123','https://objkt.com/@','https://objkt.com/users/','https://objkt.com/@bad%00name','https://objkt.com/@bad%2fname','https://objkt.com/@bad name','https://objkt.com/@'+'a'.repeat(500)]) {
      const res=await owner.call('/api/me','PATCH',{objkt_url:invalid,name:'Must not change'});
      assert.equal(res.status,400,JSON.stringify(invalid));
      assert.equal((await owner.call('/api/session')).body.user.name,'Alex');
      assert.equal((await owner.call('/api/session')).body.user.objkt_url,url);
    }
    for(const valid of ['https://objkt.com/users/tz1ExampleAddress/owned','https://objkt.com/profile/tz1ExampleAddress','https://objkt.com/@fictional-artist'])
      assert.equal((await owner.call('/api/me','PATCH',{objkt_url:valid})).status,200,valid);
    await member.call('/api/me','PATCH',{objkt_url:'https://objkt.com/@private-member',profile_id:'alex',id:owner.user.id});
    assert.equal((await owner.call('/api/session')).body.user.objkt_url,url,'Another member cannot change the owner link');
    list=(await member.call('/api/profiles')).body.profiles;
    assert.ok(!JSON.stringify(list).includes('private-member'),'Unfeatured member links stay private');
    await admin.call('/api/admin/profiles/alex','PATCH',{published:false});
    assert.ok(!(await member.call('/api/profiles')).body.profiles.some(p=>p.id==='alex'));
    await admin.call('/api/admin/profiles/alex','PATCH',{published:true});
    assert.equal((await member.call('/api/profiles')).body.profiles.find(p=>p.id==='alex').objkt_url,url);
    await owner.call('/api/me','PATCH',{objkt_url:'  '});
    assert.equal((await member.call('/api/profiles')).body.profiles.find(p=>p.id==='alex').objkt_url,'');
    const logs=readdirSync(join(data,'visits')).flatMap(day=>readdirSync(join(data,'visits',day)).map(file=>readFileSync(join(data,'visits',day,file),'utf8'))).join('\n');
    assert.ok(logs.includes('NFT_PROFILE_SAVED'));assert.ok(!logs.includes('https://objkt.com/'));
    assert.equal((await waiting.call('/api/me','DELETE',{pin:'012345'})).status,200);
  });
});
