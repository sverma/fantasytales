import {createRequire} from 'node:module';
import {spawn,execFileSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {once} from 'node:events';
import net from 'node:net';
import assert from 'node:assert/strict';
import {setupFixture} from './fixtures.mjs';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const data=mkdtempSync(join(tmpdir(),'ft-objkt-browser-')),root=resolve(import.meta.dirname,'..');
const socket=net.createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(r=>socket.close(r));
const base=`http://127.0.0.1:${port}`,credentials=join(data,'credentials.txt'),media=await setupFixture(data);
const env={...process.env,HOST:'127.0.0.1',PORT:String(port),APP_ORIGIN:base,DATA_DIR:data,MEDIA_DIR:media,CREDENTIALS_FILE:credentials};
execFileSync(process.execPath,['scripts/accounts.mjs','seed'],{cwd:root,env,stdio:'pipe'});
const pinFor=name=>readFileSync(credentials,'utf8').match(new RegExp(`Username: ${name}\\nPIN: ([^\\n]+)`))[1];
const server=spawn(process.execPath,['server.mjs'],{cwd:root,env,stdio:'pipe'});let serverOutput='';server.stderr.on('data',b=>serverOutput+=b);
const browser=await chromium.launch({headless:true}),errors=[],out='test-results/objkt-profile';mkdirSync(out,{recursive:true});
async function api(ctx,path,data,csrf,method='POST'){
 const r=await ctx.request.fetch(base+path,{method,headers:{Origin:base,'X-CSRF-Token':csrf},data});assert.ok(r.ok(),`${path}: ${r.status()} ${await r.text()}`);return r.json();
}
async function save(page,value,status=200){
 await page.locator('#account-objkt-url').fill(value);
 const response=page.waitForResponse(r=>r.url()===base+'/api/me'&&r.request().method()==='PATCH');
 await page.locator('form[data-form="objkt-profile"] button[type=submit]').click();
 const r=await response;assert.equal(r.status(),status);return r.json();
}
async function fits(page){assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));}
try{
 for(let n=0;n<100;n++){try{if((await fetch(base+'/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,30));}
 assert.equal((await fetch(base+'/health')).status,200,serverOutput);
 const member=await browser.newContext(),mp=await member.newPage();mp.on('pageerror',e=>errors.push(e.message));
 await mp.goto(base+'/app');await mp.locator('form[data-form="auth"]').waitFor();
 assert.equal(await mp.locator('[name=objkt_url]').count(),0,'No NFT field in signup');
 let m=await (await member.request.get(base+'/api/session')).json();
 m=await api(member,'/api/auth/signup',{username:'nft_member',pin:'246810',adultConsent:true,privacyConsent:true},m.csrf);
 await mp.goto(base+'/app#account');await mp.reload();await mp.locator('#account-objkt-url').waitFor();
 assert.equal(await mp.locator('#account-objkt-url').getAttribute('required'),null);
 const memberUrl='https://objkt.com/@fixture-member';
 assert.equal((await save(mp,memberUrl)).user.contact_done,0);
 assert.equal((await member.request.get(base+'/api/profiles')).status(),403,'NFT link does not unlock Discover');
 await mp.reload();assert.equal(await mp.locator('#account-objkt-url').inputValue(),memberUrl);
 for(const width of [360,390,768,1440]){await mp.setViewportSize({width,height:900});await fits(mp);}
 await api(member,'/api/me',{name:'NFT Member',telegram:'fixture_member'},m.csrf,'PATCH');await mp.reload();
 const owner=await browser.newContext(),op=await owner.newPage();op.on('pageerror',e=>errors.push(e.message));
 let o=await (await owner.request.get(base+'/api/session')).json();o=await api(owner,'/api/auth/login',{username:'alex',pin:pinFor('alex')},o.csrf);
 await api(owner,'/api/me',{telegram:'fixture_owner'},o.csrf,'PATCH');
 await op.goto(base+'/app#account');await op.locator('#account-objkt-url').waitFor();
 assert.equal((await save(op,'https://other.example/profile',400)).error.includes('objkt.com'),true);
 const ownerUrl='https://objkt.com/users/tz1FixtureProfileAddress/owned?view='+'a'.repeat(130);
 await save(op,ownerUrl);await op.reload();assert.equal(await op.locator('#account-objkt-url').inputValue(),ownerUrl);
 for(const width of [390,1440]){
  await op.setViewportSize({width,height:900});await fits(op);await op.locator('form[data-form="objkt-profile"]').screenshot({path:`${out}/account-${width}.png`});
  await mp.setViewportSize({width,height:900});await mp.goto(base+'/app#discover');await mp.reload();await mp.locator('#profile-search').fill('Alex');
  const card=mp.locator('.profile-card').filter({has:mp.locator('[data-id="alex"]')});await card.getByRole('button',{name:/Explore profile/}).click();
  const dialog=mp.getByRole('dialog'),link=dialog.locator('.objkt-profile-link');await link.waitFor();
  assert.equal(await link.getAttribute('href'),ownerUrl);assert.equal(await link.getAttribute('target'),'_blank');assert.match(await link.getAttribute('rel'),/noopener/);assert.match(await link.getAttribute('rel'),/noreferrer/);
  assert.ok((await link.textContent()).includes(ownerUrl.replace('https://','')));await fits(mp);assert.ok(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1));
  await link.screenshot({path:`${out}/link-${width}.png`});await dialog.screenshot({path:`${out}/profile-${width}.png`});
  if(width===1440){
   await member.route('https://objkt.com/**',route=>route.fulfill({status:200,contentType:'text/html',body:'<title>External-link fixture</title>'}));
   const popupPromise=mp.waitForEvent('popup');await link.click();const popup=await popupPromise;await popup.waitForLoadState('domcontentloaded');assert.equal(popup.url(),ownerUrl);await popup.close();
  }
  await dialog.getByRole('button',{name:'Close profile',exact:true}).click();
 }
 let list=(await (await member.request.get(base+'/api/profiles')).json()).profiles;
 assert.ok(!JSON.stringify(list).includes(memberUrl));assert.equal(list.find(p=>p.id==='blair').objkt_url,'');
 const db=new DatabaseSync(join(data,'fantasytales.sqlite'));
 db.prepare("UPDATE profiles SET published=0 WHERE id='alex'").run();
 assert.ok(!(await (await member.request.get(base+'/api/profiles')).json()).profiles.some(p=>p.id==='alex'));
 db.prepare("UPDATE profiles SET published=1 WHERE id='alex'").run();db.close();
 await save(op,'');await op.reload();assert.equal(await op.locator('#account-objkt-url').inputValue(),'');
 await mp.goto(base+'/app#discover');await mp.reload();await mp.locator('#profile-search').fill('Alex');await mp.locator('.profile-card').getByRole('button',{name:/Explore profile/}).click();
 assert.equal(await mp.getByRole('dialog').locator('.objkt-profile-link').count(),0,'Clearing removes the link');
 assert.deepEqual(errors,[]);writeFileSync(`${out}/results.json`,JSON.stringify({passed:true,widths:[360,390,768,1440],saveRemove:true,profileVisibility:true,externalClick:true,signupUnchanged:true,contactGate:true,errors},null,2)+'\n');
 console.log('objkt browser checks passed: optional account field, saved/removed links, member privacy, featured visibility, safe external click, and responsive layout.');
}finally{
 await browser.close();server.kill('SIGTERM');await once(server,'exit');rmSync(data,{recursive:true,force:true});
}
