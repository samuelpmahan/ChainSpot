import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveSpeculativeExecution, speculativePrefixCache } from '../../scripts/pxcube-speculative-execution.mjs';

test('clean zero-fork execution reuses cached work and executes only unresolved work', () => {
  const calculations = ['fn.A','fn.B','fn.C','fn.D'];
  const cache = speculativePrefixCache(calculations, ['a','b']);
  assert.deepEqual(resolveSpeculativeExecution({ calculations, cache }).map(x => x.resolution), [
    {kind:'reuse',reason:'cache-hit'},
    {kind:'reuse',reason:'cache-hit'},
    {kind:'execute'},
    {kind:'execute'}
  ]);
});

test('experimental lineage reuses clean prefix and executes deliberate override only where divergence begins', () => {
  const calculations = ['fn.A','fn.B','fn.C','fn.D','fn.E'];
  const cache = speculativePrefixCache(calculations, ['a','b','c','d','e']);
  const plan = resolveSpeculativeExecution({ calculations, lineage:'exp/D2', overrides:['fn.D'], cache });
  assert.deepEqual(plan.map(x => [x.address,x.resolution.kind,x.reason ?? x.resolution.reason]), [
    ['fn.A','reuse','cache-hit'],
    ['fn.B','reuse','cache-hit'],
    ['fn.C','reuse','cache-hit'],
    ['fn.D','execute','override'],
    ['fn.E','reuse','cache-hit']
  ]);
});

test('proven equivalent result permits convergence reuse', () => {
  const plan = resolveSpeculativeExecution({
    calculations:['fn.D','fn.E','fn.F'],
    lineage:'exp/D2',
    overrides:['fn.D'],
    equivalent:new Set(['fn.F'])
  });
  assert.equal(plan[0].resolution.kind,'execute');
  assert.deepEqual(plan[2].resolution,{kind:'reuse',reason:'equivalent-result'});
});
