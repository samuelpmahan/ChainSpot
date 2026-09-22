import assert from 'node:assert/strict';
import { createExecBoard } from '../packages/alg/dist/exec/board.js';
import { NativeArithmetic, specialMultiply } from './pxcube-simple-calculator.mjs';
import { timed, timingComparison } from './pxcube-timing-comparison.mjs';
import { compareParity } from './pxcube-simple-calculator-pxc.mjs';

const pxc=createExecBoard();
const a=7,b=5000;

const cleanTimed=timed(()=>NativeArithmetic.multiply(a,b),1);
pxc.set('calc.product',cleanTimed.value);

const repeated=pxc.fork('exp/repeated-add');
const repeatedTimed=timed(()=>specialMultiply(a,b),b);
repeated.set('calc.product',repeatedTimed.value);

const broken=pxc.fork('exp/broken');
const brokenTimed=timed(()=>specialMultiply(a,b-1),b-1);
broken.set('calc.product',brokenTimed.value);

const clean={calculation:'fn.nativeMultiply',value:pxc.get('calc.product')};
const candidate={calculation:'fn.specialMultiply',value:repeated.get('calc.product')};
const bad={calculation:'fn.brokenMultiply',value:broken.get('calc.product')};
assert.equal(compareParity(clean,candidate).parity,true);
assert.equal(compareParity(clean,bad).parity,false);

const editions=pxc.catalog.editions('calc.product');
assert.equal(editions.length,3);
assert.deepEqual(editions.map(e=>[e.lineage,e.value]),[
 ['clean',35000],['exp/repeated-add',35000],['exp/broken',34993]
]);
assert.equal(pxc.get('calc.product'),35000);
assert.equal(repeated.get('calc.product'),35000);
assert.equal(broken.get('calc.product'),34993);

const timing=timingComparison(cleanTimed,repeatedTimed);
assert.equal(timing.semantic.parity,true);
assert.equal(timing.execution.cleanCalculations,1);
assert.equal(timing.execution.candidateCalculations,5000);

console.log(JSON.stringify({
 editions:editions.map(e=>({lineage:e.lineage,edition:e.edition,value:e.value})),
 parity:{repeatedAdd:compareParity(clean,candidate),broken:compareParity(clean,bad)},
 timing
},null,2));
