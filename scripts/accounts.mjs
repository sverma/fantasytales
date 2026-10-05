import {db,hashPassword,generatePIN,hashToken,dataDir} from '../lib.mjs';
import {mkdirSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';

const [action,username]=process.argv.slice(2);
try {
  if(action==='seed') {
    const admin=process.env.ADMIN_USERNAME || 'site-admin';
    if(!/^[a-z0-9][a-z0-9_.-]{2,31}$/.test(admin))throw new Error('Invalid ADMIN_USERNAME.');
    const profiles=db.prepare('SELECT id,name FROM profiles ORDER BY rowid').all();
    const accounts=[[admin,'Community administrator','admin',profiles.some(p=>p.id==='admin')?'admin':null],
      ...profiles.filter(p=>p.id!=='admin').map(p=>[p.id,p.name,'owner',p.id])];
    const pending=accounts.filter(([handle,,,profile])=>!db.prepare('SELECT id FROM users WHERE username=? OR (? IS NOT NULL AND profile_id=?)').get(handle,profile,profile));
    const output=resolve(process.env.CREDENTIALS_FILE || join(dataDir,'initial-credentials.txt'));
    if(pending.length && existsSync(output))throw new Error('Credential output already exists. Choose a new private CREDENTIALS_FILE; existing credentials are never overwritten.');
    const created=[];
    for(const [handle,name,role,profile] of pending) {
      const pin=generatePIN(),now=new Date().toISOString();
      db.prepare("INSERT INTO users(username,password,auth_kind,name,contact_done,role,profile_id,created_at,consent_at) VALUES(?,?,'pin',?,0,?,?,?,?)").run(handle,await hashPassword(pin),name,role,profile,now,now);
      created.push(`${role.toUpperCase()}\nUsername: ${handle}\nPIN: ${pin}\n`);
    }
    if(created.length) {
      mkdirSync(dirname(output),{recursive:true,mode:0o700});
      writeFileSync(output,`FANTASY TALES — PRIVATE ACCOUNT HANDOFF\nChange each PIN before sharing access. Distribute owner logins only to their owners.\n\n${created.join('\n')}`,{mode:0o600,flag:'wx'});
      console.log(`Created ${created.length} accounts. Credentials saved privately to ${output}.`);
    } else console.log('All requested accounts already exist.');
  } else if(action==='reset' && username) {
    const user=db.prepare('SELECT id FROM users WHERE username=?').get(username);
    if(!user)throw new Error('Username not found.');
    const pin=generatePIN();
    db.prepare("UPDATE users SET password=?,auth_kind='pin' WHERE id=?").run(await hashPassword(pin),user.id);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
    db.prepare('DELETE FROM rate_limits WHERE key IN (?,?)').run(`credential:${hashToken(username)}`,`credential-day:${hashToken(username)}`);
    process.stdout.write(`Temporary PIN for ${username}: ${pin}\n`);
  } else {console.error('Usage: node scripts/accounts.mjs seed | reset USERNAME');process.exitCode=1;}
} finally {db.close();}
