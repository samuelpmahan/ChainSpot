import type { PxC } from './board';
import { readPql, invokePql, type CalculationOverride, type PqlRun } from './pql';
import type { Comparator, ComparisonResult } from './comparator';

/** An experiment replaces Calculations; the Stage YAML owns all composition. */
export interface ABFeature {
 readonly id: string;
 readonly overrides: Readonly<Record<string, CalculationOverride>>;
 readonly comparator: Comparator;
}
export interface StageVariantResult {
 readonly variant: string;
 readonly kind: 'default' | 'feature';
 readonly overrides: ABFeature['overrides'];
 readonly status: 'completed' | 'failed';
 readonly pxc: PxC;
 readonly run?: PqlRun;
 readonly error?: string;
 /** Wall-clock time inside invokePql, including its lookup, writes and recording.
  * Excludes fork, prepare, override validation and comparison. Null if never invoked.
  * A failed invocation records time until failure, not a complete-run benchmark.
  */
 readonly executionMs: number | null;
}
export function createPqlStage(yaml: string, prepare: (pxc: PxC) => void) {
 const composition = readPql(yaml);
 const features = new Map<string, ABFeature>();
 return {
  composition,
  /** Registration is participation. Re-registering an ID updates its definition. */
  register(feature: ABFeature) {
   if (!feature.comparator || typeof feature.comparator.compare !== 'function' ||
       typeof feature.comparator.id !== 'string' || !feature.comparator.id.trim())
    throw new Error(`ABFeature ${feature.id} must supply a named Comparator.`);
   features.set(feature.id, feature);
  },
  run({pxc}: {pxc: PxC}) {
   const results: StageVariantResult[] = [];
   const variants = [{id:'Default',kind:'default' as const,overrides:{}},...Array.from(features.values(),feature=>({...feature,kind:'feature' as const}))];
   for (const variant of variants) {
    const world = pxc.fork();
    let started: number | undefined;
    try {
     prepare(world);
     const calls = new Set(composition.Ticks.flatMap(t=>t.Calculations.map(c=>c.call)));
     for (const target of Object.keys(variant.overrides))
      if (!calls.has(target as `fn.${string}`)) throw new Error(`Override target ${target} does not occur in this Stage.`);
     started = performance.now();
     const run = invokePql(composition,{pxc:world,overrides:variant.overrides});
     const executionMs = performance.now() - started;
     results.push({variant:variant.id,kind:variant.kind,overrides:variant.overrides,status:'completed',pxc:world,
      run, executionMs});
    } catch (error) {
     results.push({variant:variant.id,kind:variant.kind,overrides:variant.overrides,status:'failed',pxc:world,
      executionMs: started === undefined ? null : performance.now() - started,
      error:error instanceof Error ? error.message : String(error)});
    }
   }
   // Differentiation consumes these complete runs; no scoring policy is imposed here.
   pxc.set(`px.pql.${composition.PrincipleComponentRender}.results`,results);
   const comparisons: ComparisonResult[] = [];
   // All computation finishes before comparison, so comparison cost cannot enter run timings.
   const registered = Array.from(features.values());
   for (let index = 0; index < registered.length; index++) {
    const comparator = registered[index].comparator;
    const baseline = results[0];
    const feature = results[index + 1];
    const identity = {comparator:comparator.id,baseline:baseline.variant,feature:feature.variant};
    try {
     comparisons.push({...identity,status:'completed',output:comparator.compare({baseline,feature})});
    } catch (error) {
     comparisons.push({...identity,status:'failed',error:error instanceof Error ? error.message : String(error)});
    }
   }
   pxc.set(`px.pql.${composition.PrincipleComponentRender}.comparisons`,comparisons);
   return results;
  }
 };
}
