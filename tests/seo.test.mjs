import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {once} from 'node:events';
import net from 'node:net';
import {publicPaths,publicPage,robots,sitemap} from '../seo.mjs';

test('public documents have unique metadata, crawlable content and no private data',()=>{
  const titles=new Set();
  for(const path of publicPaths) {
    const html=publicPage(path,'https://example.org','test-verification');
    assert.ok(!html.includes('{{'));
    assert.match(html,/<h1>/);assert.match(html,/<meta name="robots" content="index,follow">/);
    assert.ok(html.includes(`rel="canonical" href="https://example.org${path}"`));
    assert.ok(html.includes('name="google-site-verification" content="test-verification"'));
    assert.ok(!html.includes('/app.js'));assert.ok(!html.includes('/media/'));
    titles.add(html.match(/<title>([^<]+)<\/title>/)[1]);
    const schema=JSON.parse(html.match(/<script type="application\/ld\+json">([^<]+)<\/script>/)[1]);
    assert.equal(schema['@type'],'WebSite');assert.equal(schema.url,'https://example.org/');
    assert.equal(schema.aggregateRating,undefined);
  }
  assert.equal(titles.size,publicPaths.length);
  assert.ok(!robots('https://example.org').includes('Disallow: /\n'));
  assert.ok(!robots('https://example.org').includes('Disallow: /app'));
  assert.ok(!sitemap('https://example.org').includes('/app'));
  assert.equal((sitemap('https://example.org').match(/<loc>/g)||[]).length,5);
});

test('real HTTP routes separate public indexing, private app and verification files',async t=>{
  const data=mkdtempSync(join(tmpdir(),'ft-seo-'));
  const socket=net.createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');
  const port=socket.address().port;await new Promise(done=>socket.close(done));
  const base=`http://127.0.0.1:${port}`;
  mkdirSync(join(data,'site-verification'));writeFileSync(join(data,'site-verification/googleabcdef.html'),'google-site-verification: googleabcdef.html');
  const child=spawn(process.execPath,['server.mjs'],{cwd:resolve(import.meta.dirname,'..'),env:{...process.env,HOST:'127.0.0.1',PORT:String(port),DATA_DIR:data,APP_ORIGIN:base,GOOGLE_SITE_VERIFICATION:'test-token'},stdio:'pipe'});
  let output='';child.stderr.on('data',b=>output+=b);
  t.after(async()=>{if(child.exitCode===null){child.kill();await once(child,'exit');}rmSync(data,{recursive:true,force:true});});
  for(let i=0;i<100;i++){try{if((await fetch(base+'/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,30));}
  for(const path of publicPaths) {
    const response=await fetch(base+path);assert.equal(response.status,200,output);
    assert.equal(response.headers.get('x-robots-tag'),null);assert.equal(response.headers.get('set-cookie'),null);
    assert.match(response.headers.get('content-security-policy'),/script-src 'self' 'sha256-/);
    assert.ok((await response.text()).includes('<h1>'));
    const head=await fetch(base+path,{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');
  }
  const app=await fetch(base+'/app');assert.equal(app.status,200);assert.match(app.headers.get('x-robots-tag'),/noindex/);assert.match(await app.text(),/noindex,nofollow,noimageindex/);
  for(const path of ['/api/profiles','/media/sample/portrait.png']){
    const r=await fetch(base+path);assert.equal(r.status,401);assert.match(r.headers.get('x-robots-tag'),/noindex/);
  }
  for(const path of ['/unknown','/seo.mjs','/public/home.html','/app.html','/.git/config','/.env','/data/connections.csv'])assert.equal((await fetch(base+path)).status,404,path);
  for(const [path,location] of [['/index.html','/'],['/about/','/about'],['/app/','/app']]){
    const response=await fetch(base+path,{redirect:'manual'});assert.equal(response.status,301);assert.equal(response.headers.get('location'),location);
  }
  assert.match(await (await fetch(base+'/robots.txt')).text(),new RegExp(`Sitemap: ${base}/sitemap.xml`));
  assert.match((await fetch(base+'/sitemap.xml')).headers.get('content-type'),/application\/xml/);
  assert.equal(await (await fetch(base+'/googleabcdef.html')).text(),'google-site-verification: googleabcdef.html');
  assert.equal((await fetch(base+'/google000000.html')).status,404);
});
