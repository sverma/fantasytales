import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {once} from 'node:events';
import net from 'node:net';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const data=mkdtempSync(join(tmpdir(),'ft-public-browser-'));
const socket=net.createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(r=>socket.close(r));
const base=`http://127.0.0.1:${port}`;
const server=spawn(process.execPath,['server.mjs'],{cwd:resolve(import.meta.dirname,'..'),env:{...process.env,HOST:'127.0.0.1',PORT:String(port),APP_ORIGIN:base,DATA_DIR:data},stdio:'pipe'});
let output='';server.stderr.on('data',b=>output+=b);
const browser=await chromium.launch({headless:true});
const context=await browser.newContext();const page=await context.newPage();const errors=[];
page.on('pageerror',e=>errors.push(e.message));page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
page.on('response',response=>{if(response.status()>=400)errors.push(`${response.status()} ${response.url()}`);});
mkdirSync('test-results/public',{recursive:true});
try {
  for(let i=0;i<100;i++){try{if((await fetch(base+'/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,30));}
  for(const width of [360,390,768,1440]) {
    await page.setViewportSize({width,height:1000});
    for(const path of ['/','/about','/open-source','/privacy','/guidelines']) {
      assert.equal((await page.goto(base+path,{waitUntil:'networkidle'})).status(),200,output);
      assert.equal(await page.locator('h1').count(),1);
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${path} overflow at ${width}`);
      assert.equal(await page.locator('meta[name=robots]').getAttribute('content'),'index,follow');
      if(path==='/' && [390,1440].includes(width))await page.screenshot({path:`test-results/public/home-${width}.png`,fullPage:true});
    }
  }
  const plain=await browser.newContext({javaScriptEnabled:false});const nojs=await plain.newPage();
  await nojs.goto(base);assert.ok((await nojs.locator('h1').innerText()).includes('AI-powered dating'));await plain.close();
  await page.goto(base+'/#discover',{waitUntil:'networkidle'});
  await page.waitForURL('**/app#discover');await page.locator('form[data-form=auth]').waitFor({state:'visible'});
  assert.equal(await page.locator('meta[name=robots]').getAttribute('content'),'noindex,nofollow,noimageindex');
  await page.fill('#username','browser_fixture');await page.fill('#pin','246810');await page.fill('#confirm-pin','246810');
  await page.check('[name=adultConsent]');await page.check('[name=privacyConsent]');await page.locator('form[data-form=auth] button[type=submit]').click();
  await page.waitForURL('**#name');await page.fill('#name','Fictional Member');await page.locator('form[data-form=name] button[type=submit]').click();
  await page.waitForURL('**#contact');await page.fill('#whatsapp','+12025550123');await page.locator('form[data-form=contact] button[type=submit]').click();
  await page.waitForURL('**#discover');await page.getByRole('link',{name:'Account',exact:true}).click();
  await page.waitForURL('**#account');assert.ok((await page.locator('h1').innerText()).length>0);
  await page.setViewportSize({width:360,height:844});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Member app has no mobile overflow');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:true,publicPages:5,widths:[360,390,768,1440],noJavaScript:true,legacyLinks:true,signupOnboarding:true,errors}));
} finally {
  await browser.close();if(server.exitCode===null){server.kill();await once(server,'exit');}rmSync(data,{recursive:true,force:true});
}
