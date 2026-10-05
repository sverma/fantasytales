// Fictional profiles and a generated color pixel. No production people or photos.
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
export async function setupFixture(data) {
  const root=resolve(import.meta.dirname,'..');
  execFileSync(process.execPath,['--input-type=module','-e',"import {db} from './lib.mjs';db.close();"],{cwd:root,env:{...process.env,DATA_DIR:data},stdio:'pipe'});
  const db=new DatabaseSync(join(data,'fantasytales.sqlite'));
  const media=join(data,'media');
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
  for(const [id,name,count] of [['alex','Alex',6],['blair','Blair',9],['casey','Casey',10],['drew','Drew',9],['admin','Admin',1],['eden','Eden',2],['frankie','Frankie',4]]) {
    db.prepare('INSERT INTO profiles(id,name,bio,prompt) VALUES(?,?,?,?)').run(id,name,'A fictional adult profile used only for automated testing.','A synthetic test introduction.');
    const folder=join(media,id);mkdirSync(folder,{recursive:true});
    for(let i=0;i<count;i++)writeFileSync(join(folder,(i?'photo-'+String(i+1).padStart(2,'0'):'portrait')+'.png'),png);
  }
  db.close();return media;
}
