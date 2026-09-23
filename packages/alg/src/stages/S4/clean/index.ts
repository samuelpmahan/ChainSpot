import { runThreeFactor } from '../../../detectors/threeFactor';
import type { PxC } from '../../../exec/board';
import type { TickTestimony } from '../../../exec/contract';
import { executeCompiledPlan } from '../../../exec/gateway';
import { NeatCatalog } from '../../../exec/neat';
import { compileStage, type CrispTickDeclaration } from '../../../exec/crisp';
import { createMemorySink } from '../../../exec/sink';
import { nullFeatureContext } from '../../../detectors/threeFactor/features/types';
import { ComponentPxC } from '../../componentPxC';
import { BadgePxC, type Badge } from '../../S1/clean/Badge';
import { BasketPxC, type Basket } from '../../S2/clean/Basket';
import { TeePxC, type Tee } from '../../S3/clean/Tee';
import { S4Fn, S4PxC, type RecoveredBadge, type RecoveredBasket, type RecoveredTee } from '../contract';
import { recoverOccludedBaskets } from './BasketRecovery';
import { completeTees } from './TeeCompletion';

export const S4_RECOVER_TICK = {
	id: 'OccludedObject.recover',
	kind: 'compute',
	gate: 'S4',
	unit: 'OccludedObject',
	consumes: [ComponentPxC.image.address, BadgePxC.objects.address, BasketPxC.objects.address, TeePxC.objects.address],
	produces: [S4PxC.recoveredBadges.address,S4PxC.recoveredBaskets.address,S4PxC.recoveredTees.address],
	calculations: [S4Fn.recoverBadges.address,S4Fn.recoverBaskets.address,S4Fn.recoverTees.address],
	accessConformance: 'exact',
	note: 'All long-tail occlusion recovery lives in S4.'
,
	run: recover
} satisfies CrispTickDeclaration;

export const S4_COMPLETE_TICK = {
	id: 'OccludedObject.complete',
	kind: 'compute',
	gate: 'S4',
	unit: 'OccludedObject',
	consumes: [BadgePxC.objects.address,BasketPxC.objects.address,TeePxC.objects.address,S4PxC.recoveredBadges.address,S4PxC.recoveredBaskets.address,S4PxC.recoveredTees.address],
	produces: [S4PxC.badges.address,S4PxC.baskets.address,S4PxC.tees.address],
	calculations: [S4Fn.completeBadges.address,S4Fn.completeBaskets.address,S4Fn.completeTees.address],
	accessConformance: 'exact',
	note: 'Initial + recovered produces the authoritative post-S4 inventories.'
};

function recover(pxc: PxC): void {
	// S4 recovery consumes the established initial inventories even while the legacy
	// recovery adapter still recomputes some detector evidence internally.
	pxc.get(BadgePxC.objects);
	pxc.get(BasketPxC.objects);
	pxc.get(TeePxC.objects);
	const image=pxc.get<any>(ComponentPxC.image);
	const run=runThreeFactor(image);
	const badges: RecoveredBadge[]=[];
	const baskets: RecoveredBasket[]=[...recoverOccludedBaskets(image,pxc.get<readonly Badge[]>(BadgePxC.objects),pxc.get<readonly Basket[]>(BasketPxC.objects))];
	const tees: RecoveredTee[]=[];
	const badgesById=new Map(run.measurement.badges.map((x)=>[x.detId,x] as const));
	const teesById=new Map(run.assignment.tees.map((x)=>[x.detId,x] as const));
	for(const ownership of run.assignment.assignments){
		const badge=badgesById.get(ownership.badgeId);
		const tee=teesById.get(ownership.teeId);
		const hole=Number(badge?.label ?? NaN);
		if(Number.isInteger(hole)&&tee?.tier==='recovered')
			tees.push({hole,xPx:tee.xPx,yPx:tee.yPx,source:tee.recovery?.source ?? 'teeRecovery'});
	}
	// Existing explicit S4 port currently has tee recovery. Empty arrays are
	// honest testimony until badge/basket recovery are ported into this spine.
	pxc.set(S4PxC.recoveredBadges.address,badges);
	pxc.set(S4PxC.recoveredBaskets.address,baskets);
	pxc.set(S4PxC.recoveredTees.address,tees);
}

function complete(pxc: PxC): void {
	const badges=[...pxc.get<readonly Badge[]>(BadgePxC.objects),...pxc.get<readonly RecoveredBadge[]>(S4PxC.recoveredBadges.address)];
	const baskets=[...pxc.get<readonly Basket[]>(BasketPxC.objects),...pxc.get<readonly RecoveredBasket[]>(S4PxC.recoveredBaskets.address)];
	const tees=completeTees(pxc.get<readonly Tee[]>(TeePxC.objects),pxc.get<readonly RecoveredTee[]>(S4PxC.recoveredTees.address),badges.length);
	pxc.set(S4PxC.badges.address,badges);
	pxc.set(S4PxC.baskets.address,baskets);
	pxc.set(S4PxC.tees.address,tees);
	const expected=badges.length;
	if(baskets.length!==expected||tees.length!==expected) throw new Error(
		`S4 incomplete object inventory: badges.complete=${expected}, baskets.complete=${baskets.length}, tees.complete=${tees.length}; each semantic hole requires exactly one Basket and one Tee`
	);
}

const RUNTIME: OperationRuntime={
	implementations:new Map([[S4_RECOVER_TICK.id,recover],[S4_COMPLETE_TICK.id,complete]]),
	calculationBindings:new Map([
		[S4_RECOVER_TICK.id,[
			{address:S4Fn.recoverBadges.address,calculate:recover},
			{address:S4Fn.recoverBaskets.address,calculate:recover},
			{address:S4Fn.recoverTees.address,calculate:recover}
		]],
		[S4_COMPLETE_TICK.id,[
			{address:S4Fn.completeBadges.address,calculate:complete},
			{address:S4Fn.completeBaskets.address,calculate:complete},
			{address:S4Fn.completeTees.address,calculate:complete}
		]]
	])
};

export interface S4Run {
	readonly pxc:PxC;
	readonly recoveredBadges:readonly RecoveredBadge[];
	readonly recoveredBaskets:readonly RecoveredBasket[];
	readonly recoveredTees:readonly RecoveredTee[];
	readonly testimonies:readonly TickTestimony[];
}

export function executeS4OccludedObjectRecovery(pxc: PxC): S4Run {
	for(const address of [ComponentPxC.image.address,BadgePxC.objects.address,BasketPxC.objects.address,TeePxC.objects.address])
		if(!pxc.has(address)) throw new Error(`S4 requires PxC address '${address}'.`);
	const testimonies=executeCompiledPlan(COMPILED.plan,pxc,nullFeatureContext,createMemorySink(),COMPILED.runtime);
	return {
		pxc,
		recoveredBadges:pxc.get(S4PxC.recoveredBadges.address),
		recoveredBaskets:pxc.get(S4PxC.recoveredBaskets.address),
		recoveredTees:pxc.get(S4PxC.recoveredTees.address),
		testimonies
	};
}
