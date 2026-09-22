import assert from 'node:assert/strict';
import test from 'node:test';
import { calculatorForks, compareParity } from '../../scripts/pxcube-simple-calculator-pxc.mjs';

test('native clean and decomposed add/multiply forks prove parity',()=>{
 const run=calculatorForks(7,5);
 assert.deepEqual(compareParity(run.add.clean,run.add.forks[0]),{parity:true,where:undefined,why:'same semantic value'});
 assert.equal(compareParity(run.multiply.clean,run.multiply.forks[0]).parity,true);
});
test('wrong speculative multiply is rebuked with precise testimony',()=>{
 const run=calculatorForks(7,5);
 const cmp=compareParity(run.multiply.clean,run.multiply.forks[1]);
 assert.deepEqual(cmp,{parity:false,where:'fn.brokenMultiply',why:'clean=35; candidate=28'});
});
