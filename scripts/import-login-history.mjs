// One-time, idempotent recovery of successful logins from retained visit logs.
import {readdirSync,readFileSync,lstatSync,realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {initActivity,recordAuthentication,pruneAuthentication,LOGIN_RETENTION_DAYS} from '../activity.mjs';

export function importLoginHistory(db,dataDir,{now=Date.now()}={}) {
  initActivity(db);
  const cutoff=new Date(now-LOGIN_RETENTION_DAYS*86400000).toISOString(),directory=join(dataDir,'visits');
  const users=new Map(db.prepare('SELECT id,username,created_at FROM users').all().map(u=>[u.id,u]));
  let imported=0,files=0,skippedFiles=0;
  let days;try{days=readdirSync(directory);}catch(e){if(e.code==='ENOENT')return {imported,files,skippedFiles};throw e;}
  db.exec('BEGIN IMMEDIATE');
  try {
    for(const day of days.sort()) {
      if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||day<cutoff.slice(0,10)||day>new Date(now).toISOString().slice(0,10))continue;
      const folder=join(directory,day),stat=lstatSync(folder);if(stat.isSymbolicLink()||!stat.isDirectory())continue;
      for(const name of readdirSync(folder).sort()) {
        if(!name.endsWith('.txt'))continue;
        const path=join(folder,name),stat=lstatSync(path);
        if(stat.isSymbolicLink()||!stat.isFile()||stat.size>5*1024*1024){skippedFiles++;continue;}
        files++;
        for(const line of readFileSync(path,'utf8').split('\n')) {
          const match=line.match(/^(\S+) (ACCOUNT_CREATED|SIGNED_IN) (\{.*\})$/);if(!match)continue;
          let details;try{details=JSON.parse(match[3]);}catch{continue;}
          const user=users.get(details?.userId),time=Date.parse(match[1]);
          if(!user||details.username!==user.username||!Number.isFinite(time)||time>now||time<Date.parse(user.created_at))continue;
          const at=new Date(time).toISOString();if(at<cutoff)continue;
          const before=db.prepare('SELECT total_changes() AS n').get().n;
          recordAuthentication(db,user.id,match[2]==='ACCOUNT_CREATED'?'signup':'login',at);
          imported+=db.prepare('SELECT total_changes() AS n').get().n-before;
        }
      }
    }
    pruneAuthentication(db,now);db.exec('COMMIT');return {imported,files,skippedFiles};
  }catch(e){db.exec('ROLLBACK');throw e;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href) {
  const dataDir=resolve(process.env.DATA_DIR||'./data'),db=new DatabaseSync(join(dataDir,'fantasytales.sqlite'));
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  try{console.log(JSON.stringify(importLoginHistory(db,dataDir)));}finally{db.close();}
}
