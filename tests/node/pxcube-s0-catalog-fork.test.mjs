import assert from 'node:assert/strict';
import test from 'node:test';
import { createS0Stage, forkS0Crop, S0_FULL_IMAGE_ADDRESS, S0_CROPPED_IMAGE_ADDRESS } from '../../packages/alg/dist/stages/S0/clean/index.js';

const image={imageId:'full',widthPx:2,heightPx:2,rgba:new Uint8ClampedArray(16)};
const composite=(id,w,h)=>({imageId:id,widthPx:w,heightPx:h,rgba:new Uint8ClampedArray(w*h*4)});

test('S0 keeps clean and speculative canonicalPixels editions together',async()=>{
 const stage=createS0Stage();
 stage.pxc.set(S0_FULL_IMAGE_ADDRESS,image);
 stage.pxc.set(S0_CROPPED_IMAGE_ADDRESS,composite('clean',2,2));
 const run=await forkS0Crop(stage,'exp/tighter-crop',async()=>composite('candidate',2,1));
 assert.equal(stage.pxc.get(S0_CROPPED_IMAGE_ADDRESS).imageId,'clean');
 assert.equal(run.pxc.get(S0_CROPPED_IMAGE_ADDRESS).imageId,'candidate');
 const editions=stage.pxc.catalog.editions(S0_CROPPED_IMAGE_ADDRESS);
 assert.deepEqual(editions.map(e=>[e.lineage,e.value.imageId]),[['clean','clean'],['exp/tighter-crop','candidate']]);
 assert.equal(run.testimony.lineage,'exp/tighter-crop');
 assert.equal(run.testimony.resolution,'EXECUTE');
});
