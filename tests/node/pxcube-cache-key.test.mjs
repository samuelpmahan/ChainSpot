import assert from 'node:assert/strict';
import test from 'node:test';
import { calculationCacheKey } from '../../scripts/pxcube-cache-key.mjs';

test('cache identity ignores lineage and object key order', () => {
  const a=calculationCacheKey({address:'fn.D',implementationHash:'impl1',inputPartIds:['p1','p2'],runArgs:{b:2,a:1}});
  const b=calculationCacheKey({address:'fn.D',implementationHash:'impl1',inputPartIds:['p1','p2'],runArgs:{a:1,b:2}});
  assert.equal(a,b);
});
test('semantic inputs and implementation identity invalidate cache', () => {
  const base={address:'fn.D',implementationHash:'impl1',inputPartIds:['p1'],runArgs:{mode:'x'}};
  const key=calculationCacheKey(base);
  assert.notEqual(key,calculationCacheKey({...base,implementationHash:'impl2'}));
  assert.notEqual(key,calculationCacheKey({...base,inputPartIds:['p2']}));
  assert.notEqual(key,calculationCacheKey({...base,runArgs:{mode:'y'}}));
});
