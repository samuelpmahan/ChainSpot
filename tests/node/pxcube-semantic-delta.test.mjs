import assert from 'node:assert/strict';
import test from 'node:test';
import { semanticDelta, surgicalComparisonObligation } from '../../scripts/pxcube-semantic-delta.mjs';

test('semantic delta explains exactly what changed', () => {
  assert.deepEqual(semanticDelta(
    {crop:{top:4,bottom:4},meta:{filename:'a.png'}},
    {crop:{top:4,bottom:20},meta:{filename:'b.png'}}
  ),[
    {path:'crop.bottom',before:4,after:20},
    {path:'meta.filename',before:'a.png',after:'b.png'}
  ]);
});

test('parity obligation ignores semantically irrelevant changes', () => {
  const deltas=semanticDelta(
    {crop:{bottom:4},meta:{filename:'a.png'}},
    {crop:{bottom:20},meta:{filename:'b.png'}}
  );
  const obligation=surgicalComparisonObligation({
    claim:{id:'DetectionParity',comparator:'fn.compareDetection'},
    deltas,
    dependencies:['crop.bottom']
  });
  assert.equal(obligation.required,true);
  assert.deepEqual(obligation.relevant,[{path:'crop.bottom',before:4,after:20}]);
  assert.deepEqual(obligation.skipped,[{path:'meta.filename',before:'a.png',after:'b.png'}]);
});
