import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter,once} from 'node:events';
import http from 'node:http';
import net from 'node:net';
import {mkdtempSync,statSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {RequestWindow,routeGroup,createAppMetrics,aggregateCounts} from '../metrics.mjs';
import catalog from '../metrics-catalog.json' with {type:'json'};

function socketRequest(path,url='/metrics') {
  return new Promise((resolve,reject)=>{
    const request=http.get({socketPath:path,path:url},response=>{
      let body='';response.on('data',chunk=>body+=chunk);response.on('end',()=>resolve({status:response.statusCode,body}));
    });request.on('error',reject);
  });
}
test('rolling windows expire, compute weighted latency and bounded percentile, and separate aborts',()=>{
  let now=0;const window=new RequestWindow(()=>now);
  for(let i=0;i<95;i++)window.record('profiles',200,10);
  for(let i=0;i<5;i++)window.record('auth',500,100);
  window.record('profiles',200,1000,true);
  window.increment('page_discover');window.increment('login_failures');
  const values=window.snapshot();
  assert.equal(values.app_http_requests_per_min,100);
  assert.equal(values.app_http_response_avg_ms,14.5);
  assert.ok(values.app_http_response_p95_ms>=10 && values.app_http_response_p95_ms<10.1);
  assert.equal(values.app_http_5xx_percent,5);
  assert.equal(values.app_http_aborted_per_min,1);
  assert.equal(values.app_route_profiles_per_min,95);
  now=61000;const empty=window.snapshot();
  assert.equal(empty.app_http_requests_per_min,0);assert.equal(empty.app_http_response_p95_ms,0);
  assert.equal(window.buckets.size,0);
  for(let i=0;i<1000;i++){now=i*1000;window.record('other',404,1);}
  assert.equal(window.buckets.size,60);
});
test('request categories never contain dynamic paths, query strings, identifiers or monitoring traffic',()=>{
  assert.equal(routeGroup('/api/connections/private-id/messages?phone=secret'),'connections');
  assert.equal(routeGroup('/media/private-name/portrait.jpg'),'media');
  assert.equal(routeGroup('/unknown/private-name'),'other');
  assert.equal(routeGroup('/health?any=1'),null);
  assert.equal(new Set(catalog.map(row=>row.name)).size,catalog.length);
});
test('finish/close recorded once, page dimensions allowlisted and no personal values exported',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'ft-metrics-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const socket=join(dir,'m.sock');
  const metrics=createAppMetrics({db:{prepare(){throw new Error('unavailable');}},socketPath:socket});
  await metrics.start();t.after(()=>metrics.close());
  const response=new EventEmitter();response.statusCode=401;response.wblairbleFinished=true;
  metrics.observe({url:'/api/auth/login?user=secret-name'},response);
  metrics.event('PAGE_OPENED','discover');metrics.event('PAGE_OPENED','secret-name');metrics.event('INTRODUCTION_UPDATED','accepted');
  response.emit('finish');response.emit('close');
  const result=await socketRequest(socket);
  const values=Object.fromEntries(JSON.parse(result.body).metrics.map(row=>[row.name,row.value]));
  assert.equal(values.app_http_requests_per_min,1);assert.equal(values.app_http_inflight,0);
  assert.equal(values.app_login_failures_per_min,1);assert.equal(values.app_page_discover_per_min,1);
  assert.equal(values.app_event_accepted_per_min,1);assert.equal(values.app_database_up,0);
  assert.equal(values.app_members_total,undefined);
  assert.ok(!result.body.includes('secret-name'));assert.equal(statSync(socket).mode&0o777,0o600);
  assert.equal((await socketRequest(socket,'/unknown')).status,404);
});
test('aggregate activity counts have correct roles, status and rolling-day boundaries',()=>{
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE users(role TEXT,suspended INTEGER,created_at TEXT);CREATE TABLE connections(status TEXT,created_at TEXT,updated_at TEXT);
    CREATE TABLE profiles(published INTEGER);CREATE TABLE messages(created_at TEXT);CREATE TABLE visits(created_at INTEGER);CREATE TABLE sessions(user_id INTEGER,expires_at INTEGER);`);
  const now=Date.now(),recent=new Date(now-3600000).toISOString(),old=new Date(now-2*86400000).toISOString();
  for(const row of [['member',0,recent],['member',1,old],['admin',0,recent]])db.prepare('INSERT INTO users VALUES(?,?,?)').run(...row);
  for(const row of [['pending',recent,recent],['accepted',old,recent],['declined',old,old]])db.prepare('INSERT INTO connections VALUES(?,?,?)').run(...row);
  db.exec('INSERT INTO profiles VALUES(1),(0)');
  db.prepare('INSERT INTO messages VALUES(?),(?)').run(recent,old);db.prepare('INSERT INTO visits VALUES(?),(?)').run(now-10,now-3*86400000);
  db.prepare('INSERT INTO sessions VALUES(1,?),(NULL,?),(2,?)').run(now+10,now+10,now-10);
  const values=aggregateCounts(db,now);db.close();
  assert.deepEqual(values,{app_members_total:2,app_members_suspended:1,app_registrations_24h:1,app_profiles_published:1,
    app_introductions_total:3,app_introductions_pending:1,app_connections_accepted:1,app_introductions_24h:1,
    app_connections_accepted_24h:1,app_messages_24h:1,app_visits_24h:1,app_authenticated_sessions:1});
});
test('real application exposes only a private socket and accounts for real HTTP responses',async t=>{
  const data=mkdtempSync(join(tmpdir(),'ft-metrics-app-'));
  const listener=net.createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');
  const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
  const socket=join(data,'m.sock'),base='http://127.0.0.1:'+port;
  const child=spawn(process.execPath,['server.mjs'],{cwd:join(import.meta.dirname,'..'),env:{...process.env,DATA_DIR:data,PORT:String(port),HOST:'127.0.0.1',APP_ORIGIN:base,METRICS_SOCKET:socket},stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
  t.after(async()=>{if(child.exitCode===null){child.kill();await once(child,'exit');}rmSync(data,{recursive:true,force:true});});
  for(let i=0;i<100;i++){try{if((await fetch(base+'/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,50));}
  assert.equal((await fetch(base+'/health')).status,200,output);
  assert.equal((await fetch(base+'/metrics')).status,404);
  assert.equal((await fetch(base+'/')).status,200);
  assert.equal((await fetch(base+'/api/profiles')).status,401);
  const response=await socketRequest(socket);assert.equal(response.status,200,output);
  const values=Object.fromEntries(JSON.parse(response.body).metrics.map(row=>[row.name,row.value]));
  assert.equal(values.app_http_requests_per_min,3);assert.equal(values.app_http_2xx_per_min,1);assert.equal(values.app_http_4xx_per_min,2);
  assert.equal(values.app_database_up,1);assert.equal(values.app_members_total,0);
  assert.equal(JSON.parse(response.body).metrics.length,catalog.length-4);
});
