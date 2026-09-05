import { describe, expect, it } from 'vitest';
import { observeInterior, composeInterior, type SensorInput } from '../../packages/alg/src/stages/S3/exp/interior-core';
import { stageContract } from '../../packages/alg/src/stages/S3/exp/interior-core/contract';
import { groupBrightDarkComponentFields } from '../../packages/alg/src/detectors/threeFactor/componentField';
import { createExecBoard } from '../../packages/alg/src/exec/board';
import { ComponentPxC } from '../../packages/alg/src/stages/componentPxC';
import { BadgePxC } from '../../packages/alg/src/stages/S1/clean/Badge';
import { BasketPxC } from '../../packages/alg/src/stages/S2/clean/Basket';
import type { Basket } from '../../packages/alg/src/stages/S2/clean/Basket';
import type { Tee } from '../../packages/alg/src/stages/S3/clean/Tee';

function fixture({ noise = false, narrow = false, wide = false } = {}): SensorInput {
  const width = 72, height = 64;
  const rgba = new Uint8ClampedArray(width*height*4);
  for(let p=0;p<width*height;p++) rgba.set([52,78,63,255],p*4);
  const pad=(x:number,y:number,w:number,h:number,broken=false)=>{
    for(let py=y-2;py<y+h+2;py++) for(let px=x-2;px<x+w+2;px++) rgba.set([250,250,250,255],(py*width+px)*4);
    for(let py=y;py<y+h;py++) for(let px=x;px<x+w;px++) {
      const color=broken?((px+py)%2?[151,151,151]:[164,164,164]):[157,158,159];
      rgba.set([...color,255],(py*width+px)*4);
    }
  };
  pad(8,8,8,14);
  pad(40,26,narrow?2:wide?20:10,narrow?4:wide?6:18,noise);
  const bright=new Uint8Array(width*height),dark=new Uint8Array(width*height);
  for(let p=0;p<bright.length;p++) if(rgba[p*4]>=240) bright[p]=1;
  const fields=groupBrightDarkComponentFields({bright:{width,height,data:bright},dark:{width,height,data:dark}});
  const baseline={center:[11.5,14.5],innerBbox:[8,8,8,14],bbox:[6,6,12,18],angleRad:Math.PI/2,px:Uint32Array.from([]),has:{fixture:'SYNTHETIC'}} as unknown as Tee;
  return {image:{imageId:'synthetic',widthPx:width,heightPx:height,rgba},fields,tees:[baseline],badges:[],baskets:[]};
}

describe('isolated interior-core challenger',()=>{
  it('adds a white-supported uniform interior without requiring common frame dimensions',()=>{
    const input=fixture({wide:true});const obs=observeInterior(input);const tees=composeInterior({tees:input.tees,observation:obs});
    expect(tees).toHaveLength(2);
    expect(tees).toContain(input.tees[0]);
    expect(obs.candidates.filter(c=>c.accepted&&!c.overlapsBaseline)).toHaveLength(1);
  });
  it('does not confuse merely similar colors with a uniform renderer core',()=>{
    const input=fixture({noise:true});const obs=observeInterior(input);
    const target=obs.candidates.find(c=>c.component.cx>35)!;
    expect(target.pixels.length).toBeGreaterThan(8);
    expect(target.uniformCorePixels).toBe(0);
    expect(target.accepted).toBe(false);
    expect(composeInterior({tees:input.tees,observation:obs})).toHaveLength(1);
  });
  it('retains eight weak pixels for later composed recovery instead of discarding them',()=>{
    const input=fixture({narrow:true}); const obs=observeInterior(input);
    const target=obs.candidates.find(c=>c.component.cx>35)!;
    expect(target.pixels).toHaveLength(8);
    expect(target.accepted).toBe(false);
    expect(target.reason).toContain('RETAINED');
  });
  it('keeps observed fill separate from unclaimed white support and unknown complete pose',()=>{
    const input=fixture();const obs=observeInterior(input);const tee=composeInterior({tees:input.tees,observation:obs}).find(t=>'interior' in t.has)!;
    expect('interior' in tee.has).toBe(true);
    if(!('interior' in tee.has)) throw new Error('missing experimental testimony');
    expect(tee.has.visibility).toBe('PARTIALLY_OBSERVED');
    expect(tee.has.localization).toBe('OBSERVED_INTERIOR_CENTROID_NOT_COMPLETE_POSE');
    expect(tee.has.whiteSupport.ownership).toBe('SUPPORT_NOT_CLAIMED');
    const owned=new Set(tee.px);
    expect(Array.from(tee.has.whiteSupport.px).some(p=>owned.has(p))).toBe(false);
  });
  it('uses exact Basket ownership, not its enclosing bounding box',()=>{
    const input=fixture();const before=new Uint8ClampedArray(input.image.rgba);
    const owned=30*input.image.widthPx+44;
    const basket={bbox:[35,20,30,35],px:Uint32Array.of(owned)} as unknown as Basket;
    const obs=observeInterior({...input,baskets:[basket]});
    const target=obs.candidates.find(c=>c.component.cx>35)!;
    expect(target.pixels).toHaveLength(179);
    expect(target.pixels.includes(owned)).toBe(false);
    expect(target.accepted).toBe(true);
    expect(input.image.rgba).toEqual(before);
  });
  it('does not fabricate a prototype or a Tee when no upstream samples exist',()=>{
    const input=fixture();const obs=observeInterior({...input,tees:[]});
    expect(obs.prototype).toBeNull();expect(obs.candidates).toEqual([]);
  });
  it('exposes real Ticks and keeps the clean Tee address separate from challenger objects',async()=>{
    const input=fixture(),pxc=createExecBoard();
    pxc.set(ComponentPxC.image,input.image); pxc.set(ComponentPxC.fields,input.fields);
    pxc.set(BadgePxC.objects,[]);pxc.set(BasketPxC.objects,[]);
    const before=new Uint8ClampedArray(input.image.rgba);
    const result=await stageContract.execute({source:'synthetic',inputLabel:'synthetic',pxc,decode:async()=>{throw new Error('unexpected decode');}});
    expect(result.pxc.has('px.tees')).toBe(true);
    expect(result.pxc.has('px.tees.exp.objects')).toBe(true);
    expect(result.pxc.get('px.tees')).not.toBe(result.pxc.get('px.tees.exp.objects'));
    expect(JSON.stringify(result.pxc.get('px.tees.exp.pcr'))).toContain('Tee.exp.interiorCore');
    expect(result.pxc.get(ComponentPxC.image).rgba).toEqual(before);
  });
});
