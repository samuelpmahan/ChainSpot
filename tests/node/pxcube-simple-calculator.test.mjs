import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeArithmetic as N, specialAdd, specialSubtract, specialMultiply, specialDivide } from '../../scripts/pxcube-simple-calculator.mjs';

test('native arithmetic is the ordinary optimal floor',()=>{
 assert.equal(N.add(7,5),12); assert.equal(N.subtract(7,5),2);
 assert.equal(N.multiply(7,5),35); assert.equal(N.divide(35,5),7);
});
test('special arithmetic demonstrates equivalent forkable decompositions',()=>{
 for(const [a,b] of [[7,5],[7,-5],[-7,5],[-7,-5]]){
  assert.equal(specialAdd(a,b),N.add(a,b));
  assert.equal(specialSubtract(a,b),N.subtract(a,b));
  assert.equal(specialMultiply(a,b),N.multiply(a,b));
 }
 assert.deepEqual(specialDivide(37,5),{quotient:7,remainder:2});
 assert.deepEqual(specialDivide(-37,5),{quotient:-7,remainder:-2});
});
