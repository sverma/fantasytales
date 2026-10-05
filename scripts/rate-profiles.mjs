import {randomUUID} from 'node:crypto';
import {rmSync,realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {profileSnapshot,assessProfile,readRatingKey,RATING_MODEL,DAILY_RATING_LIMIT} from '../ratings.mjs';

export async function runRatings(db,{dataDir,mediaDir,assess=assessProfile,now=()=>new Date()}={}) {
  const owner=randomUUID(),started=now(),clock=started.getTime();
  const claimed=db.prepare('UPDATE rating_settings SET lease_owner=?,lease_until=? WHERE id=1 AND lease_until<=?').run(owner,clock+20*60000,clock);
  if(!claimed.changes){
    // Consume duplicate requests even after a crashed worker left its lease.
    // Otherwise PathExists can repeatedly start the service until systemd
    // disables its watcher. The daily timer remains the recovery backstop.
    rmSync(join(dataDir,'ratings.queue'),{force:true});
    return {status:'already_running'};
  }
  let status='completed',message='',scored=0,skipped=0,failed=0;
  try {
    rmSync(join(dataDir,'ratings.queue'),{force:true});
    db.prepare("UPDATE rating_settings SET last_started=?,last_status='running',last_error='' WHERE id=1").run(started.toISOString());
    if(!db.prepare('SELECT enabled FROM rating_settings WHERE id=1').get().enabled){status='paused';return {status};}
    const key=readRatingKey(dataDir);
    if(!key){status='not_configured';message='Add an OpenAI API key in Admin → AI ratings.';return {status};}
    const profiles=db.prepare('SELECT id,bio,prompt FROM profiles WHERE published=1 ORDER BY rowid').all();
    for(const profile of profiles) {
      if(now().getTime()-clock>12*60000){status='partial';message='The run reached its time limit; remaining profiles will be checked on the next run.';break;}
      if(!db.prepare('SELECT enabled FROM rating_settings WHERE id=1').get().enabled){status='paused';break;}
      const attempted=now().toISOString();
      try {
        const snapshot=profileSnapshot(profile,mediaDir);
        const previous=db.prepare('SELECT * FROM profile_ratings WHERE profile_id=?').get(profile.id);
        if(previous?.content_hash===snapshot.hash && (previous.score!==null || previous.status==='unavailable')) {
          if(previous.score!==null)db.prepare("UPDATE profile_ratings SET status='ready',last_error='' WHERE profile_id=?").run(profile.id);
          skipped++;continue;
        }
        const day=attempted.slice(0,10);
        db.prepare("UPDATE rating_settings SET request_count=0,request_day=? WHERE id=1 AND request_day<>?").run(day,day);
        if(!db.prepare('UPDATE rating_settings SET request_count=request_count+1 WHERE id=1 AND request_count<?').run(DAILY_RATING_LIMIT).changes){status='daily_limit';message='Daily scoring limit reached. Remaining profiles will be checked tomorrow.';break;}
        const assessment=await assess(snapshot,key);
        // A text edit, photo replacement, privacy change, or pause during the API
        // request must not publish an assessment against the wrong profile state.
        const current=db.prepare('SELECT id,bio,prompt,published FROM profiles WHERE id=?').get(profile.id);
        if(!current?.published || !db.prepare('SELECT enabled FROM rating_settings WHERE id=1').get().enabled || profileSnapshot(current,mediaDir).hash!==snapshot.hash){skipped++;continue;}
        if(!assessment) {
          db.prepare(`INSERT INTO profile_ratings(profile_id,content_hash,status,last_error,attempted_at,model) VALUES(?,?,'unavailable',?,?,?)
            ON CONFLICT(profile_id) DO UPDATE SET content_hash=CASE WHEN profile_ratings.score IS NULL THEN excluded.content_hash ELSE profile_ratings.content_hash END,
            status='unavailable',last_error=excluded.last_error,attempted_at=excluded.attempted_at`)
            .run(profile.id,snapshot.hash,'AI could not assess this profile. Any previous score has been kept.',attempted,RATING_MODEL);
          failed++;continue;
        }
        const {score,quality,attractiveness}=assessment,at=now().toISOString();
        if([score,quality,attractiveness].some(x=>typeof x!=='number'||!Number.isFinite(x)||x<1||x>5))throw new Error('The assessment contained an invalid score.');
        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare(`INSERT INTO profile_ratings(profile_id,content_hash,score,quality,attractiveness,assessed_at,status,last_error,attempted_at,model)
            VALUES(?,?,?,?,?,?,'ready','',?,?) ON CONFLICT(profile_id) DO UPDATE SET content_hash=excluded.content_hash,
            score=excluded.score,quality=excluded.quality,attractiveness=excluded.attractiveness,assessed_at=excluded.assessed_at,
            status='ready',last_error='',attempted_at=excluded.attempted_at,model=excluded.model`)
            .run(profile.id,snapshot.hash,score,quality,attractiveness,at,attempted,RATING_MODEL);
          db.prepare('INSERT INTO rating_history(profile_id,score,quality,attractiveness,content_hash,assessed_at,model) VALUES(?,?,?,?,?,?,?)').run(profile.id,score,quality,attractiveness,snapshot.hash,at,RATING_MODEL);
          db.prepare('DELETE FROM rating_history WHERE profile_id=? AND id NOT IN(SELECT id FROM rating_history WHERE profile_id=? ORDER BY id DESC LIMIT 30)').run(profile.id,profile.id);
          db.exec('COMMIT');
        }catch(error){db.exec('ROLLBACK');throw error;}
        scored++;
      }catch(error) {
        const safe=error.message.startsWith('OpenAI ') || error.message.startsWith('Scoring requires') || error.message.startsWith('Profile photos exceed') || error.message.startsWith('Each profile photo')?error.message:'This profile could not be assessed. Check its photos and try again.';
        db.prepare(`INSERT INTO profile_ratings(profile_id,status,last_error,attempted_at) VALUES(?,'error',?,?)
          ON CONFLICT(profile_id) DO UPDATE SET status='error',last_error=excluded.last_error,attempted_at=excluded.attempted_at`).run(profile.id,safe,attempted);
        failed++;message=safe;
        if(error.stopBatch){status='error';break;}
      }
    }
    if(failed && status==='completed')status='partial';
    return {status,scored,skipped,failed};
  }catch(error){status='error';message='The rating check could not complete. Review the worker service and API settings.';throw error;}
  finally {
    db.prepare('UPDATE rating_settings SET last_finished=?,last_status=?,last_error=?,lease_owner=NULL,lease_until=0 WHERE id=1 AND lease_owner=?')
      .run(now().toISOString(),status,message,owner);
  }
}

if(process.argv[1] && import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href) {
  const {db,dataDir}=await import('../lib.mjs');
  try {console.log(JSON.stringify(await runRatings(db,{dataDir,mediaDir:process.env.RATING_MEDIA_DIR || process.env.MEDIA_DIR || resolve(import.meta.dirname,'../private/media')})));}
  catch {console.error('Rating worker failed. Check its configuration and private data directory.');process.exitCode=1;}
  finally {db.close();}
}
