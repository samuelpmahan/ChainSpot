import { NativeArithmetic, specialAdd, specialMultiply } from './pxcube-simple-calculator.mjs';

export function calculatorForks(a,b){
  return {
    add:{
      clean:{lineage:'clean',calculation:'fn.nativeAdd',value:NativeArithmetic.add(a,b)},
      forks:[{lineage:'exp/repeated-increment',calculation:'fn.specialAdd',value:specialAdd(a,b),claim:'AddParity'}]
    },
    multiply:{
      clean:{lineage:'clean',calculation:'fn.nativeMultiply',value:NativeArithmetic.multiply(a,b)},
      forks:[
        {lineage:'exp/repeated-add',calculation:'fn.specialMultiply',value:specialMultiply(a,b),claim:'MultiplyParity'},
        {lineage:'exp/broken',calculation:'fn.brokenMultiply',value:specialMultiply(a,b-1),claim:'MultiplyParity'}
      ]
    }
  };
}
export function compareParity(clean,candidate){
  const parity=Object.is(clean.value,candidate.value);
  return {parity,where:parity?undefined:candidate.calculation,why:parity?'same semantic value':`clean=${clean.value}; candidate=${candidate.value}`};
}
