import assert from 'node:assert/strict';
import test from 'node:test';
import { timed, timingComparison } from '../../scripts/pxcube-timing-comparison.mjs';
import { NativeArithmetic, specialMultiply } from '../../scripts/pxcube-simple-calculator.mjs';

test('timing testimony is separate from semantic parity',()=>{
 const clean=timed(()=>NativeArithmetic.multiply(7,5000),1);
 const candidate=timed(()=>specialMultiply(7,5000),5000);
 const cmp=timingComparison(clean,candidate);
 assert.equal(cmp.semantic.parity,true);
 assert.equal(cmp.semantic.cleanValue,35000);
 assert.equal(cmp.execution.cleanCalculations,1);
 assert.equal(cmp.execution.candidateCalculations,5000);
 assert.equal(typeof cmp.execution.deltaMs,'number');
 assert.ok(cmp.execution.cleanMs>=0 && cmp.execution.candidateMs>=0);
});
test('faster cannot excuse semantic failure',()=>{
 const cmp=timingComparison({value:35,elapsedMs:10},{value:28,elapsedMs:1});
 assert.equal(cmp.semantic.parity,false);
 assert.equal(cmp.execution.deltaMs,-9);
});
