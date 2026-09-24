import type { CalculationAddress, OperationKind, OperationSpec, PartAddress } from './contract';
import type { CompiledExecutionPlan } from './compile';
import type { CalculationBinding, OperationImpl, OperationRuntime } from './gateway';
import { canonicalJson } from '../detectors/threeFactor/hash';
import { sha256HexSyncText } from './sha256';
import type { NeatCatalog, NeatLineage } from './neat';

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
	readonly registrations:readonly {readonly address:CalculationAddress;readonly lineage:NeatLineage;readonly source:string}[];
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
	return {schema:'pxc.stage/v1',stage,ticks,assertions,registrations:[]};
}


export interface CrispTickDeclaration extends CrispTickContract {
	readonly gate:string;
	readonly unit:string;
	readonly accessConformance?:'exact';
	readonly note?:string;
	/** Tick body owns Part reads/writes; named Calculations are frozen testimony identities. */
	readonly run:OperationImpl;
}

export interface CompiledCrispStage {
	readonly contract:CrispStageContract;
	readonly plan:CompiledExecutionPlan;
	readonly runtime:OperationRuntime;
}

/**
 * Compile one Stage from its semantic Tick declaration and neat's registered
 * Calculation work. This replaces handwritten PLAN/RUNTIME boilerplate.
 */
export function compileStage(
	stage:`S${number}`,
	ticks:readonly CrispTickDeclaration[],
	neat:NeatCatalog,
	assertions:readonly CrispAssertionContract[]=[],
	lineage:NeatLineage='clean'
):CompiledCrispStage {
	const generated=generateStageContract(stage,ticks,assertions);
	const contract:CrispStageContract={...generated,registrations:ticks.flatMap(t=>t.calculations.map(address=>{const w=neat.require(address,lineage);return {address,lineage,source:w.source};}))};
	const ops:OperationSpec[]=ticks.map(({run:_,...tick})=>({
		id:tick.id,kind:tick.kind,gate:tick.gate,unit:tick.unit,
		consumes:tick.consumes,produces:tick.produces,calculations:tick.calculations,
		...(tick.accessConformance?{accessConformance:tick.accessConformance}:{}),
		...(tick.note?{note:tick.note}:{})
	}));
	const implementations=new Map<string,OperationImpl>();
	const calculationBindings=new Map<string,readonly CalculationBinding[]>();
	for(const tick of ticks){
		implementations.set(tick.id,tick.run);
		calculationBindings.set(tick.id,tick.calculations.map(address=>{
			const work=neat.require(address,lineage);
			return {address,calculate:work.calculate as CalculationBinding['calculate']};
		}));
	}
	const planFingerprint=sha256HexSyncText(canonicalJson({stage,lineage,contract}));
	return {
		contract,
		plan:{ops,bindings:{},planFingerprint},
		runtime:{implementations,calculationBindings}
	};
}
