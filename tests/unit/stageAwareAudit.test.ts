import { describe, expect, test } from 'vitest';
import { alignTruth, exactCropOffset, judgeVisibleTees, matchObjects, type Target } from '../../scripts/chainspot-lab/sweep/stageAudit';
const target = (number: number, visibility: Target['visibility'] = 'VISIBLE'): Target => ({number, visibility, tee:[number*20,0], basket:[number*20,100], bends:[], width:20});
describe('Stage-aware LAB referee', () => {
  test('S3 defers genuinely partial/invisible objects, not arbitrary misses', () => {
    const r=judgeVisibleTees([target(1),target(2,'PARTIAL'),target(3,'INVISIBLE')],[{id:'a',point:[20,0]}]);
    expect(r.verdict).toBe('PASS');expect(r.requiredVisible).toBe(1);expect(r.deferredToS4).toHaveLength(2);
  });
  test('unreviewed visibility cannot manufacture a Stage pass', () => {
    expect(judgeVisibleTees([target(1,'UNKNOWN')],[]).verdict).toBe('UNKNOWN');
  });
  test('missing visible and unrelated extra do not cancel at equal cardinality', () => {
    const r=judgeVisibleTees([target(1)],[{id:'ui',point:[999,999]}]);
    expect(r.verdict).toBe('FAIL');expect(r.missingVisible).toEqual([1]);expect(r.extra).toEqual(['ui']);
  });
  test('invisible truth cannot validate fabricated visible ownership', () => {
    expect(judgeVisibleTees([target(1,'INVISIBLE')],[{id:'made-up',point:[20,0]}]).verdict).toBe('FAIL');
  });
  test('maximum cardinality beats greedy nearest neighbor', () => {
    const r=matchObjects([{number:1,point:[0,0]},{number:2,point:[2,0]}],[{id:'a',point:[1,0]},{id:'b',point:[-2,0]}],2);
    expect(r.matches.map(m=>[m.number,m.id])).toEqual([[1,'b'],[2,'a']]);expect(r.missing).toEqual([]);
  });
  test('a detection cannot satisfy two annotations', () => {
    expect(matchObjects([{number:1,point:[0,0]},{number:2,point:[1,0]}],[{id:'a',point:[0,0]}]).matches).toHaveLength(1);
  });
  test('invalid identities/coordinates and tolerances fail loudly', () => {
    expect(()=>matchObjects([],[],NaN)).toThrow();
    expect(()=>matchObjects([{number:1,point:[NaN,0]}],[])).toThrow();
    expect(()=>matchObjects([],[{id:'a',point:[0,0]},{id:'a',point:[1,0]}])).toThrow();
  });
  test('raw and already-canonical frames do not both get cropped twice', () => {
    const full={widthPx:1,heightPx:5,rgba:new Uint8Array(Array.from({length:20},(_,i)=>i)),imageId:'raw'};
    const canonical={widthPx:1,heightPx:3,rgba:full.rgba.slice(4,16),imageId:'canonical'};
    const hole={number:1,tee:{xPx:0,yPx:2},basket:{xPx:0,yPx:3}};
    expect(exactCropOffset(full,canonical)).toEqual([0,1]);
    const raw=alignTruth({sourceImage:{widthPx:1,heightPx:5,sha256:'raw'},holes:[hole]},full,canonical);
    const can=alignTruth({sourceImage:{widthPx:1,heightPx:3,sha256:'canonical'},holes:[hole]},full,canonical);
    expect(raw.targets[0].tee).toEqual([0,1]);expect(can.targets[0].tee).toEqual([0,2]);
  });
  test('constant/repeated raster cannot establish an exact crop offset', () => {
    expect(()=>exactCropOffset({widthPx:1,heightPx:4,rgba:new Uint8Array(16)}, {widthPx:1,heightPx:2,rgba:new Uint8Array(8)})).toThrow(/uniquely/);
  });
});
