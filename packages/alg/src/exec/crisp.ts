import type { CalculationAddress, OperationKind, PartAddress } from './contract';

export interface CrispTickContract {
	readonly id:string;
	readonly kind:OperationKind;
	readonly consumes:readonly PartAddress[];
	readonly produces:readonly PartAddress[];
	readonly calculations:readonly CalculationAddress[];
}

export interface CrispAssertionContract {
	readonly id:string;
	readonly description:string;
}

export interface CrispStageContract {
	readonly schema:'pxc.stage/v1';
	readonly stage:`S${number}`;
	readonly ticks:readonly CrispTickContract[];
	readonly assertions:readonly CrispAssertionContract[];
}

/**
 * crisp is the PxC boilerplate compiler. Given the semantic Stage declaration
 * and neat's registered work, this is the durable contract tidy can freeze,
 * hash, version, and use as the delta-build baseline.
 */
export function generateStageContract(
	stage:`S${number}`,
	ticks:readonly CrispTickContract[],
	assertions:readonly CrispAssertionContract[]=[]
):CrispStageContract {
	const ids=new Set<string>();
	for(const tick of ticks){
		if(ids.has(tick.id))throw new Error(`crisp: duplicate Tick '${tick.id}' in ${stage}`);
		ids.add(tick.id);
		if(tick.calculations.length===0)throw new Error(`crisp: Tick '${tick.id}' has no neat Calculation registration`);
	}
	return {schema:'pxc.stage/v1',stage,ticks,assertions};
}
