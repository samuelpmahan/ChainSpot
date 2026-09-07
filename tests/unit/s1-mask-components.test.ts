import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { createExecBoard } from '../../packages/alg/src/exec/board';
import { readPql, invokePql } from '../../packages/alg/src/exec/pql';
import { S0_CROPPED_IMAGE_ADDRESS } from '../../packages/alg/src/stages/S0/clean';
import { MaskComponentsPxC, prepareMaskComponentsExp } from '../../packages/alg/src/stages/S1/exp/mask-components';
it('runs the mask prefix from the Stage YAML and preserves exact pixel membership', () => {
 const pxc=createExecBoard();
 const colors=[0,255,0,0,255,100,100,100,0];
 pxc.set(S0_CROPPED_IMAGE_ADDRESS,{widthPx:3,heightPx:3,rgba:new Uint8ClampedArray(colors.flatMap(v=>[v,v,v,255]))});
 prepareMaskComponentsExp(pxc);
 const full=readPql(readFileSync('packages/alg/src/stages/S1/exp/badge-assembly/PrincipleComponentRender.yaml','utf8'));
 const run=invokePql({...full,Ticks:full.Ticks.slice(0,2)},{pxc});
 expect(run.Ticks.map(t=>t.Calculations.length)).toEqual([2,2]);
 for(const tick of run.Ticks)expect(tick.Calculations[1].inputs.mask).toBe(tick.Calculations[0].output);
 expect(pxc.get(MaskComponentsPxC.blackComponents).components.map(p=>[...p.pixels])).toEqual([[0,3],[2],[8]]);
 expect(pxc.get(MaskComponentsPxC.whiteComponents).components.map(p=>[...p.pixels])).toEqual([[1,4]]);
});
