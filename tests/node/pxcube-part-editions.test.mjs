import assert from 'node:assert/strict';
import test from 'node:test';
import { createPartCatalog } from '../../packages/alg/dist/exec/board.js';

test('one Part address keeps multiple lineage editions',()=>{
 const c=createPartCatalog();
 c.publish({part:'product',lineage:'clean',edition:'native',producer:'fn.nativeMultiply',value:35});
 c.publish({part:'product',lineage:'exp/repeated-add',edition:'special',producer:'fn.specialMultiply',value:35});
 c.publish({part:'product',lineage:'exp/broken',edition:'broken',producer:'fn.brokenMultiply',value:28});
 assert.deepEqual(c.editions('product').map(x=>[x.lineage,x.edition,x.value]),[
  ['clean','native',35],['exp/repeated-add','special',35],['exp/broken','broken',28]
 ]);
 assert.equal(c.resolve('product').value,35);
 assert.equal(c.resolve('product','exp/repeated-add').value,35);
});
test('collision means same address + lineage + edition, not same address',()=>{
 const c=createPartCatalog();
 c.publish({part:'sum',lineage:'clean',edition:'v1',value:12});
 c.publish({part:'sum',lineage:'clean',edition:'v2',value:13});
 assert.equal(c.resolve('sum').value,13);
 assert.throws(()=>c.publish({part:'sum',lineage:'clean',edition:'v2',value:99}),/duplicate Part edition/);
});
