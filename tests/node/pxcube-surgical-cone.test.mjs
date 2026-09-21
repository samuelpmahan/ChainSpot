import assert from 'node:assert/strict';
import test from 'node:test';
import { convergeOnEquivalence, surgicalExecutionCone } from '../../scripts/pxcube-surgical-cone.mjs';

test('semantic delta executes only direct semantic consumers and their Part descendants', () => {
  const calculations=[
    {id:'badgeMasks',semanticConsumes:['canonicalPixels.content'],produces:['masks']},
    {id:'edgeDetector',semanticConsumes:['canonicalPixels.membership.bottom'],produces:['edges']},
    {id:'badgeAssemble',consumes:['masks'],produces:['badges']},
    {id:'edgeMeasure',consumes:['edges'],produces:['edgeStats']},
    {id:'metadataReceipt',semanticConsumes:['source.meta.filename'],produces:['receipt']}
  ];
  const plan=surgicalExecutionCone({deltas:[{path:'canonicalPixels.membership.bottom',before:4,after:20}],calculations});
  assert.deepEqual(plan,[
    {id:'badgeMasks',resolution:'REUSE'},
    {id:'edgeDetector',resolution:'EXECUTE'},
    {id:'badgeAssemble',resolution:'REUSE'},
    {id:'edgeMeasure',resolution:'EXECUTE'},
    {id:'metadataReceipt',resolution:'REUSE'}
  ]);
});

test('comparator-proven parity closes divergence onto trusted clean Part', () => {
  assert.deepEqual(convergeOnEquivalence({
    candidatePart:'badges.exp/A', cleanPart:'badges.clean',
    comparison:{parity:true,comparator:'fn.compareBadges'}
  }),{
    converged:true,reusablePart:'badges.clean',
    testimony:{candidatePart:'badges.exp/A',cleanPart:'badges.clean',comparator:'fn.compareBadges',reason:'semantic-equivalence'}
  });
  assert.equal(convergeOnEquivalence({candidatePart:'x',cleanPart:'y',comparison:{parity:false}}).converged,false);
});
