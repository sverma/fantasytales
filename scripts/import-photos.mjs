import {db} from '../lib.mjs';
import {readFileSync,copyFileSync,mkdirSync,readdirSync,existsSync,rmSync,renameSync,mkdtempSync,statSync} from 'node:fs';
import {join,resolve,dirname,basename} from 'node:path';

// Trusted operator input; manifests and actual photos stay outside Git.
try {
  if(!process.argv[2])throw new Error('Usage: node scripts/import-photos.mjs /private/path/profiles.json');
  const manifest=resolve(process.argv[2]),items=JSON.parse(readFileSync(manifest,'utf8'));
  if(!Array.isArray(items)||!items.length)throw new Error('Provide a nonempty profile array.');
  const media=resolve(process.env.MEDIA_DIR || new URL('../private/media',import.meta.url).pathname);
  mkdirSync(media,{recursive:true,mode:0o700});
  for(const item of items) {
    if(!/^[a-z]{3,32}$/.test(item.id)||item.adultConsent!==true)throw new Error('Each profile needs a lowercase ID and confirmed adult/photo consent.');
    for(const [key,min,max] of [['name',2,60],['bio',10,500],['prompt',5,100]])if(typeof item[key]!=='string'||item[key].length<min||item[key].length>max)throw new Error(`Invalid ${key} for profile ${item.id}.`);
    const source=resolve(dirname(manifest),item.directory),cover=item.cover;
    if(typeof cover!=='string'||basename(cover)!==cover)throw new Error('Cover must be a filename within the source directory.');
    const photos=readdirSync(source).filter(name=>/\.(jpe?g|png)$/i.test(name)&&!(item.exclude||[]).includes(name)).sort();
    if(!photos.includes(cover)||photos.length>40)throw new Error('Choose an existing cover and at most 40 photos per profile.');
    const ordered=[cover,...photos.filter(name=>name!==cover)],staging=mkdtempSync(join(media,'.import-'));
    try {
      for(const [index,name] of ordered.entries()) {
        const file=join(source,name),bytes=readFileSync(file),png=name.toLowerCase().endsWith('.png');
        if(statSync(file).size>10*1024*1024||!(png?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):bytes[0]===255&&bytes[1]===216))throw new Error('Only valid PNG/JPEG images up to 10 MB are supported.');
        copyFileSync(file,join(staging,(index===0?'portrait':`photo-${String(index+1).padStart(2,'0')}`)+(png?'.png':'.jpg')));
      }
      const target=join(media,item.id),previous=target+'.previous';
      if(existsSync(previous))throw new Error('Previous import backup exists; review it before importing again.');
      if(existsSync(target))renameSync(target,previous);
      try {
        renameSync(staging,target);
        db.prepare('INSERT INTO profiles(id,name,bio,prompt) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,bio=excluded.bio,prompt=excluded.prompt').run(item.id,item.name,item.bio,item.prompt);
      } catch(error) {
        if(existsSync(target))rmSync(target,{recursive:true,force:true});
        if(existsSync(previous))renameSync(previous,target);
        throw error;
      }
      console.log(`Imported ${ordered.length} photos for ${item.id}. Any previous gallery is retained privately as ${previous}.`);
    } finally {if(existsSync(staging))rmSync(staging,{recursive:true,force:true});}
  }
} finally {db.close();}
