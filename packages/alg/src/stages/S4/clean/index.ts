import { runThreeFactor } from '../../../detectors/threeFactor';
import type { PxC } from '../../../exec/board';
import type { OperationSpec, TickTestimony } from '../../../exec/contract';
import type { CompiledExecutionPlan } from '../../../exec/compile';
import { executeCompiledPlan, type OperationRuntime } from '../../../exec/gateway';
import { createMemorySink } from '../../../exec/sink';
import { nullFeatureContext } from '../../../detectors/threeFactor/features/types';
import { canonicalJson } from '../../../detectors/threeFactor/hash';
import { sha256HexSyncText } from '../../../exec/sha256';
import { ComponentPxC } from '../../componentPxC';
import { BadgePxC } from '../../S1/clean/Badge';
import { BasketPxC } from '../../S2/clean/Basket';
import { TeePxC } from '../../S3/clean/Tee';
import { S4Fn, S4PxC, type RecoveredOccludedObject } from '../contract';

export const S4_RECOVER_TEES_TICK: OperationSpec = {
	id: 'OccludedObject.recoverTees',
	kind: 'compute',
	gate: 'S4',
	unit: 'OccludedObject',
	consumes: [ComponentPxC.image.address, BadgePxC.objects.address, BasketPxC.objects.address, TeePxC.objects.address],
	produces: [S4PxC.objects.address],
	calculations: [S4Fn.recoverTees.address],
	accessConformance: 'exact',
	note: 'Port the existing production teeRecovery capability into the explicit S4 occluded-object boundary.'
};

const OPS=[S4_RECOVER_TEES_TICK] as const;
const PLAN: CompiledExecutionPlan={ops:OPS,bindings:{},planFingerprint:sha256HexSyncText(canonicalJson({clean:'S4-occluded-object-recovery',ops:OPS}))};

function recoverTees(pxc: PxC): void {
	const image=pxc.get<any>(ComponentPxC.image);
	const run=runThreeFactor(image);
	const recovered: RecoveredOccludedObject[]=[];
	const badgesById=new Map(run.measurement.badges.map((badge)=>[badge.detId,badge] as const));
	const teesById=new Map(run.assignment.tees.map((tee)=>[tee.detId,tee] as const));
	for(const ownership of run.assignment.assignments){
		const badge=badgesById.get(ownership.badgeId);
		const tee=teesById.get(ownership.teeId);
		const n=Number(badge?.label ?? NaN);
		if(!Number.isInteger(n)||!tee||tee.tier!=='recovered') continue;
		recovered.push({kind:'tee',hole:n,xPx:tee.xPx,yPx:tee.yPx,source:tee.recovery?.source ?? 'teeRecovery'});
	}
	pxc.set(S4PxC.objects.address,recovered);
}

const RUNTIME: OperationRuntime={
	implementations:new Map([[S4_RECOVER_TEES_TICK.id,recoverTees]]),
	calculationBindings:new Map([[S4_RECOVER_TEES_TICK.id,[{address:S4Fn.recoverTees.address,calculate:recoverTees}]]])
};

export interface S4Run { readonly pxc:PxC; readonly recovered:readonly RecoveredOccludedObject[]; readonly testimonies:readonly TickTestimony[]; }

export function executeS4OccludedObjectRecovery(pxc: PxC): S4Run {
	for(const address of [ComponentPxC.image.address,BadgePxC.objects.address,BasketPxC.objects.address,TeePxC.objects.address])
		if(!pxc.has(address)) throw new Error(`S4 requires PxC address '${address}'.`);
	const testimonies=executeCompiledPlan(PLAN,pxc,nullFeatureContext,createMemorySink(),RUNTIME);
	return {pxc,recovered:pxc.get(S4PxC.objects.address),testimonies};
}
