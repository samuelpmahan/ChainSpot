import assert from 'node:assert/strict';
import test from 'node:test';
import { badgeParity, passWhileBadgeParity } from '../../scripts/pxcube-badge-parity.mjs';

test('BadgeParity earns continuation while identity is preserved',()=>{
 const cmp=badgeParity([{detId:'B1'},{detId:'B2'}],[{detId:'B2'},{detId:'B1'}]);
 assert.equal(cmp.parity,true);
 const r=passWhileBadgeParity([
  {id:'S0',compare:()=>({parity:true,comparator:'fn.compareCanonicalPixelsContract'})},
  {id:'S1',compare:()=>cmp},
  {id:'S2',compare:()=>({parity:true,comparator:'fn.compareBasketIdentity'})}
 ]);
 assert.equal(r.status,'SUPPORTED'); assert.equal(r.continuation,'PASS_WHILE');
});
test('BadgeParity rebuke stops before downstream stage',()=>{
 let s2=false;
 const cmp=badgeParity([{detId:'B1'},{detId:'B2'}],[{detId:'B1'}]);
 const r=passWhileBadgeParity([
  {id:'S0',compare:()=>({parity:true})},
  {id:'S1',compare:()=>cmp},
  {id:'S2',compare:()=>{s2=true;return {parity:true}}}
 ]);
 assert.equal(r.status,'REBUKED'); assert.equal(r.stoppedAt,'S1'); assert.equal(s2,false);
 assert.equal(r.visited[1].comparison.where,'badge identities');
});
