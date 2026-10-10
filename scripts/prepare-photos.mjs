// Generate private display copies without modifying originals or profile ratings.
import {readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createPhotoStore,PHOTO_WIDTHS} from '../photo-media.mjs';
const mediaDir=resolve(process.env.MEDIA_DIR||new URL('../private/media',import.meta.url).pathname);
const cacheDir=join(resolve(process.env.DATA_DIR||'./data'),'photo-variants');
const store=createPhotoStore({mediaDir,cacheDir});let photos=0,bytes=0;
for(const directory of readdirSync(mediaDir,{withFileTypes:true}))if(directory.isDirectory()&&/^[a-z]+$/.test(directory.name)) {
  for(const file of readdirSync(join(mediaDir,directory.name)))if(/^(portrait|photo-\d{2})\.(jpg|png)$/.test(file)){
    const variants=await store.descriptor(directory.name,file);
    for(const [index,url] of [variants.thumbnail,variants.card,variants.card2x,variants.full].entries()){
      if(!url.endsWith(`-${PHOTO_WIDTHS[index]}.webp`))throw new Error('An original photo is unavailable.');
      bytes+=(await store.image(url)).length;
    }
    photos++;
  }
}
store.prune();console.log(JSON.stringify({photos,variants:photos*PHOTO_WIDTHS.length,bytes}));
