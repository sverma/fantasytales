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
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const data=mkdtempSync(join(tmpdir(),'ft-activity-browser-')),root=resolve(import.meta.dirname,'..');
const socket=net.createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(r=>socket.close(r));
const base=`http://127.0.0.1:${port}`,credentials=join(data,'credentials.txt'),media=await setupFixture(data);
const env={...process.env,HOST:'127.0.0.1',PORT:String(port),APP_ORIGIN:base,DATA_DIR:data,MEDIA_DIR:media,CREDENTIALS_FILE:credentials};
execFileSync(process.execPath,['scripts/accounts.mjs','seed'],{cwd:root,env,stdio:'pipe'});
const pinFor=name=>readFileSync(credentials,'utf8').match(new RegExp(`Username: ${name}\\nPIN: ([^\\n]+)`))[1];
const server=spawn(process.execPath,['server.mjs'],{cwd:root,env,stdio:'pipe'});let serverOutput='';server.stderr.on('data',b=>serverOutput+=b);
const browser=await chromium.launch({headless:true}),db=new DatabaseSync(join(data,'fantasytales.sqlite')),errors=[],out='test-results/activity';mkdirSync(out,{recursive:true});
async function api(ctx,path,data,csrf,method='POST'){
 const r=await ctx.request.fetch(base+path,{method,headers:{Origin:base,'X-CSRF-Token':csrf},data});assert.ok(r.ok(),`${path}: ${r.status()} ${await r.text()}`);return r.json();
}
try{
 for(let n=0;n<100;n++){try{if((await fetch(base+'/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,30));}
 assert.equal((await fetch(base+'/health')).status,200,serverOutput);
 const ctx=await browser.newContext({timezoneId:'America/Los_Angeles'}),page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));
 let a=await (await ctx.request.get(base+'/api/session')).json();a=await api(ctx,'/api/auth/login',{username:'site-admin',pin:pinFor('site-admin')},a.csrf);
 assert.equal(a.user.contact_done,0,'Admin activity requires no member contact onboarding');
 const member=await browser.newContext();let m=await (await member.request.get(base+'/api/session')).json();m=await api(member,'/api/auth/signup',{username:'activity_fixture',pin:'246810',adultConsent:true,privacyConsent:true},m.csrf);
 const name='<img src=x onerror=alert(1)> Fixture';
 db.prepare('UPDATE users SET name=? WHERE id=?').run(name,m.user.id);
 const insertLogin=db.prepare('INSERT INTO auth_activity(user_id,kind,created_at) VALUES(?,?,?)');
 for(let i=0;i<13;i++)insertLogin.run(m.user.id,'login',new Date(Date.now()-60000-i*1000).toISOString());
 const insertIntro=db.prepare('INSERT INTO connections(id,user_id,profile_id,message,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)');
 for(let i=0;i<13;i++){const at=new Date(Date.now()-60000-i*1000).toISOString();insertIntro.run(`activity-${i}`,m.user.id,i%2?'alex':'admin','Private fictional text','declined',at,at);}
 insertIntro.run('pending-fixture',m.user.id,'admin','Private fictional text','pending',new Date().toISOString(),new Date().toISOString());
 await page.goto(base+'/app#admin');await page.getByRole('button',{name:'Activity',exact:true}).click();await page.locator('#admin-activity').waitFor();
 assert.equal(await page.locator('#activity-login-list .activity-row').count(),10);assert.equal(await page.locator('#activity-introduction-list .activity-row').count(),10);
 assert.ok((await page.locator('#activity-login-list').textContent()).includes(name));assert.equal(await page.locator('#admin-activity img').count(),0);
 const time=page.locator('#activity-login-list time').first(),at=await time.getAttribute('datetime');
 const expected=new Intl.DateTimeFormat('en-IN',{timeZone:'Asia/Kolkata',dateStyle:'medium',timeStyle:'medium'}).format(new Date(at))+' IST';assert.equal(await time.textContent(),expected);
 for(const width of [360,390,768,1440]){
  await page.setViewportSize({width,height:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`overflow at ${width}`);
  if([390,1440].includes(width))await page.screenshot({path:`${out}/activity-${width}.png`,fullPage:true});
 }
 const loginPages=page.locator('[aria-label="Login pages"]'),introPages=page.locator('[aria-label="Introduction pages"]');
 await loginPages.getByRole('button',{name:'Next'}).click();await page.waitForFunction(()=>document.querySelector('[aria-label="Login pages"]').textContent.includes('Page 2 of 2'));
 assert.match(await page.locator('#activity-refresh-status').textContent(),/paused/);assert.match(await introPages.textContent(),/Page 1 of 2/);
 await loginPages.getByRole('button',{name:'Previous'}).click();await page.waitForFunction(()=>document.querySelector('[aria-label="Login pages"]').textContent.includes('Page 1 of 2'));
 await introPages.getByRole('button',{name:'Next'}).click();await page.waitForFunction(()=>document.querySelector('[aria-label="Introduction pages"]').textContent.includes('Page 2 of 2'));
 await page.locator('#activity-recipient').selectOption('admin');await page.locator('#activity-status').selectOption('pending');await page.getByRole('button',{name:'Apply filters'}).click();
 await page.waitForFunction(()=>document.querySelectorAll('#activity-introduction-list .activity-row').length===1);assert.match(await page.locator('#activity-introduction-list').textContent(),/Admin/);assert.match(await introPages.textContent(),/Page 1 of 1/);
 db.prepare("UPDATE connections SET status='accepted',updated_at=? WHERE id='pending-fixture'").run(new Date().toISOString());
 await page.getByRole('button',{name:'Refresh activity',exact:true}).click();await page.getByText('No introductions match these filters.',{exact:true}).waitFor();
 await page.locator('#activity-status').selectOption('accepted');await page.getByRole('button',{name:'Apply filters'}).click();await page.locator('#activity-introduction-list .status-accepted').waitFor();
 await page.clock.install();
 insertLogin.run(m.user.id,'pin_migration',new Date().toISOString());
 let refreshed=page.waitForResponse(r=>r.url().includes('/api/admin/activity?')&&r.ok());await page.clock.fastForward(30000);await refreshed;
 await page.waitForFunction(()=>document.querySelector('#activity-login-list').textContent.includes('Signed in · PIN created'));
 let requests=0;page.on('request',r=>{if(r.url().includes('/api/admin/activity?'))requests++;});
 await page.locator('#activity-recipient').focus();await page.clock.fastForward(30000);assert.equal(requests,0,'Polling preserves a filter in use');
 await page.getByRole('button',{name:'Members',exact:true}).click();await page.getByRole('heading',{name:'Member directory'}).waitFor();requests=0;await page.clock.fastForward(60000);assert.equal(requests,0,'Polling stops after leaving Activity');
 await page.getByRole('button',{name:'Activity',exact:true}).click();await page.locator('#admin-activity').waitFor();
 // Permission revocation must clear already rendered sensitive activity on refresh.
 db.prepare("UPDATE users SET role='owner' WHERE id=?").run(a.user.id);
 await page.getByRole('button',{name:'Refresh activity',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('#admin-activity'));assert.ok(!(await page.locator('#main').textContent()).includes('activity_fixture'));
 const mp=await member.newPage();await mp.goto(base+'/app#admin');await mp.locator('#main').waitFor();assert.equal(await mp.getByRole('link',{name:'Admin',exact:true}).count(),0);assert.equal((await member.request.get(base+'/api/admin/activity')).status(),403);
 assert.deepEqual(errors,[]);writeFileSync(`${out}/results.json`,JSON.stringify({passed:true,widths:[360,390,768,1440],ist:true,pagination:true,filters:true,manualAndAutomaticRefresh:true,revocation:true,escaping:true,errors},null,2)+'\n');
 console.log('Admin activity browser checks passed: responsive layout, IST, pagination, filters, refresh, escaping, and revoked access.');
}finally{await browser.close();db.close();server.kill('SIGTERM');await once(server,'exit');rmSync(data,{recursive:true,force:true});}
