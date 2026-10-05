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
const data=mkdtempSync(join(tmpdir(),'ft-featured-browser-')),root=resolve(import.meta.dirname,'..');
const socket=net.createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(r=>socket.close(r));
const base=`http://127.0.0.1:${port}`,credentials=join(data,'credentials.txt');
const media=await setupFixture(data),env={...process.env,HOST:'127.0.0.1',PORT:String(port),APP_ORIGIN:base,DATA_DIR:data,MEDIA_DIR:media,CREDENTIALS_FILE:credentials};
execFileSync(process.execPath,['scripts/accounts.mjs','seed'],{cwd:root,env,stdio:'pipe'});
const pinFor=name=>readFileSync(credentials,'utf8').match(new RegExp(`Username: ${name}\\nPIN: ([^\\n]+)`))[1];
const server=spawn(process.execPath,['server.mjs'],{cwd:root,env,stdio:'pipe'});let output='';server.stderr.on('data',b=>output+=b);
const browser=await chromium.launch({headless:true}),context=await browser.newContext(),page=await context.newPage(),admin=await browser.newContext();
const errors=[];page.on('pageerror',e=>errors.push(e.message));
const headers=csrf=>({Origin:base,'X-CSRF-Token':csrf});
async function post(ctx,url,body,csrf,method='post'){const r=await ctx.request[method](base+url,{headers:headers(csrf),data:body});assert.ok(r.ok(),`${r.status()} ${await r.text()}`);return r.json();}
mkdirSync('test-results/featured-request',{recursive:true});
try {
 for(let n=0;n<100;n++){try{if((await fetch(base+'/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,30));}
 let session=await (await context.request.get(base+'/api/session')).json();
 session=await post(context,'/api/auth/signup',{username:'feature_browser',pin:'246810',adultConsent:true,privacyConsent:true},session.csrf);
 const memberCsrf=session.csrf;
 await post(context,'/api/me',{name:'Fictional Candidate',whatsapp:'+12025550123'},memberCsrf,'patch');
 let as=await (await admin.request.get(base+'/api/session')).json();as=await post(admin,'/api/auth/login',{username:'site-admin',pin:pinFor('site-admin')},as.csrf);
 for(const width of [360,390,768,1440]) {
  await page.setViewportSize({width,height:900});
  for(const tab of ['discover','account']) {
   await page.goto(base+'/app#'+tab);await page.getByRole('heading',{name:'Want to be featured?',exact:true}).waitFor();
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${tab} overflow at ${width}`);
   if(tab==='discover' && [390,1440].includes(width))await page.screenshot({path:`test-results/featured-request/discover-${width}.png`,fullPage:true,animations:'disabled'});
  }
 }
 await page.setViewportSize({width:390,height:844});
 await page.getByRole('button',{name:'Request a featured profile',exact:true}).click();
 await page.getByRole('heading',{name:'Become a featured profile.',exact:true}).waitFor();
 assert.match(await page.locator('#featured-message').inputValue(),/email address.*description, photos, and other profile details/);
 assert.equal((await (await context.request.get(base+'/api/connections')).json()).connections.length,0,'Opening the draft must not send a message.');
 assert.ok(await page.getByRole('dialog').evaluate(el=>el.scrollWidth<=el.clientWidth),'Modal has no horizontal overflow');
 await page.screenshot({path:'test-results/featured-request/draft-390.png',fullPage:true,animations:'disabled'});
 await page.locator('#featured-message').fill('Hello Admin, please send the email address for my photos and description.');
 await page.getByRole('button',{name:'Send hello to Admin',exact:true}).click();
 await page.waitForURL('**#connections/*');await page.locator('.connection-card').waitFor();
 let request=(await (await context.request.get(base+'/api/featured-request')).json());
 assert.equal(request.connection.status,'pending');const id=request.connection.id;
 assert.equal((await (await context.request.get(base+'/api/connections')).json()).connections[0].message,'Hello Admin, please send the email address for my photos and description.');
 await page.getByRole('link',{name:'Account',exact:true}).click();await page.getByRole('button',{name:'Request a featured profile',exact:true}).click();
 await page.getByRole('heading',{name:'Waiting for Admin.',exact:true}).waitFor();
 assert.equal(await page.locator('form[data-form=featured-request]').count(),0);
 await page.getByRole('link',{name:'View your hello',exact:true}).click();await page.waitForURL('**#connections/'+id);
 assert.equal((await (await context.request.get(base+'/api/connections')).json()).connections.length,1);
 await post(admin,`/api/connections/${id}/respond`,{action:'accepted'},as.csrf);
 await page.getByRole('link',{name:'Account',exact:true}).click();await page.getByRole('button',{name:'Request a featured profile',exact:true}).click();
 await page.getByRole('button',{name:'Send message to Admin',exact:true}).click();await page.waitForURL('**#connections/'+id);
 await page.locator('.message-bubble').waitFor();
 assert.equal((await (await context.request.get(base+'/api/connections')).json()).connections.length,1);
 assert.match((await (await admin.request.get(base+'/api/connections')).json()).connections.find(c=>c.id===id).messages[0].text,/featured profile/);
 assert.equal((await (await context.request.get(base+'/api/session')).json()).user.profile_id,null,'Request never publishes a profile.');
 await post(admin,'/api/admin/profiles/admin',{published:false},as.csrf,'patch');
 await page.getByRole('link',{name:'Account',exact:true}).click();await page.getByRole('button',{name:'Request a featured profile',exact:true}).click();
 await page.getByRole('heading',{name:'Admin is unavailable.',exact:true}).waitFor();
 await post(admin,'/api/admin/profiles/admin',{published:true},as.csrf,'patch');
 // Existing featured owners see no upsell; hidden owners can request featuring.
 await post(context,'/api/auth/logout',{},memberCsrf);
 session=await (await context.request.get(base+'/api/session')).json();
 session=await post(context,'/api/auth/login',{username:'alex',pin:pinFor('alex')},session.csrf);
 await post(context,'/api/me',{name:'Alex',whatsapp:'+12025550123'},session.csrf,'patch');
 await page.goto(base+'/app#account');await page.reload();await page.locator('form[data-form=owner-profile]').waitFor();
 assert.equal(await page.locator('.featured-invite').count(),0);
 await post(admin,'/api/admin/profiles/alex',{published:false},as.csrf,'patch');
 await page.reload();await page.getByRole('heading',{name:'Want to be featured?',exact:true}).waitFor();
 assert.ok((await page.locator('main').innerText()).includes('Your profile is hidden from Discover.'));
 assert.deepEqual(errors,[]);
 const result={passed:true,widths:[360,390,768,1440],editableDraft:true,noAutomaticSend:true,pendingReuse:true,acceptedChatReuse:true,hiddenOwner:true,noAutomaticPublication:true,unavailableAdmin:true,errors};
 writeFileSync('test-results/featured-request/results.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await browser.close();if(server.exitCode===null){server.kill();await once(server,'exit');}rmSync(data,{recursive:true,force:true});}
