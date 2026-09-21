export const PASS='PASS', FAIL='FAIL', BLOCKED='BLOCKED';

/**
 * FlexibleBattery: factory-select an available fulfillment without changing
 * the semantic Check contract. Adapters answer canFulfill + run; the first
 * available adapter wins unless it returns BLOCKED, in which case the battery
 * tries the next lawful fulfillment.
 */
export async function runFlexibleBattery(check, adapters) {
  const attempts=[];
  for (const adapter of adapters) {
    const available=await adapter.canFulfill(check);
    if (!available) { attempts.push({adapter:adapter.id,status:BLOCKED,reason:'unavailable'}); continue; }
    const started=performance.now();
    try {
      const result=await adapter.run(check);
      const normalized={
        check:check.id,
        status:result.status,
        fulfillment:adapter.id,
        semanticTestimony:result.semanticTestimony ?? {},
        environmentTestimony:result.environmentTestimony ?? {},
        durationMs:performance.now()-started
      };
      attempts.push({
        adapter: adapter.id,
        status: normalized.status,
        reason: normalized.status === BLOCKED ? normalized.environmentTestimony?.reason : undefined,
        durationMs: normalized.durationMs
      });
      if (normalized.status !== BLOCKED) return {attempts,result:normalized};
    } catch (error) {
      attempts.push({adapter:adapter.id,status:BLOCKED,reason:error instanceof Error ? error.message : String(error)});
    }
  }
  return {attempts,result:{check:check.id,status:BLOCKED,fulfillment:null,semanticTestimony:{},environmentTestimony:{},durationMs:0}};
}
