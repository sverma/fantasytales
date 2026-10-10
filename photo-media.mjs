import {createHash,randomUUID} from 'node:crypto';
import {lstatSync,readFileSync,existsSync,readdirSync,statSync,rmSync,mkdirSync} from 'node:fs';
import {readFile,writeFile,rename,rm} from 'node:fs/promises';
import {join} from 'node:path';
import sharp from 'sharp';

export const PHOTO_WIDTHS=[128,480,960,1440];
const pattern=/^\/media\/([a-z]+)\/((?:portrait|photo-\d{2})\.(?:jpg|png))\/([a-f0-9]{32})-(128|480|960|1440)\.webp$/;
const recipe='webp-v1-auto-orient-q78-thumb72-full82';
const failure=(status,message)=>Object.assign(new Error(message),{status});
sharp.concurrency(1);
sharp.cache({memory:32,files:0,items:64});

export function createPhotoStore({mediaDir,cacheDir}) {
  const fingerprints=new Map(),pending=new Map();let queue=Promise.resolve();
  function source(profile,name) {
    if(!/^[a-z]+$/.test(profile)||!/^(portrait|photo-\d{2})\.(jpg|png)$/.test(name))throw failure(404,'This photo is not available.');
    const folder=join(mediaDir,profile),file=join(folder,name);
    let stat;
    try{if(!lstatSync(folder).isDirectory())throw failure(404,'This photo is not available.');stat=lstatSync(file,{bigint:true});}
    catch(e){if(e.code==='ENOENT'||e.code==='ENOTDIR')throw failure(404,'This photo is not available.');throw e;}
    if(!stat.isFile()||stat.size>10n*1024n*1024n)throw failure(404,'This photo is not available.');
    const fingerprint=[stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].join(':');
    let saved=fingerprints.get(file);
    if(!saved||saved.fingerprint!==fingerprint){
      const revision=createHash('sha256').update(recipe).update(readFileSync(file)).digest('hex').slice(0,32);
      saved={fingerprint,revision};fingerprints.delete(file);fingerprints.set(file,saved);
      if(fingerprints.size>1000)fingerprints.delete(fingerprints.keys().next().value);
    }
    return {profile,name,file,...saved};
  }
  async function descriptor(profile,name) {
    const original=`/media/${profile}/${name}`;
    try{
      const item=source(profile,name),base=original+'/'+item.revision,saved=fingerprints.get(item.file);
      saved.metadata ||= sharp(item.file,{limitInputPixels:25000000}).metadata();
      const meta=await saved.metadata;
      const width=[5,6,7,8].includes(meta.orientation)?meta.height:meta.width;
      if(!width)throw new Error('Invalid photo dimensions.');
      return {thumbnail:base+'-128.webp',card:base+'-480.webp',card2x:base+'-960.webp',full:base+'-1440.webp',widths:PHOTO_WIDTHS.map(size=>Math.min(size,width))};
    }catch{return {thumbnail:original,card:original,card2x:original,full:original};}
  }
  function resolve(path) {
    const match=pattern.exec(path);if(!match)throw failure(404,'This photo is not available.');
    const [,profile,name,revision,size]=match,item=source(profile,name);
    if(item.revision!==revision)throw failure(404,'This photo has changed. Refresh the profile.');
    return {...item,width:Number(size),output:join(cacheDir,profile,name,`${revision}-${size}.webp`)};
  }
  async function image(path) {
    const item=resolve(path);
    if(existsSync(item.output))return readFile(item.output);
    if(pending.has(item.output))return pending.get(item.output);
    if(pending.size>=32)throw failure(503,'Photos are being prepared. Please try again shortly.');
    const job=queue.catch(()=>{}).then(async()=>{
      resolve(path);
      if(existsSync(item.output))return readFile(item.output);
      const bytes=await sharp(item.file,{limitInputPixels:25000000,failOn:'error'})
        .rotate().resize({width:item.width,withoutEnlargement:true})
        .webp({quality:item.width===128?72:item.width===1440?82:78,effort:4}).toBuffer();
      resolve(path); // Never publish output of a replaced or deleted original.
      const folder=join(cacheDir,item.profile,item.name);mkdirSync(folder,{recursive:true,mode:0o700});
      const temporary=item.output+'.'+randomUUID()+'.tmp';
      try{await writeFile(temporary,bytes,{mode:0o600,flag:'wx'});await rename(temporary,item.output);}
      finally{await rm(temporary,{force:true});}
      return bytes;
    });
    queue=job;pending.set(item.output,job);
    try{return await job;}finally{pending.delete(item.output);}
  }
  // These are regenerable private files, never originals. Called at startup/hourly.
  function prune({now=Date.now(),maxBytes=256*1024*1024,maxAge=7*86400000}={}) {
    if(!existsSync(cacheDir))return;
    const files=[];
    for(const profile of readdirSync(cacheDir,{withFileTypes:true}))if(profile.isDirectory()&&/^[a-z]+$/.test(profile.name))
      for(const original of readdirSync(join(cacheDir,profile.name),{withFileTypes:true}))if(original.isDirectory()&&/^(portrait|photo-\d{2})\.(jpg|png)$/.test(original.name))
        for(const entry of readdirSync(join(cacheDir,profile.name,original.name),{withFileTypes:true}))if(entry.isFile()&&/^[a-f0-9]{32}-(128|480|960|1440)\.webp(?:\.[a-f0-9-]+\.tmp)?$/.test(entry.name)){
          const file=join(cacheDir,profile.name,original.name,entry.name),stat=statSync(file);files.push({file,size:stat.size,time:stat.mtimeMs});
        }
    let total=files.reduce((n,f)=>n+f.size,0);
    for(const file of files.sort((a,b)=>a.time-b.time))if(now-file.time>maxAge||total>maxBytes){rmSync(file.file,{force:true});total-=file.size;}
  }
  return {descriptor,resolve,image,prune};
}
