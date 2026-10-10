import {createRequire} from 'node:module';
import {spawn,execFileSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {once} from 'node:events';
import net from 'node:net';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {setupFixture} from './fixtures.mjs';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=resolve(import.meta.dirname,'..'),data=mkdtempSync(join(tmpdir(),'ft-photo-browser-'));
const socket=net.createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(r=>socket.close(r));
const base=`http://127.0.0.1:${port}`,media=await setupFixture(data),db=new DatabaseSync(join(data,'fantasytales.sqlite'));
const original=await sharp(Buffer.from('<svg width="1800" height="2400"><defs><linearGradient id="a"><stop stop-color="#693150"/><stop offset="1" stop-color="#e4aa67"/></linearGradient></defs><rect width="1800" height="2400" fill="url(#a)"/><circle cx="900" cy="1100" r="500" fill="#2b3445"/><path d="M0 2100L1200 1000L1800 1900Z" fill="#725f74"/></svg>')).png().toBuffer();
for(const p of db.prepare('SELECT id FROM profiles').all())writeFileSync(join(media,p.id,'portrait.png'),original);
for(let i=0;i<13;i++){const id='fixture'+String.fromCharCode(97+i);db.prepare('INSERT INTO profiles(id,name,bio,prompt) VALUES(?,?,?,?)').run(id,'Fictional '+String.fromCharCode(65+i),'Synthetic adult profile for browser checks.','A synthetic profile.');mkdirSync(join(media,id));writeFileSync(join(media,id,'portrait.png'),original);}
const env={...process.env,HOST:'127.0.0.1',PORT:String(port),APP_ORIGIN:base,DATA_DIR:data,MEDIA_DIR:media,CREDENTIALS_FILE:join(data,'credentials.txt')};execFileSync(process.execPath,['scripts/accounts.mjs','seed'],{cwd:root,env,stdio:'pipe'});
const server=spawn(process.execPath,['server.mjs'],{cwd:root,env,stdio:'pipe'});let output='';server.stderr.on('data',b=>output+=b);
const browser=await chromium.launch({headless:true}),out='test-results/photos';mkdirSync(out,{recursive:true});
try{
 for(let n=0;n<100;n++){try{if((await fetch(base+'/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,40));}
 assert.equal((await fetch(base+'/health')).status,200,output);
 const context=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:2});let s=await (await context.request.get(base+'/api/session')).json();
 async function post(path,data,method='POST'){const r=await context.request.fetch(base+path,{method,headers:{Origin:base,'X-CSRF-Token':s.csrf},data});assert.ok(r.ok(),`${path}: ${r.status()}`);const body=await r.json();if(body.csrf)s=body;return body;}
 await post('/api/auth/signup',{username:'photo_browser',pin:'246810',adultConsent:true,privacyConsent:true});await post('/api/me',{name:'Photo Browser',telegram:'photo_browser'},'PATCH');
 const page=await context.newPage(),errors=[],requests=[];page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{if(new URL(r.url()).pathname.startsWith('/media/'))requests.push({url:new URL(r.url()).pathname,status:r.status(),bytes:Number(r.headers()['content-length'])});});
 await page.goto(base+'/app#discover');await page.locator('.profile-card').first().waitFor();
 await page.waitForFunction(()=>{const i=document.querySelector('.profile-card img');return i.currentSrc.endsWith('.webp')&&i.complete&&i.naturalWidth>0;});
 const first=requests.length;assert.ok(first>0&&first<20,'Offscreen cards are deferred');assert.ok(await page.locator('.profile-card img[data-photo-src]').count()>0);assert.equal(await page.locator('.profile-card').count(),20);
 assert.ok(requests.every(r=>r.url.endsWith('.webp')&&r.status===200));assert.ok(requests.reduce((n,r)=>n+r.bytes,0)<original.length*first,'Displayed variants use fewer bytes');
 await page.screenshot({path:`${out}/discover-mobile.png`});
 await page.locator('.profile-card').first().getByRole('button',{name:/Explore profile/}).click();
 await page.waitForFunction(()=>{const i=document.querySelector('#gallery-photo');return i?.complete&&i.naturalWidth>0&&i.currentSrc.endsWith('.webp');});
 const thumbs=page.locator('.gallery-thumb');assert.equal(await thumbs.count(),6);
 for(let index=1;index<6;index++){
  await page.getByRole('button',{name:'Next photo',exact:true}).click();await page.waitForFunction(n=>{const i=document.querySelector('#gallery-photo');return i.complete&&i.naturalWidth>0&&document.querySelector('.gallery-counter').textContent===`${n+1} / 6`;},index);
 }
 assert.ok(requests.some(r=>r.url.endsWith('-128.webp')),'Thumbnails use actual small files');assert.ok(requests.every(r=>r.url.endsWith('.webp')&&r.status===200),'No original-image fallback needed');
 for(const width of [360,390,768,1440]){await page.setViewportSize({width,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert.ok(await page.getByRole('dialog').evaluate(el=>el.scrollWidth<=el.clientWidth+1));}
 await page.screenshot({path:`${out}/gallery-desktop.png`});await page.getByRole('button',{name:'Close profile',exact:true}).click();
 await page.setViewportSize({width:390,height:844});await page.locator('.profile-card').last().scrollIntoViewIfNeeded();await page.waitForFunction(()=>{const i=[...document.querySelectorAll('.profile-card img')].at(-1);return !i.dataset.photoSrc&&i.complete&&i.currentSrc.endsWith('.webp');});
 await page.locator('#profile-search').fill('Alex');await page.waitForFunction(()=>document.querySelectorAll('.profile-card').length===1);await page.locator('.profile-card').scrollIntoViewIfNeeded();await page.waitForFunction(()=>!document.querySelector('.profile-card img').dataset.photoSrc);
 assert.deepEqual(errors,[]);writeFileSync(`${out}/results.json`,JSON.stringify({passed:true,initialPhotoRequests:first,profileCount:20,optimizedCards:true,realThumbnails:true,allGalleryPhotos:true,searchAndScroll:true,widths:[360,390,768,1440],errors},null,2)+'\n');console.log('Photo browser checks passed: responsive variants, deferred cards, real thumbnails, complete gallery, scrolling, and search.');
}finally{await browser.close();db.close();server.kill('SIGTERM');await once(server,'exit');rmSync(data,{recursive:true,force:true});}
