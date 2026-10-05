import http from 'node:http';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { db, dataDir, token, hashToken, hashPassword, checkPassword, exportCSV, validWhatsApp, validPIN, generatePIN } from './lib.mjs';
import {publicRating,adminRatings,saveRatingKey,readRatingKey,queueRatings} from './ratings.mjs';
import {createAppMetrics} from './metrics.mjs';
import {publicPaths,publicPage,robots,sitemap} from './seo.mjs';

const root = import.meta.dirname;
const mediaDir = resolve(process.env.MEDIA_DIR || join(root,'private','media'));
const origin = process.env.APP_ORIGIN || 'http://localhost:3000';
const production = process.env.NODE_ENV === 'production';
const secure = origin.startsWith('https://');
const sessionAge = 7 * 86400;
const jsonTypes = { '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.svg':'image/svg+xml', '.jpg':'image/jpeg', '.png':'image/png', '.woff2':'font/woff2', '.html':'text/html; charset=utf-8' };
const pages = new Set(['welcome','pin-setup','name','contact','discover','profile','introduce','sent','connections','account','admin','privacy','guidelines']);
const dummyPassword = await hashPassword(token());
let passwordWork = 0;
const metrics=createAppMetrics({db});

class HttpError extends Error { constructor(status, message, code) { super(message); this.status = status; this.code=code; } }
function fail(status, message) { throw new HttpError(status, message); }
function json(res, status, value) { res.writeHead(status, {'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify(value)); }
function getIP(req) { return process.env.TRUST_PROXY === '1' ? String(req.headers['x-real-ip'] || req.socket.remoteAddress) : req.socket.remoteAddress || 'unknown'; }
function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split(/=(.*)/s)).filter(c => c[0]).map(([k,v]) => [k,v || '']));
}
function setCookie(res, name, value, age, sameSite='Lax') {
  const c = `${name}=${value}; Path=/; Max-Age=${age}; HttpOnly; SameSite=${sameSite}${secure ? '; Secure' : ''}`;
  res.setHeader('Set-Cookie', [...(res.getHeader('Set-Cookie') || []), c]);
}
function session(req,res,create=false) {
  const sid = cookies(req).ft_session || '';
  let s = sid ? db.prepare('SELECT * FROM sessions WHERE token_hash=? AND expires_at>?').get(hashToken(sid),Date.now()) : null;
  if (!s && create) {
    const value = token();
    s = { token_hash:hashToken(value), user_id:null, csrf:token(), expires_at:Date.now()+sessionAge*1000 };
    db.prepare('INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES(?,?,?,?)').run(s.token_hash,null,s.csrf,s.expires_at);
    setCookie(res,'ft_session',value,sessionAge);
  }
  return s;
}
function rotateSession(req,res,userId) {
  const old=session(req,res);
  if (old) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(old.token_hash);
  const value=token(), csrf=token();
  db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(hashToken(value),userId,csrf,Date.now()+sessionAge*1000);
  setCookie(res,'ft_session',value,sessionAge);
  return csrf;
}
function getUser(s) {
  const u=s?.user_id ? db.prepare("SELECT id,username,name,whatsapp,contact_done,role,profile_id,auth_kind='password' AS needs_pin FROM users WHERE id=? AND suspended=0").get(s.user_id) : null;
  return u ? {...u,contact_done:Number(Boolean(u.contact_done) && validWhatsApp(u.whatsapp))} : null;
}
function requireUser(s,allowLegacy=false) {
  const u=getUser(s); if(!u) fail(401,'Please sign in to continue.');
  if(u.needs_pin && !allowLegacy) throw new HttpError(403,'Set your six-digit PIN to continue.','PIN_REQUIRED');
  return u;
}
function requireProfileAccess(u) {
  if(!u.contact_done || !validWhatsApp(u.whatsapp)) throw new HttpError(403,'Enter your WhatsApp number, including country code, before viewing profiles.','WHATSAPP_REQUIRED');
  return u;
}
function requireAdmin(s) { const u=requireUser(s); if(u.role!=='admin') fail(403,'This page is only available to the site administrator.'); return u; }
async function confirmAdministrator(req,res,s,pin) {
  const actor=requireAdmin(s);
  if(!validPIN(pin))fail(400,'Enter your own six-digit administrator PIN to confirm.');
  credentialAttempt(actor.username);
  if(passwordWork>=4)fail(429,'Please try again in a moment.');
  passwordWork++;
  try {
    const record=db.prepare('SELECT password FROM users WHERE id=?').get(actor.id);
    if(!await checkPassword(pin,record.password))fail(401,'Your administrator PIN is incorrect.');
    const fresh=requireAdmin(session(req,res));
    if(fresh.id!==actor.id || db.prepare('SELECT password FROM users WHERE id=?').get(actor.id).password!==record.password)fail(401,'Sign in again to confirm this change.');
    credentialSuccess(actor.username);return actor;
  } finally {passwordWork--;}
}
function rate(key,max,ms) {
  const now=Date.now();
  const row=db.prepare('SELECT * FROM rate_limits WHERE key=?').get(key);
  if (!row || row.resets_at<=now) db.prepare('INSERT INTO rate_limits VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=1,resets_at=excluded.resets_at').run(key,now+ms);
  else { if(row.count>=max) fail(429,'A little pause, please. Try again in a few minutes.'); db.prepare('UPDATE rate_limits SET count=count+1 WHERE key=?').run(key); }
}
function credentialAttempt(username) {
  const key=hashToken(username);
  rate(`credential:${key}`,5,15*60000);
  rate(`credential-day:${key}`,30,86400000);
}
function credentialSuccess(username) {
  const key=hashToken(username);
  db.prepare('DELETE FROM rate_limits WHERE key IN (?,?)').run(`credential:${key}`,`credential-day:${key}`);
}
function replaceCredential(user,hashed) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result=db.prepare("UPDATE users SET password=?,auth_kind='pin' WHERE id=? AND password=? AND suspended=0").run(hashed,user.id,user.password);
    if(!result.changes) fail(409,'Your sign-in details changed. Sign in again and retry.');
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
    db.exec('COMMIT');
  } catch(e) {db.exec('ROLLBACK');throw e;}
  credentialSuccess(user.username);
}
function clean(value,max=200) { return typeof value==='string' ? value.replace(/[\u0000-\u001F\u007F]/g,' ').trim().slice(0,max) : ''; }
function managedMember(id) {
  if(!Number.isSafeInteger(id) || id<1) fail(400,'Choose a valid member account.');
  const member=db.prepare("SELECT id,username,suspended FROM users WHERE id=? AND role='member'").get(id);
  if(!member) fail(404,'This member account is not available. Administrator and profile-owner accounts cannot be changed here.');
  return member;
}
function adminReason(value) {
  const reason=clean(value,301);
  if(reason.length<5 || reason.length>300) fail(400,'Add a reason between 5 and 300 characters.');
  return reason;
}
function memberChange(actor,member,action,reason,change) {
  db.exec('BEGIN IMMEDIATE');
  try {
    change();
    db.prepare('INSERT INTO admin_audit(actor_id,actor_username,target_username,action,reason,created_at) VALUES(?,?,?,?,?,?)')
      .run(actor.id,actor.username,member.username,action,reason,new Date().toISOString());
    db.exec('COMMIT');
  } catch(e) { db.exec('ROLLBACK');throw e; }
}
function visit(req,res,create=false) {
  const id=String(req.headers['x-visit-id'] || '');
  let v=id ? db.prepare('SELECT * FROM visits WHERE id=? AND created_at>?').get(id,Date.now()-12*3600000) : null;
  if(!v && create) {
    rate(`visit:${getIP(req)}`,60,3600000);
    const now=new Date(), day=now.toISOString().slice(0,10), newId=randomUUID();
    const folder=join(dataDir,'visits',day);
    mkdirSync(folder,{recursive:true,mode:0o700});
    const filename=`${now.toISOString().slice(11,23).replaceAll(':','-')}_${getIP(req).replace(/[^a-zA-Z0-9.-]/g,'_')}_${newId.slice(0,8)}.txt`;
    v={id:newId,file:join(day,filename),created_at:Date.now()};
    writeFileSync(join(dataDir,'visits',v.file),`${now.toISOString()} VISIT_STARTED ${JSON.stringify({ip:getIP(req)})}\n`,{mode:0o600});
    db.prepare('INSERT INTO visits VALUES(?,?,?)').run(v.id,v.file,v.created_at);
  }
  return v;
}
function log(req,res,event,details={}) {
  metrics.event(event,event==='PAGE_OPENED'?details.page:event==='INTRODUCTION_UPDATED'?details.status:undefined);
  const v=visit(req,res);
  if(v) appendFileSync(join(dataDir,'visits',v.file),`${new Date().toISOString()} ${event} ${JSON.stringify(details)}\n`);
}
async function body(req) {
  if(!(req.headers['content-type'] || '').startsWith('application/json')) fail(415,'Send JSON content.');
  let size=0, chunks=[];
  for await(const chunk of req) { size+=chunk.length; if(size>8192) fail(413,'That message is too long.'); chunks.push(chunk); }
  try { const b=JSON.parse(Buffer.concat(chunks).toString('utf8')); if(!b || Array.isArray(b) || typeof b!=='object') fail(400,'Invalid request.'); return b; }
  catch(e) { if(e.status) throw e; fail(400,'Please check your input and try again.'); }
}
function csrf(req,s) {
  if(req.headers.origin!==origin) fail(403,'Please use the website to make this request.');
  if(!s || req.headers['x-csrf-token']!==s.csrf) fail(403,'Your session has changed. Refresh this page and try again.');
}
function profileById(id) { const p=db.prepare('SELECT * FROM profiles WHERE id=? AND published=1').get(id); if(!p) fail(404,'This profile is not available.'); return p; }
function profilePhotos(id) {
  const folder=join(mediaDir,id);
  if(!existsSync(folder))return [];
  return readdirSync(folder)
    .filter(name=>/^(portrait|photo-\d{2})\.(jpg|png)$/.test(name))
    .sort((a,b)=>a.startsWith('portrait.')?-1:b.startsWith('portrait.')?1:a.localeCompare(b))
    .map(name=>`/media/${id}/${name}`);
}
function profileOwner(id) { return db.prepare('SELECT id,name,whatsapp FROM users WHERE profile_id=?').get(id); }
function isBlocked(a,b) { return b && db.prepare('SELECT 1 FROM blocks WHERE (blocker_id=? AND blocked_id=?) OR (blocker_id=? AND blocked_id=?)').get(a,b,b,a); }
function connectionFor(id,u) {
  const c=db.prepare('SELECT * FROM connections WHERE id=?').get(id);
  if(!c || (c.user_id!==u.id && c.profile_id!==u.profile_id)) fail(404,'This connection is not available.');
  if(isBlocked(c.user_id,profileOwner(c.profile_id)?.id)) fail(403,'This connection is no longer available.');
  return c;
}
function syncExport() { try { exportCSV(); } catch(e) { console.error('CSV export failed; authoritative records remain in SQLite:',e.message); } }
function serveFile(res,file) { const b=readFileSync(file); res.writeHead(200,{'Content-Type':jsonTypes[extname(file)] || 'application/octet-stream','Content-Length':b.length});res.end(b); }

