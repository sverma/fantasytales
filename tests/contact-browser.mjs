import {createRequire} from 'node:module';
import {spawn,execFileSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {once} from 'node:events';
import net from 'node:net';
import assert from 'node:assert/strict';
import {setupFixture} from './fixtures.mjs';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const data=mkdtempSync(join(tmpdir(),'ft-contact-browser-')),root=resolve(import.meta.dirname,'..');
const socket=net.createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(r=>socket.close(r));
const base=`http://127.0.0.1:${port}`,credentials=join(data,'credentials.txt');
const media=await setupFixture(data),env={...process.env,HOST:'127.0.0.1',PORT:String(port),APP_ORIGIN:base,DATA_DIR:data,MEDIA_DIR:media,CREDENTIALS_FILE:credentials};
execFileSync(process.execPath,['scripts/accounts.mjs','seed'],{cwd:root,env,stdio:'pipe'});
const pinFor=name=>readFileSync(credentials,'utf8').match(new RegExp(`Username: ${name}\\nPIN: ([^\\n]+)`))[1];
const server=spawn(process.execPath,['server.mjs'],{cwd:root,env,stdio:'pipe'});server.stderr.on('data',()=>{});
const browser=await chromium.launch({headless:true}),errors=[];
const out='test-results/contact-options';mkdirSync(out,{recursive:true});
async function post(ctx,path,data,csrf,method='post'){
 const r=await ctx.request[method](base+path,{headers:{Origin:base,'X-CSRF-Token':csrf},data});assert.ok(r.ok(),`${path}: ${r.status()} ${await r.text()}`);return r.json();
}
const values={whatsapp:'+12025550123',telegram:'@fictional_member',line:'fictional.line'};
try{
 for(let n=0;n<100;n++){try{if((await fetch(base+'/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,30));}
 for(const method of ['whatsapp','telegram','line']){
  const ctx=await browser.newContext(),page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));
  let session=await (await ctx.request.get(base+'/api/session')).json();
  session=await post(ctx,'/api/auth/signup',{username:'contact_'+method,pin:'246810',adultConsent:true,privacyConsent:true},session.csrf);
  await post(ctx,'/api/me',{name:'Fictional '+method},session.csrf,'patch');
  await page.goto(base+'/app#contact');await page.locator('form[data-form=contact]').waitFor();
  await page.locator(`[data-method=${method}]`).click();
  for(const other of Object.keys(values))assert.equal(await page.locator('#'+other).isVisible(),other===method);
  for(const width of [360,390,768,1440]){
   await page.setViewportSize({width,height:900});
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${method}: overflow at ${width}`);
   if(method==='telegram' && [390,1440].includes(width))await page.screenshot({path:`${out}/onboarding-${width}.png`,fullPage:true,animations:'disabled'});
  }
  await page.locator('#'+method).fill(values[method]);await page.locator('form[data-form=contact] button[type=submit]').click();
  await page.waitForURL('**#discover');await page.locator('.profile-card').first().waitFor();
  let saved=await (await ctx.request.get(base+'/api/session')).json();assert.equal(saved.user[method],values[method]);assert.equal(saved.user.contact_done,1);
  if(method!=='whatsapp')assert.equal(saved.user.whatsapp,'');
  await page.getByRole('link',{name:'Account',exact:true}).click();await page.locator('#account-'+method).waitFor();
  for(const key of Object.keys(values))await page.locator('#account-'+key).fill('');
  await page.locator('form[data-form=account] button[type=submit]').click();
  await page.getByText('Add at least one: WhatsApp number, Telegram username, or LINE ID.',{exact:true}).waitFor();
  const replacement=method==='line'?'telegram':'line';
  await page.locator('#account-'+replacement).fill(values[replacement]);await page.locator('form[data-form=account] button[type=submit]').click();
  await page.getByText('Your details have been saved.',{exact:true}).waitFor();await page.reload();
  assert.equal(await page.locator('#account-'+replacement).inputValue(),values[replacement]);assert.equal(await page.locator('#account-'+method).inputValue(),'');
  for(const width of [360,390,768,1440]){await page.setViewportSize({width,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
  if(method==='line'){
   await page.locator('#account-line').fill('x'.repeat(100));await page.locator('form[data-form=account] button[type=submit]').click();await page.getByText('Your details have been saved.',{exact:true}).waitFor();
   await page.goto(base+'/app#introduce/admin');await page.locator('form[data-form=introduce]').waitFor();
   assert.equal(await page.locator('[name=shareContact]').isChecked(),false);
   await page.locator('#introduction').fill('Hello Admin, this is a fictional messenger sharing test.');await page.locator('[name=shareContact]').check();
   await page.locator('form[data-form=introduce] button[type=submit]').click();await page.waitForURL('**#sent');
   const connection=(await (await ctx.request.get(base+'/api/connections')).json()).connections[0];
   const admin=await browser.newContext(),ap=await admin.newPage();ap.on('pageerror',e=>errors.push(e.message));
   let a=await (await admin.request.get(base+'/api/session')).json();a=await post(admin,'/api/auth/login',{username:'site-admin',pin:pinFor('site-admin')},a.csrf);
   await post(admin,`/api/connections/${connection.id}/respond`,{action:'accepted'},a.csrf);
   await ap.setViewportSize({width:390,height:844});await ap.goto(base+'/app#connections');await ap.locator('.contact-reveal').waitFor();
   assert.ok((await ap.locator('.contact-reveal').innerText()).includes(values.telegram));assert.ok((await ap.locator('.contact-reveal').innerText()).includes('x'.repeat(100)));
   assert.ok(await ap.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Long shared IDs must wrap');
   await ap.locator('.contact-reveal').screenshot({path:out+'/shared-messengers.png',animations:'disabled'});
   await ap.goto(base+'/app#admin');await ap.locator('#member-search').fill(values.telegram);await ap.locator('form[data-form=admin-search] button[type=submit]').click();
   await ap.waitForFunction(()=>document.querySelectorAll('.admin-member').length===1);assert.ok((await ap.locator('.admin-member-list').innerText()).includes(values.telegram));assert.ok(await ap.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   await admin.close();
  }
  await ctx.close();
 }
 assert.deepEqual(errors,[]);const result={passed:true,methods:Object.keys(values),widths:[360,390,768,1440],accountSwitching:true,emptyContactRejected:true,explicitSharing:true,adminDirectory:true,errors};
 writeFileSync(out+'/results.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await browser.close();if(server.exitCode===null){server.kill();await once(server,'exit');}rmSync(data,{recursive:true,force:true});}
