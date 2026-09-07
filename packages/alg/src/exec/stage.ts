import type { PxC } from './board';
import { readPql, invokePql, type CalculationOverride, type PqlRun } from './pql';

/** An experiment replaces Calculations; the Stage YAML owns all composition. */
export interface ABFeature {
 readonly id: string;
 readonly overrides: Readonly<Record<string, CalculationOverride>>;
}
export interface StageVariantResult {
 readonly variant: string;
 readonly kind: 'default' | 'feature';
 readonly overrides: ABFeature['overrides'];
 readonly status: 'completed' | 'failed';
 readonly pxc: PxC;
 readonly run?: PqlRun;
 readonly error?: string;
}
export function createPqlStage(yaml: string, prepare: (pxc: PxC) => void) {
 const composition = readPql(yaml);
 const features = new Map<string, ABFeature>();
 return {
  composition,
  /** Registration is participation. Re-registering an ID updates its definition. */
  register(feature: ABFeature) { features.set(feature.id, feature); },
  run({pxc}: {pxc: PxC}) {
   const results: StageVariantResult[] = [];
   const variants = [{id:'Default',kind:'default' as const,overrides:{}},...Array.from(features.values(),feature=>({...feature,kind:'feature' as const}))];
   for (const variant of variants) {
    const world = pxc.fork();
    try {
     prepare(world);
     const calls = new Set(composition.Ticks.flatMap(t=>t.Calculations.map(c=>c.call)));
     for (const target of Object.keys(variant.overrides))
      if (!calls.has(target as `fn.${string}`)) throw new Error(`Override target ${target} does not occur in this Stage.`);
     results.push({variant:variant.id,kind:variant.kind,overrides:variant.overrides,status:'completed',pxc:world,
      run:invokePql(composition,{pxc:world,overrides:variant.overrides})});
    } catch (error) {
     results.push({variant:variant.id,kind:variant.kind,overrides:variant.overrides,status:'failed',pxc:world,
      error:error instanceof Error ? error.message : String(error)});
    }
   }
   // Differentiation consumes these complete runs; no scoring policy is imposed here.
   pxc.set(`px.pql.${composition.PrincipleComponentRender}.results`,results);
   return results;
  }
 };
}