function housekeeping() {
  db.prepare('DELETE FROM sessions WHERE expires_at<?').run(Date.now());
  db.prepare('DELETE FROM rate_limits WHERE resets_at<?').run(Date.now());
  const cutoff=new Date(Date.now()-30*86400000).toISOString().slice(0,10);
  const dir=join(dataDir,'visits');
  if(existsSync(dir)) for(const d of readdirSync(dir)) if(/^\d{4}-\d{2}-\d{2}$/.test(d) && d<cutoff) rmSync(join(dir,d),{recursive:true,force:true});
  db.prepare('DELETE FROM visits WHERE created_at<?').run(Date.now()-30*86400000);
  db.prepare('DELETE FROM admin_audit WHERE created_at<?').run(new Date(Date.now()-30*86400000).toISOString());
  syncExport();
}
housekeeping();
setInterval(housekeeping,3600000).unref();

const server=http.createServer(async(req,res)=>{
  metrics.observe(req,res);
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Referrer-Policy','same-origin');
  res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'");
  res.setHeader('Cache-Control','no-store');
  if(secure) res.setHeader('Strict-Transport-Security','max-age=31536000');
  try {
    const path=new URL(req.url,'http://local').pathname;
    if(req.method==='GET' && path==='/health') return json(res,200,{status:'ok'});
    if(['GET','HEAD'].includes(req.method)) {
      if(path==='/index.html' || (path.endsWith('/') && [...publicPaths.slice(1),'/app'].includes(path.slice(0,-1)))) {
        res.writeHead(301,{Location:path==='/index.html'?'/':path.slice(0,-1)});return res.end();
      }
      if(publicPaths.includes(path)) {
        const html=publicPage(path,origin,process.env.GOOGLE_SITE_VERIFICATION || '');
        res.setHeader('Content-Security-Policy',res.getHeader('Content-Security-Policy').replace("script-src 'self'","script-src 'self' 'sha256-"+createHash('sha256').update(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]).digest('base64')+"'"));
        res.setHeader('Cache-Control','public, max-age=300');
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});return res.end(req.method==='HEAD'?'':html);
      }
      if(path==='/robots.txt' || path==='/sitemap.xml') {
        res.setHeader('Cache-Control','public, max-age=300');
        res.writeHead(200,{'Content-Type':path==='/robots.txt'?'text/plain; charset=utf-8':'application/xml; charset=utf-8'});
        return res.end(req.method==='HEAD'?'':path==='/robots.txt'?robots(origin):sitemap(origin));
      }
      // Verification files are installed privately by the operator, not published in Git.
      if(/^\/google[a-f0-9]+\.html$/.test(path)) {
        const file=join(dataDir,'site-verification',path.slice(1));
        if(existsSync(file))return serveFile(res,file);
      }
    }
    if(path.startsWith('/api/') || path.startsWith('/media/') || path==='/app')res.setHeader('X-Robots-Tag','noindex, nofollow, noimageindex');
    if(path.startsWith('/api/')) rate(`api:${getIP(req)}`,300,60000);
    const s=session(req,res,path==='/api/session' && req.method==='GET');
    if(path.startsWith('/api/')) {
      if(req.method==='GET' && path==='/api/session') {
        const v=visit(req,res,true);
        return json(res,200,{user:getUser(s),csrf:s.csrf,visitId:v.id});
      }
      if(!['GET','HEAD'].includes(req.method)) csrf(req,s);
      if(req.method==='POST' && ['/api/auth/signup','/api/auth/login','/api/auth/migrate-pin'].includes(path)) {
        rate(`auth:${getIP(req)}`,30,15*60000);
        const b=await body(req), username=clean(b.username,50).toLowerCase(), migrating=path.endsWith('/migrate-pin');
        if(!/^[a-z0-9][a-z0-9_.-]{2,31}$/.test(username)) fail(400,'Use a username with 3–32 letters, numbers, dots, dashes, or underscores.');
        if(!validPIN(b.pin)) fail(400,'Enter exactly six digits for your PIN.');
        if(migrating && (typeof b.currentPassword!=='string' || b.currentPassword.length<12 || b.currentPassword.length>128)) fail(400,'Enter your existing password to switch to a PIN.');
        if(passwordWork>=4) fail(429,'Please try signing in again in a moment.');
        if(!path.endsWith('/signup')) credentialAttempt(username);
        passwordWork++;
        try {
          let u=db.prepare('SELECT * FROM users WHERE username=?').get(username);
          if(path.endsWith('/signup')) {
            if(b.adultConsent!==true || b.privacyConsent!==true) fail(400,'Confirm you are 18 or older and agree to the privacy notice and community guidelines.');
            if(u) fail(409,'That username is already taken. Try another, or sign in.');
            const hashed=await hashPassword(b.pin), now=new Date().toISOString();
            let result;
            try { result=db.prepare("INSERT INTO users(username,password,auth_kind,created_at,consent_at) VALUES(?,?,'pin',?,?)").run(username,hashed,now,now); }
            catch(e) { if(String(e.message).includes('UNIQUE')) fail(409,'That username is already taken.'); throw e; }
            u={id:Number(result.lastInsertRowid)};
            log(req,res,'ACCOUNT_CREATED',{userId:u.id,username});
          } else {
            const eligible=u?.auth_kind===(migrating?'password':'pin');
            const valid=await checkPassword(migrating?b.currentPassword:b.pin,eligible?u.password:dummyPassword);
            if(!eligible || !valid) fail(401,migrating?'The username or existing password is incorrect, or this account already uses a PIN.':'The username or PIN is incorrect. If you still use a password, choose “Switch to a PIN”.');
            if(u.suspended) fail(403,'This account is suspended. Contact the community organizer for help.');
            if(migrating) {
              replaceCredential(u,await hashPassword(b.pin));
              log(req,res,'PIN_CREATED',{userId:u.id});
            } else {
              const current=db.prepare('SELECT password,suspended FROM users WHERE id=?').get(u.id);
              if(current?.password!==u.password || current.suspended) fail(401,'Your sign-in details changed. Please sign in again.');
            }
            credentialSuccess(username);
            log(req,res,'SIGNED_IN',{userId:u.id,username});
          }
          const nextCsrf=rotateSession(req,res,u.id);
          return json(res,200,{csrf:nextCsrf,user:getUser({user_id:u.id})});
        } finally { passwordWork--; }
      }
      if(req.method==='POST' && path==='/api/auth/logout') {
        log(req,res,'SIGNED_OUT');
        if(s) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(s.token_hash);
        setCookie(res,'ft_session','',0);setCookie(res,'ft_visit','',0);
        return json(res,200,{ok:true});
      }
      if(req.method==='POST' && path==='/api/events') {
        const b=await body(req);
        if(b.event==='page_open' && pages.has(b.page)) log(req,res,'PAGE_OPENED',{page:b.page});
        else if(b.event==='profile_open' && typeof b.profile==='string') {requireProfileAccess(requireUser(s));const p=profileById(b.profile);log(req,res,'PROFILE_OPENED',{profile:p.name});}
        else fail(400,'Unknown event.');
        return json(res,200,{ok:true});
      }
      const u=requireUser(s,path==='/api/me/pin');
      if(req.method==='PATCH' && path==='/api/me') {
        const b=await body(req);
        const name='name' in b ? clean(b.name,61) : null;
        const phone='whatsapp' in b ? clean(b.whatsapp,30).replace(/[\s()-]/g,'') : null;
        if(name!==null && (name.length<2 || name.length>60)) fail(400,'Please enter a name between 2 and 60 characters.');
        if(phone!==null && !validWhatsApp(phone)) fail(400,'WhatsApp is required. Include your country code, for example +91 98765 43210.');
        if('name' in b) {
          db.prepare('UPDATE users SET name=? WHERE id=?').run(name,u.id);log(req,res,'NAME_SAVED',{name,userId:u.id});
        }
        if('whatsapp' in b) {
          db.prepare('UPDATE users SET whatsapp=?,contact_done=1 WHERE id=?').run(phone,u.id);log(req,res,'CONTACT_SAVED',{provided:!!phone,userId:u.id});
        }
        if(name!==null || phone!==null) syncExport();
        return json(res,200,{user:getUser(s)});
      }
      if(req.method==='POST' && path==='/api/me/pin') {
        const b=await body(req);
        if(!validPIN(b.pin)) fail(400,'Enter exactly six digits for your new PIN.');
        const current=u.needs_pin?b.currentPassword:b.currentPin;
        if(u.needs_pin ? typeof current!=='string'||current.length<12||current.length>128 : !validPIN(current)) fail(400,u.needs_pin?'Enter your existing password.':'Enter your current six-digit PIN.');
        credentialAttempt(u.username);
        if(passwordWork>=4) fail(429,'Please try again in a moment.');
        passwordWork++;
        try {
          const record=db.prepare('SELECT * FROM users WHERE id=?').get(u.id);
          if(!await checkPassword(current,record.password)) fail(401,u.needs_pin?'Your existing password is incorrect.':'Your current PIN is incorrect.');
          replaceCredential(record,await hashPassword(b.pin));
          const nextCsrf=rotateSession(req,res,u.id);log(req,res,u.needs_pin?'PIN_CREATED':'PIN_CHANGED',{userId:u.id});
          return json(res,200,{csrf:nextCsrf,user:getUser({user_id:u.id})});
        } finally {passwordWork--;}
      }
      if(req.method==='DELETE' && path==='/api/me') {
        if(u.role!=='member') fail(403,'Profile owners and administrators must use the server account tool to remove their account.');
        const b=await body(req);
        if(!validPIN(b.pin)) fail(400,'Enter your six-digit PIN to confirm.');
        credentialAttempt(u.username);
        if(passwordWork>=4) fail(429,'Please try again in a moment.');
        passwordWork++;
        try {
          const record=db.prepare('SELECT password FROM users WHERE id=?').get(u.id);
          if(!await checkPassword(b.pin,record.password)) fail(401,'Your PIN is incorrect.');
          if(!db.prepare('DELETE FROM users WHERE id=? AND password=?').run(u.id,record.password).changes) fail(409,'Your PIN changed. Please sign in again.');
          credentialSuccess(u.username);syncExport();
        } finally {passwordWork--;}
        setCookie(res,'ft_session','',0);setCookie(res,'ft_visit','',0);
        return json(res,200,{ok:true});
      }
      if(req.method==='GET' && path==='/api/profiles') {
        requireProfileAccess(u);
        const list=db.prepare(`SELECT p.*,EXISTS(SELECT 1 FROM favorites f WHERE f.user_id=? AND f.profile_id=p.id) AS saved FROM profiles p WHERE p.published=1 ORDER BY p.rowid`).all(u.id)
          .filter(p=>!isBlocked(u.id,profileOwner(p.id)?.id))
          .map(p=>{const photos=profilePhotos(p.id);return {...p,image:photos[0] || '/assets/profile-placeholder.svg',photos,rating:publicRating(db,p.id)};});
        return json(res,200,{profiles:list});
      }
      const fav=path.match(/^\/api\/favorites\/([a-z]+)$/);
      if(fav && req.method==='POST') {
        requireProfileAccess(u);
        const p=profileById(fav[1]), b=await body(req);
        if(b.saved===true) db.prepare('INSERT OR IGNORE INTO favorites VALUES(?,?)').run(u.id,p.id);
        else db.prepare('DELETE FROM favorites WHERE user_id=? AND profile_id=?').run(u.id,p.id);
        log(req,res,b.saved?'PROFILE_SAVED':'PROFILE_UNSAVED',{profile:p.name});
        return json(res,200,{saved:b.saved===true});
      }
      if(req.method==='POST' && path==='/api/connections') {
        requireProfileAccess(u);
        rate(`intro:${u.id}`,8,86400000);
        if(!u.name || !u.contact_done) fail(400,'Finish setting up your account first.');
        const b=await body(req), p=profileById(clean(b.profile,30)), message=clean(b.message,1001);
        if(message.length<10 || message.length>1000) fail(400,'Write an introduction between 10 and 1,000 characters.');
        const owner=profileOwner(p.id);
        if(!owner || owner.id===u.id || isBlocked(u.id,owner.id)) fail(400,'This profile cannot receive your introduction.');
        const existing=db.prepare("SELECT id FROM connections WHERE user_id=? AND profile_id=? AND status IN ('pending','accepted')").get(u.id,p.id);
        if(existing) fail(409,'You already have an introduction with this person. Find it in Connections.');
        const id=randomUUID(), now=new Date().toISOString();
        db.prepare('INSERT INTO connections(id,user_id,profile_id,message,share_contact,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(id,u.id,p.id,message,b.shareContact===true && !!u.whatsapp ? 1 : 0,now,now);
        syncExport();log(req,res,'INTRODUCTION_SENT',{user:u.name,profile:p.name,id});
        return json(res,201,{id,profile:p.name,status:'pending'});
      }
      if(req.method==='GET' && path==='/api/connections') {
        const rows=db.prepare(`SELECT c.*,u.name AS from_name,u.username AS from_username,u.whatsapp AS from_whatsapp,p.name AS profile_name FROM connections c JOIN users u ON u.id=c.user_id JOIN profiles p ON p.id=c.profile_id WHERE c.user_id=? OR c.profile_id=? ORDER BY c.created_at DESC`).all(u.id,u.profile_id || '');
        const list=rows.filter(c=>!isBlocked(c.user_id,profileOwner(c.profile_id)?.id)).map(c=>{
          const incoming=c.profile_id===u.profile_id;
          const contact=incoming && c.status==='accepted' && c.share_contact ? c.from_whatsapp : '';
          const messages=c.status==='accepted' ? db.prepare('SELECT m.id,m.text,m.created_at,m.sender_id,u.name AS sender FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.connection_id=? ORDER BY m.id DESC LIMIT 100').all(c.id).reverse() : [];
          return {id:c.id,profile_id:c.profile_id,image:profilePhotos(c.profile_id)[0],name:incoming ? c.from_name : c.profile_name,message:c.message,status:c.status,created_at:c.created_at,incoming,contact,messages:messages.map(m=>({...m,mine:m.sender_id===u.id,sender_id:undefined}))};
        });return json(res,200,{connections:list});
      }
      const response=path.match(/^\/api\/connections\/([a-f0-9-]{36})\/respond$/);
      if(response && req.method==='POST') {
        const c=connectionFor(response[1],u), b=await body(req), action=clean(b.action,30);
        if(c.status!=='pending') fail(409,'This introduction has already been updated.');
        if(action==='withdrawn' && c.user_id!==u.id) fail(403,'Only the sender can withdraw this introduction.');
        if(['accepted','declined'].includes(action) && c.profile_id!==u.profile_id) fail(403,'Only the profile owner can respond.');
        if(!['accepted','declined','withdrawn'].includes(action)) fail(400,'Choose a valid response.');
        const changed=db.prepare("UPDATE connections SET status=?,updated_at=? WHERE id=? AND status='pending'").run(action,new Date().toISOString(),c.id);
        if(!changed.changes) fail(409,'This introduction has already been updated.');
        syncExport();log(req,res,'INTRODUCTION_UPDATED',{id:c.id,status:action});return json(res,200,{ok:true});
      }
      const messagePath=path.match(/^\/api\/connections\/([a-f0-9-]{36})\/messages$/);
      if(messagePath && req.method==='POST') {
        rate(`chat:${u.id}`,30,60000);
        const c=connectionFor(messagePath[1],u), b=await body(req), message=clean(b.message,1001);
        if(c.status!=='accepted') fail(403,'You can chat once your introduction is accepted.');
        if(!message || message.length>1000) fail(400,'Write a message of up to 1,000 characters.');
        db.prepare('INSERT INTO messages(connection_id,sender_id,text,created_at) VALUES(?,?,?,?)').run(c.id,u.id,message,new Date().toISOString());
        log(req,res,'MESSAGE_SENT',{connection:c.id});return json(res,201,{ok:true});
      }
      const blockPath=path.match(/^\/api\/connections\/([a-f0-9-]{36})\/block$/);
      if(blockPath && req.method==='POST') {
        const c=connectionFor(blockPath[1],u), other=c.user_id===u.id ? profileOwner(c.profile_id)?.id : c.user_id;
        if(other) db.prepare('INSERT OR IGNORE INTO blocks VALUES(?,?)').run(u.id,other);
        log(req,res,'MEMBER_BLOCKED',{connection:c.id});return json(res,200,{ok:true});
      }
      if(path==='/api/reports' && req.method==='POST') {
        rate(`report:${u.id}`,5,3600000);const b=await body(req), p=profileById(clean(b.profile,30)),reason=clean(b.reason,501);
        if(reason.length<10 || reason.length>500) fail(400,'Please describe the concern in 10–500 characters.');
        db.prepare('INSERT INTO reports(user_id,profile_id,reason,created_at) VALUES(?,?,?,?)').run(u.id,p.id,reason,new Date().toISOString());
        log(req,res,'PROFILE_REPORTED',{profile:p.name});return json(res,201,{ok:true});
      }
      if(path==='/api/owner/profile' && req.method==='PATCH') {
        if(!u.profile_id) fail(403,'Only a profile owner can edit this profile.');
        const b=await body(req),bio=clean(b.bio,501),prompt=clean(b.prompt,101);
        if(bio.length<10 || bio.length>500 || prompt.length<5 || prompt.length>100) fail(400,'Use a bio of 10–500 characters and a headline of 5–100 characters.');
        db.prepare('UPDATE profiles SET bio=?,prompt=? WHERE id=?').run(bio,prompt,u.profile_id);
        db.prepare("UPDATE profile_ratings SET status='pending' WHERE profile_id=?").run(u.profile_id);
        return json(res,200,{ok:true});
      }
      if(path==='/api/owner/profile' && req.method==='GET') {
        if(!u.profile_id) fail(403,'No profile is linked to your account.');
        return json(res,200,{profile:db.prepare('SELECT * FROM profiles WHERE id=?').get(u.profile_id)});
      }
      if(path==='/api/admin/members' && req.method==='GET') {
        requireAdmin(s);
        const query=new URL(req.url,origin).searchParams;
        const search=clean(query.get('search') || '',81),status=query.get('status') || 'all',requested=query.get('page') || '1';
        if(search.length>80 || !['all','active','suspended'].includes(status) || !/^[1-9]\d{0,5}$/.test(requested)) fail(400,'Check your search, status filter, and page.');
        const where="role='member' AND (?='all' OR suspended=?) AND (instr(lower(username),lower(?))>0 OR instr(lower(name),lower(?))>0 OR instr(whatsapp,?)>0)";
        const params=[status,status==='suspended'?1:0,search,search,search];
        const total=db.prepare(`SELECT count(*) AS n FROM users WHERE ${where}`).get(...params).n;
        const pageSize=20,pages=Math.max(1,Math.ceil(total/pageSize)),page=Math.min(Number(requested),pages);
        const members=db.prepare(`SELECT id,username,name,whatsapp,created_at,suspended,suspension_reason,suspended_at,
          (SELECT count(*) FROM connections c WHERE c.user_id=users.id) AS introductions
          FROM users WHERE ${where} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`).all(...params,pageSize,(page-1)*pageSize);
        const summary=db.prepare("SELECT count(*) AS total,coalesce(sum(suspended),0) AS suspended FROM users WHERE role='member'").get();
        const audit=db.prepare('SELECT actor_username,target_username,action,reason,created_at FROM admin_audit ORDER BY id DESC LIMIT 20').all();
        return json(res,200,{members,total,page,pageSize,pages,summary,audit});
      }
      const memberPath=path.match(/^\/api\/admin\/members\/([1-9]\d*)(?:\/(reset-pin))?$/);
      if(memberPath && req.method==='PATCH' && !memberPath[2]) {
        const actor=requireAdmin(s),member=managedMember(Number(memberPath[1])),b=await body(req),reason=adminReason(b.reason);
        if(typeof b.suspended!=='boolean') fail(400,'Choose suspend or reactivate.');
        requireAdmin(session(req,res));
        if(Boolean(member.suspended)===b.suspended) return json(res,200,{ok:true});
        memberChange(actor,member,b.suspended?'MEMBER_SUSPENDED':'MEMBER_REACTIVATED',reason,()=>{
          const updated=db.prepare("UPDATE users SET suspended=?,suspension_reason=?,suspended_at=? WHERE id=? AND role='member'")
            .run(b.suspended?1:0,b.suspended?reason:'',b.suspended?new Date().toISOString():null,member.id);
          if(!updated.changes) fail(404,'This member account is no longer available.');
          db.prepare('DELETE FROM sessions WHERE user_id=?').run(member.id);
        });
        log(req,res,b.suspended?'ADMIN_MEMBER_SUSPENDED':'ADMIN_MEMBER_REACTIVATED',{target:member.username});
        return json(res,200,{ok:true});
      }
      if(memberPath && req.method==='POST' && memberPath[2]==='reset-pin') {
        const actor=requireAdmin(s),member=managedMember(Number(memberPath[1])),b=await body(req),reason=adminReason(b.reason);
        if(!validPIN(b.adminPin)) fail(400,'Enter your own six-digit administrator PIN to confirm.');
        rate(`admin-pin-reset:${actor.id}`,10,3600000);
        credentialAttempt(actor.username);
        if(passwordWork>=4) fail(429,'Please try again in a moment.');
        passwordWork++;
        try {
          const administrator=db.prepare('SELECT password FROM users WHERE id=?').get(actor.id);
          if(!await checkPassword(b.adminPin,administrator.password)) fail(401,'Your administrator PIN is incorrect.');
          credentialSuccess(actor.username);
          const previous=db.prepare("SELECT password FROM users WHERE id=? AND role='member'").get(member.id);
          if(!previous) fail(404,'This member account is no longer available.');
          let pin=generatePIN();
          while(await checkPassword(pin,previous.password)) pin=generatePIN();
          const hashed=await hashPassword(pin);
          // Recheck the live session after asynchronous hashing before making the change.
          requireAdmin(session(req,res));
          memberChange(actor,member,'MEMBER_PIN_RESET',reason,()=>{
            const updated=db.prepare("UPDATE users SET password=?,auth_kind='pin' WHERE id=? AND role='member' AND password=?").run(hashed,member.id,previous.password);
            if(!updated.changes) fail(409,'This member’s sign-in details changed. Refresh the list and try again.');
            db.prepare('DELETE FROM sessions WHERE user_id=?').run(member.id);
            credentialSuccess(member.username);
          });
          log(req,res,'ADMIN_MEMBER_PIN_RESET',{target:member.username});
          return json(res,200,{username:member.username,pin});
        } finally {passwordWork--;}
      }
      if(path==='/api/admin/ratings' && req.method==='GET') {
        requireAdmin(s);return json(res,200,adminRatings(db,dataDir));
      }
      if(path==='/api/admin/ratings' && req.method==='PATCH') {
        requireAdmin(s);const b=await body(req);
        if(typeof b.enabled!=='boolean')fail(400,'Choose whether daily AI ratings are enabled.');
        const key=typeof b.apiKey==='string'?b.apiKey.trim():'';
        if(key && !/^sk-[A-Za-z0-9_-]{20,512}$/.test(key))fail(400,'Enter a valid OpenAI API key.');
        if(b.enabled && !key && !readRatingKey(dataDir))fail(400,'Add an OpenAI API key before enabling ratings.');
        const actor=await confirmAdministrator(req,res,s,b.adminPin);
        rate(`rating-settings:${actor.id}`,10,3600000);
        if(key)saveRatingKey(dataDir,key);
        db.prepare("UPDATE rating_settings SET enabled=?,last_error='',last_status=? WHERE id=1").run(b.enabled?1:0,b.enabled?'queued':'paused');
        if(b.enabled)queueRatings(dataDir);else rmSync(join(dataDir,'ratings.queue'),{force:true});
        db.prepare('INSERT INTO admin_audit(actor_id,actor_username,target_username,action,reason,created_at) VALUES(?,?,?,?,?,?)')
          .run(actor.id,actor.username,'AI ratings','AI_RATING_SETTINGS_CHANGED',b.enabled?'Enabled daily AI ratings.':'Paused AI rating checks.',new Date().toISOString());
        log(req,res,'AI_RATING_SETTINGS_CHANGED',{enabled:b.enabled});
        return json(res,200,adminRatings(db,dataDir));
      }
      if(path==='/api/admin/ratings/run' && req.method==='POST') {
        const actor=requireAdmin(s);
        if(!db.prepare('SELECT enabled FROM rating_settings WHERE id=1').get().enabled || !readRatingKey(dataDir))fail(400,'Configure and enable AI ratings first.');
        rate(`rating-run:${actor.id}`,3,3600000);
        queueRatings(dataDir);log(req,res,'AI_RATING_CHECK_REQUESTED',{});
        return json(res,202,{ok:true});
      }
      if(path==='/api/admin' && req.method==='GET') {
        requireAdmin(s);
        return json(res,200,{stats:{members:db.prepare("SELECT count(*) AS n FROM users WHERE role='member'").get().n,introductions:db.prepare('SELECT count(*) AS n FROM connections').get().n,connections:db.prepare("SELECT count(*) AS n FROM connections WHERE status='accepted'").get().n},profiles:db.prepare('SELECT * FROM profiles').all(),reports:db.prepare('SELECT r.*,p.name FROM reports r JOIN profiles p ON p.id=r.profile_id ORDER BY r.id DESC LIMIT 100').all(),ratings:adminRatings(db,dataDir)});
      }
      if(path==='/api/admin/export' && req.method==='GET') {
        requireAdmin(s);exportCSV();res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="fantasytales-connections.csv"'});return res.end(readFileSync(join(dataDir,'connections.csv')));
      }
      const publishPath=path.match(/^\/api\/admin\/profiles\/([a-z]+)$/);
      if(publishPath && req.method==='PATCH') {
        requireAdmin(s);const b=await body(req);
        db.prepare('UPDATE profiles SET published=? WHERE id=?').run(b.published===true ? 1 : 0,publishPath[1]);return json(res,200,{ok:true});
      }
      fail(404,'That page could not be found.');
    }
    if(req.method!=='GET' && req.method!=='HEAD') fail(405,'Method not allowed.');
    const media=path.match(/^\/media\/([a-z]+)\/((?:portrait|photo-\d{2})\.(?:jpg|png))$/);
    if(media) {
      const u=requireProfileAccess(requireUser(s));profileById(media[1]);
      if(isBlocked(u.id,profileOwner(media[1])?.id)) fail(404,'This photo is not available.');
      const file=join(mediaDir,media[1],media[2]);
      if(!existsSync(file)) fail(404,'This photo is not available.');
      rate(`media:${u.id}`,300,60000);res.setHeader('X-Robots-Tag','noindex, noimageindex, noarchive');
      res.setHeader('Content-Disposition','inline');return serveFile(res,file);
    }
    if(path==='/app') return serveFile(res,join(root,'public','app.html'));
    const publicPath=resolve(root,'public','.'+path);
    if(!publicPath.startsWith(resolve(root,'public')+'/') || !/^\/(app\.js|styles\.css|landing\.js|landing\.css|favicon\.svg|assets\/[a-zA-Z0-9_.-]+)$/.test(path) || !existsSync(publicPath)) fail(404,'That page could not be found.');
    res.setHeader('Cache-Control','public, max-age=3600');serveFile(res,publicPath);
  } catch(e) {
    if(!e.status) console.error(e);
    if(!res.headersSent) {res.setHeader('X-Robots-Tag','noindex, nofollow');json(res,e.status || 500,{error:e.status ? e.message : 'Something went wrong. Please try again.',...(e.status && e.code ? {code:e.code} : {})});}
    else res.end();
  }
});
server.requestTimeout=15000;server.headersTimeout=10000;
await metrics.start().catch(error=>console.error('Private metrics unavailable:',error.code || 'initialization failed'));
server.listen(Number(process.env.PORT || 3000),process.env.HOST || '127.0.0.1',()=>console.log(`Fantasy Tales ready at ${origin}`));
for(const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>server.close(async()=>{await metrics.close();db.close();process.exit(0);}));
