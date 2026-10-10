import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {createPhotoStore} from '../photo-media.mjs';

test('display variants preserve originals, orientation, privacy, and current revisions',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ft-photos-unit-')),mediaDir=join(dir,'media'),cacheDir=join(dir,'cache');mkdirSync(join(mediaDir,'fixture'),{recursive:true});
 try{
  const original=await sharp({create:{width:1200,height:800,channels:3,background:'#975862'}}).withMetadata({orientation:6,exif:{IFD0:{Artist:'Private fixture metadata'}}}).jpeg().toBuffer();
  const file=join(mediaDir,'fixture','portrait.jpg');writeFileSync(file,original);
  const store=createPhotoStore({mediaDir,cacheDir}),v=await store.descriptor('fixture','portrait.jpg');
  const buffers=await Promise.all(Array.from({length:8},()=>store.image(v.card)));
  assert.ok(buffers.every(b=>b.equals(buffers[0])));assert.deepEqual(readFileSync(file),original);
  const meta=await sharp(buffers[0]).metadata();assert.equal(meta.width,480);assert.equal(meta.height,720);assert.equal(meta.format,'webp');assert.equal(meta.exif,undefined);assert.equal(meta.orientation,undefined);
  assert.equal(readdirSync(join(cacheDir,'fixture','portrait.jpg')).length,1,'Concurrent requests share one conversion');
  const thumb=await sharp(await store.image(v.thumbnail)).metadata();assert.equal(thumb.width,128);assert.equal(thumb.height,192);
  const full=await sharp(await store.image(v.full)).metadata();assert.equal(full.width,800);assert.equal(full.height,1200,'No enlargement');
  for(const invalid of [v.card.replace('-480','-999'),v.card.replace('fixture','../fixture'),v.card.replace('.webp','.jpg'),v.card+'?extra=1'])assert.throws(()=>store.resolve(invalid));
  writeFileSync(file,await sharp({create:{width:1200,height:800,channels:3,background:'#325678'}}).jpeg().toBuffer());
  const next=await store.descriptor('fixture','portrait.jpg');assert.notEqual(v.card,next.card);assert.throws(()=>store.resolve(v.card),e=>e.status===404);
  const preserved=readFileSync(file);store.prune({maxBytes:0});assert.equal(readdirSync(join(cacheDir,'fixture','portrait.jpg')).length,0);assert.deepEqual(readFileSync(file),preserved);
  assert.ok((await store.image(next.card)).length>0);
  rmSync(file);assert.throws(()=>store.resolve(next.card),e=>e.status===404);
  const outside=join(dir,'outside.jpg');writeFileSync(outside,original);symlinkSync(outside,file);assert.throws(()=>store.resolve(next.card),e=>e.status===404);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
