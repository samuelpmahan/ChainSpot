export const NativeArithmetic = Object.freeze({
  add:(a,b)=>a+b,
  subtract:(a,b)=>a-b,
  multiply:(a,b)=>a*b,
  divide:(a,b)=>a/b
});

export function increment(n){ return n+1; }
export function decrement(n){ return n-1; }

export function specialAdd(a,b){
  if(!Number.isInteger(b)) throw new Error('specialAdd floor currently requires integer rhs');
  let out=a;
  const step=b>=0 ? increment : decrement;
  for(let i=0;i<Math.abs(b);i++) out=step(out);
  return out;
}
export function specialSubtract(a,b){ return specialAdd(a,-b); }

export function specialMultiply(a,b){
  if(!Number.isInteger(b)) throw new Error('specialMultiply floor currently requires integer rhs');
  let out=0;
  for(let i=0;i<Math.abs(b);i++) out=specialAdd(out,a);
  return b<0 ? -out : out;
}

export function specialDivide(a,b){
  if(!Number.isInteger(a)||!Number.isInteger(b)||b===0) throw new Error('specialDivide floor requires integer dividend/divisor and nonzero divisor');
  const sign=Math.sign(a)*Math.sign(b);
  let remainder=Math.abs(a), quotient=0, divisor=Math.abs(b);
  while(remainder>=divisor){ remainder=specialSubtract(remainder,divisor); quotient=increment(quotient); }
  return {quotient:sign*quotient,remainder:Math.sign(a)*remainder};
}
