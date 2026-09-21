import assert from 'node:assert/strict';
import test from 'node:test';
import { parityClaim, propagateWhileParity } from '../../scripts/pxcube-parity-propagation.mjs';

test('speculative lineage rides Stage boundaries while claimed parity holds', () => {
  const claim=parityClaim({id:'DetectionParity',comparator:'fn.compareDetection',scope:['S0','S1','S2']});
  const result=propagateWhileParity({lineage:'exp/smart-crop',claim,stages:[
    {id:'S0',compare:()=>({parity:true})},
    {id:'S1',compare:()=>({parity:true})},
    {id:'S2',compare:()=>({parity:true})}
  ]});
  assert.equal(result.status,'SUPPORTED');
  assert.equal(result.continuation,'PASS_WHILE');
  assert.deepEqual(result.visited.map(x=>x.stageId),['S0','S1','S2']);
});

test('first parity contradiction rebukes claim and stops downstream execution horizon', () => {
  let s3Ran=false;
  const claim=parityClaim({id:'DetectionParity',comparator:'fn.compareDetection',scope:['S0','S1','S2','S3']});
  const stages=[
    {id:'S0',compare:()=>({parity:true})},
    {id:'S1',compare:()=>({parity:true})},
    {id:'S2',compare:()=>({parity:false,where:'Badge 7',why:'clean detected; candidate missing'})},
    {id:'S3',compare:()=>{s3Ran=true; return {parity:true};}}
  ];
  const result=propagateWhileParity({lineage:'exp/smart-crop',claim,stages});
  assert.equal(result.status,'REBUKED');
  assert.equal(result.stoppedAt,'S2');
  assert.equal(result.continuation,'STOP');
  assert.equal(s3Ran,false);
  assert.equal(result.visited[2].comparison.where,'Badge 7');
});
