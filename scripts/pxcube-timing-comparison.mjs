export function timingComparison(clean,candidate){
  const semanticParity=Object.is(clean.value,candidate.value);
  const deltaMs=candidate.elapsedMs-clean.elapsedMs;
  const ratio=clean.elapsedMs>0 ? candidate.elapsedMs/clean.elapsedMs : null;
  return {
    semantic:{parity:semanticParity,cleanValue:clean.value,candidateValue:candidate.value},
    execution:{
      cleanMs:clean.elapsedMs,
      candidateMs:candidate.elapsedMs,
      deltaMs,
      ratio,
      cleanCalculations:clean.calculations ?? 1,
      candidateCalculations:candidate.calculations ?? 1,
      cleanExecuted:clean.executed ?? clean.calculations ?? 1,
      candidateExecuted:candidate.executed ?? candidate.calculations ?? 1,
      cleanReused:clean.reused ?? 0,
      candidateReused:candidate.reused ?? 0
    }
  };
}
export function timed(fn, calculations=1){
  const start=performance.now(); const value=fn(); const elapsedMs=performance.now()-start;
  return {value,elapsedMs,calculations,executed:calculations,reused:0};
}
