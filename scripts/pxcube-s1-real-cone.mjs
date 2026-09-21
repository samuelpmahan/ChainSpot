import { conservativeSemanticPlan } from '../packages/alg/dist/exec/speculative.js';

/** Real S1 badge-stage shaped speculative plan, kept outside the gateway until proven. */
export function planS1BadgeSpeculation(ops, deltas) {
  const badgeOps=ops.filter((op)=>op.unit==='badgeStage').map((op)=>({
    id:op.id,
    semanticConsumes:op.semanticConsumes,
    consumes:op.consumes,
    produces:op.produces
  }));
  return conservativeSemanticPlan(deltas,badgeOps);
}
