export function s0ForkReceipt(run) {
  const candidate = run.observations[0];
  if (!candidate) throw new Error('S0 fork receipt requires one observational lineage.');
  return {
    kind: 'pxcube.comparison-receipt',
    tick: run.tick,
    authority: run.authoritative.lineage,
    candidate: candidate.lineage,
    boundary: candidate.boundary,
    intent: 'Compare candidate Crop against trusted clean Crop without changing authoritative execution.',
    execution: {
      cleanMs: run.authoritative.elapsedMs,
      candidateMs: candidate.elapsedMs
    },
    difference: candidate.comparison
  };
}

export function formatS0ForkReceipt(receipt) {
  const d = receipt.difference;
  return [
    'PXCUBE COMPARISON RECEIPT',
    `tick: ${receipt.tick}`,
    `authority: ${receipt.authority}`,
    `candidate: ${receipt.candidate} · ${receipt.boundary}`,
    `intent: ${receipt.intent}`,
    `pixels: ${d.samePixels ? 'SAME' : 'DIFFERENT'}`,
    `dims: Δw=${d.widthDeltaPx}px Δh=${d.heightDeltaPx}px`,
    `cleanInsets: ${JSON.stringify(d.cleanInsets)}`,
    `candidateInsets: ${JSON.stringify(d.candidateInsets)}`,
    `executionMs: clean=${receipt.execution.cleanMs.toFixed(3)} candidate=${receipt.execution.candidateMs.toFixed(3)}`
  ].join('\n');
}
