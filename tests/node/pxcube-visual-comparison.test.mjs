import assert from 'node:assert/strict';
import test from 'node:test';
import { changedMembershipBands, visualComparisonSpec } from '../../scripts/pxcube-visual-comparison.mjs';

test('visual receipt preserves source evidence and describes membership delta', () => {
  const receipt = { authority:'clean', candidate:'exp/A', boundary:'STOP', difference:{ cleanInsets:{top:4,right:0,bottom:4,left:0}, candidateInsets:{top:10,right:0,bottom:20,left:0} } };
  const spec = visualComparisonSpec({
    source:{imageId:'source',widthPx:600,heightPx:1000},
    clean:{imageId:'clean',widthPx:600,heightPx:992},
    candidate:{imageId:'candidate',widthPx:600,heightPx:970},
    receipt
  });
  assert.deepEqual(spec.panels.map(p=>p.role), ['SOURCE','CLEAN','CANDIDATE','DELTA']);
  assert.equal(spec.panels[3].sourceImageId, 'source');
  assert.deepEqual(changedMembershipBands(600,1000,receipt.difference.cleanInsets,receipt.difference.candidateInsets).bands, [
    {side:'top',cleanPx:4,candidatePx:10,deltaPx:6},
    {side:'bottom',cleanPx:4,candidatePx:20,deltaPx:16}
  ]);
});
