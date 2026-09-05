const {test}=require('node:test');
const assert=require('node:assert/strict');
const {measurePairs,judgePairs}=require('../../../packages/alg/dist/stages/S4/exp/axis-local');
const tee=(x,y,a=0)=>({center:[x,y],angleRad:a,px:Uint32Array.of(3,4)});
const badge=(hole,x,y)=>({label:String(hole),bbox:[x,y,1,1]});
test('axis sign is immaterial',()=>{
  const a=measurePairs([tee(0,0,0)],[badge(1,-10,0)]);
  const b=measurePairs([tee(0,0,Math.PI)],[badge(1,-10,0)]);
  assert.ok(a[0].angleDeg<1e-8&&b[0].angleDeg<1e-8);
});
test('angular NaiveGate retains rejected measurements without filling holes',()=>{
  const t=[tee(0,0)];const pairs=measurePairs(t,[badge(1,10,10)]);
  assert.equal(pairs.length,1);assert.equal(judgePairs(pairs,t).resolutions.length,0);
});
test('reciprocal preference does not rematch a loser to make a count',()=>{
  const t=[tee(0,0),tee(1,0)];const b=[badge(1,10,0),badge(2,100,0)];
  const r=judgePairs(measurePairs(t,b),t);
  assert.deepEqual(r.resolutions.map(r=>r.hole),[1]);assert.deepEqual(r.unresolvedHoles,[2]);
});
test('no double assignment',()=>{
  const t=[tee(0,0),tee(1,0)];const r=judgePairs(measurePairs(t,[badge(1,10,0)]),t);
  assert.equal(r.resolutions.length,1);assert.equal(r.resolutions[0].tee,1);
});
test('resolved pixel ownership is copied, not fabricated or aliased',()=>{
  const t=[tee(0,0)];const r=judgePairs(measurePairs(t,[badge(1,10,0)]),t);
  r.resolutions[0].ownedPx[0]=999;assert.equal(t[0].px[0],3);
  assert.equal(r.resolutions[0].visibility,'VISIBLE');
});
test('coincident badge is unresolved, not an artificial perfect ray',()=>{
  const t=[tee(10,0)];assert.equal(judgePairs(measurePairs(t,[badge(1,10,0)]),t).resolutions.length,0);
});
