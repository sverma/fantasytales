import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {once} from 'node:events';
import net from 'node:net';
import {DatabaseSync} from 'node:sqlite';
import sharp from 'sharp';
import {setupFixture} from './fixtures.mjs';
async function port(){const s=net.createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const n=s.address().port;await new Promise(r=>s.close(r));return n;}

test('real Nginx cache hits always recheck current access and photo revisions',async t=>{
 const root=resolve(import.meta.dirname,'..'),data=mkdtempSync(join(tmpdir(),'ft-photo-nginx-'));
 const appPort=await port(),nginxPort=await port(),base=`http://127.0.0.1:${nginxPort}`,direct=`http://127.0.0.1:${appPort}`;
 const media=await setupFixture(data),file=join(media,'alex','portrait.png');writeFileSync(file,await sharp({create:{width:1000,height:1400,channels:3,background:'#895165'}}).png().toBuffer());
 const env={...process.env,HOST:'127.0.0.1',PORT:String(appPort),APP_ORIGIN:base,DATA_DIR:data,MEDIA_DIR:media,CREDENTIALS_FILE:join(data,'credentials.txt')};
 execFileSync(process.execPath,['scripts/accounts.mjs','seed'],{cwd:root,env,stdio:'pipe'});
 const server=spawn(process.execPath,['server.mjs'],{cwd:root,env,stdio:'pipe'});let output='';server.stderr.on('data',b=>output+=b);
 const prefix=join(data,'nginx');mkdirSync(prefix);mkdirSync(join(prefix,'cache'));
 const locations=readFileSync(join(root,'deploy/photo-cache-locations.conf'),'utf8').replaceAll('127.0.0.1:3000',`127.0.0.1:${appPort}`);
 const http=readFileSync(join(root,'deploy/photo-cache-http.conf'),'utf8').replace('/var/cache/nginx/fantasytales-photos',join(prefix,'cache'));
 writeFileSync(join(prefix,'nginx.conf'),`pid ${prefix}/nginx.pid; error_log ${prefix}/error.log; worker_processes 1; events{worker_connections 128;} http{access_log off; client_body_temp_path ${prefix}/body; proxy_temp_path ${prefix}/proxy; ${http} server{listen 127.0.0.1:${nginxPort}; ${locations} location /{proxy_pass ${direct};proxy_set_header Host $host;}}}`);
 const nginx=spawn(process.env.NGINX_BIN||'nginx',['-p',prefix,'-c',join(prefix,'nginx.conf'),'-g','daemon off;'],{stdio:'pipe'});nginx.stderr.on('data',b=>output+=b);nginx.on('error',e=>output+=e.message);
 const db=new DatabaseSync(join(data,'fantasytales.sqlite'));db.exec('PRAGMA foreign_keys=ON');
 t.after(async()=>{for(const p of [nginx,server])if(p.exitCode===null){p.kill('SIGTERM');await once(p,'exit');}db.close();rmSync(data,{recursive:true,force:true});});
 for(let n=0;n<100;n++){try{if((await fetch(base+'/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,40));}
 assert.equal((await fetch(base+'/health')).status,200,output);
 class Client{
  cookie='';csrf='';id;
  async call(path,method='GET',data,extra={}){const r=await fetch(base+path,{method,headers:{Cookie:this.cookie,Origin:base,'Content-Type':'application/json','X-CSRF-Token':this.csrf,...extra},...(data!==undefined?{body:JSON.stringify(data)}:{})});for(const c of r.headers.getSetCookie())if(c.startsWith('ft_session='))this.cookie=c.split(';')[0];const bytes=Buffer.from(await r.arrayBuffer());let body;try{body=JSON.parse(bytes);}catch{}if(body?.csrf)this.csrf=body.csrf;if(body?.user)this.id=body.user.id;return {status:r.status,headers:r.headers,body,bytes};}
  async signup(name,contact=true){await this.call('/api/session');assert.equal((await this.call('/api/auth/signup','POST',{username:name,pin:'246810',adultConsent:true,privacyConsent:true})).status,200);if(contact)assert.equal((await this.call('/api/me','PATCH',{name:'Fictional Member',telegram:name})).status,200);}
 }
 const a=new Client(),b=new Client(),incomplete=new Client(),anon=new Client();await a.signup('cache_member');await b.signup('cache_second');await incomplete.signup('cache_incomplete',false);
 let list=(await a.call('/api/profiles')).body.profiles;let url=list.find(p=>p.id==='alex').photoVariants[0].card;
 await t.test('MISS then shared HIT, private browser headers, and valid image bytes',async()=>{
  const first=await a.call(url);assert.equal(first.status,200);assert.equal(first.headers.get('x-photo-cache'),'MISS');assert.match(first.headers.get('cache-control'),/private, no-store/);assert.equal(first.headers.get('content-type'),'image/webp');assert.equal((await sharp(first.bytes).metadata()).width,480);
  const hit=await b.call(url);assert.equal(hit.status,200);assert.equal(hit.headers.get('x-photo-cache'),'HIT');assert.ok(hit.bytes.equals(first.bytes));assert.equal(hit.headers.get('set-cookie'),null);
  const head=await a.call(url,'HEAD');assert.equal(head.status,200);assert.equal(head.headers.get('x-photo-cache'),'HIT');assert.equal(head.bytes.length,0);assert.equal(Number(head.headers.get('content-length')),first.bytes.length);
  assert.equal((await a.call(url+'?irrelevant=1')).headers.get('x-photo-cache'),'HIT');
  for(const path of ['/api/media-authorize','/_fantasytales_photo_auth'])assert.equal((await a.call(path)).status,404);
 });
 await t.test('warm cache denies anonymous, incomplete, suspended, and blocked accounts',async()=>{
  assert.equal((await anon.call(url)).status,401);assert.equal((await incomplete.call(url)).status,403);
  db.prepare('UPDATE users SET suspended=1 WHERE id=?').run(b.id);assert.ok([401,403].includes((await b.call(url)).status));db.prepare('UPDATE users SET suspended=0 WHERE id=?').run(b.id);
  const owner=db.prepare("SELECT id FROM users WHERE profile_id='alex'").get().id;
  for(const [blocker,blocked] of [[a.id,owner],[owner,a.id]]){db.prepare('INSERT INTO blocks VALUES(?,?)').run(blocker,blocked);assert.equal((await a.call(url)).status,403);db.prepare('DELETE FROM blocks WHERE blocker_id=? AND blocked_id=?').run(blocker,blocked);}
  assert.equal((await a.call(url)).headers.get('x-photo-cache'),'HIT');
  db.prepare("UPDATE users SET telegram='',contact_done=1 WHERE id=?").run(a.id);assert.equal((await a.call(url)).status,403);db.prepare("UPDATE users SET telegram='cache_member' WHERE id=?").run(a.id);
 });
 await t.test('hiding, replacement, and deletion immediately invalidate warm access',async()=>{
  db.prepare("UPDATE profiles SET published=0 WHERE id='alex'").run();assert.equal((await a.call(url)).status,403);db.prepare("UPDATE profiles SET published=1 WHERE id='alex'").run();assert.equal((await a.call(url)).headers.get('x-photo-cache'),'HIT');
  writeFileSync(file,await sharp({create:{width:1000,height:1400,channels:3,background:'#345678'}}).png().toBuffer());
  const next=(await a.call('/api/profiles')).body.profiles.find(p=>p.id==='alex').photoVariants[0].card;assert.notEqual(next,url);assert.equal((await a.call(url)).status,403);url=next;
  assert.equal((await a.call(url)).headers.get('x-photo-cache'),'MISS');assert.equal((await a.call(url)).headers.get('x-photo-cache'),'HIT');
  const original=readFileSync(file);rmSync(file);assert.equal((await a.call(url)).status,403);writeFileSync(file,original);
 });
 await t.test('logout, session expiry, and account deletion deny warm access',async()=>{
  const old=b.cookie;assert.equal((await b.call('/api/auth/logout','POST',{})).status,200);b.cookie=old;assert.equal((await b.call(url)).status,401);
  db.prepare('UPDATE sessions SET expires_at=0 WHERE user_id=?').run(a.id);assert.equal((await a.call(url)).status,401);
  await a.call('/api/session');assert.equal((await a.call('/api/auth/login','POST',{username:'cache_member',pin:'246810'})).status,200);assert.equal((await a.call(url)).headers.get('x-photo-cache'),'HIT');
  db.prepare('DELETE FROM users WHERE id=?').run(incomplete.id);assert.equal((await incomplete.call(url)).status,401);
 });
 await t.test('warm cache fails closed when authorization is unavailable',async()=>{
  server.kill('SIGTERM');await once(server,'exit');assert.equal((await a.call(url)).status,500);
 });
});
