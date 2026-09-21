/**
 * Proof-carrying speculative propagation.
 * A lineage may cross Stage boundaries automatically only while every
 * comparator required by its declared parity claim remains satisfied.
 */
export function propagateWhileParity({ lineage, claim, stages }) {
  const visited = [];
  for (const stage of stages) {
    const comparison = stage.compare(lineage, claim);
    visited.push({ stageId: stage.id, comparison });
    if (!comparison.parity) {
      return {
        lineage,
        claim,
        status: 'REBUKED',
        stoppedAt: stage.id,
        visited,
        continuation: 'STOP'
      };
    }
  }
  return { lineage, claim, status: 'SUPPORTED', visited, continuation: 'PASS_WHILE' };
}

export function parityClaim({ id, comparator, scope }) {
  if (!id || !comparator || !scope?.length) throw new Error('parity claim requires id, comparator and scope');
  return Object.freeze({ id, comparator, scope: [...scope] });
}
