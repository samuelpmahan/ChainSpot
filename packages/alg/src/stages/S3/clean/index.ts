import type { CompositeResult } from '../../../g0/composite';
import { canonicalJson } from '../../../detectors/threeFactor/hash';
import { nullFeatureContext } from '../../../detectors/threeFactor/features/types';
import type { PxC } from '../../../exec/board';
import type { CompiledExecutionPlan } from '../../../exec/compile';
import type { OperationSpec, TickTestimony } from '../../../exec/contract';
import { executeCompiledPlan, type OperationRuntime } from '../../../exec/gateway';
import { composePcr, type Pcr } from '../../../exec/pcr';
import { sha256HexSyncText } from '../../../exec/sha256';
import { createMemorySink } from '../../../exec/sink';
import { BadgePxC } from '../../S1/clean/Badge';
import { ComponentPxC } from '../../componentPxC';
import { Tee, TeeFn, TeePxC, registerTee, type TeeFamily, type TeeRingSearch } from './Tee';

export { Tee, TeeFn, TeePxC, selectTeeFamily } from './Tee';

export const S3_DETECT_RINGS_TICK: OperationSpec = {
	id: 'Tee.detectRings',
	kind: 'measure',
	gate: 'S3',
	unit: 'Tee',
	consumes: [ComponentPxC.fields.address, BadgePxC.objects.address],
	produces: [TeePxC.rings.address],
	calculations: [TeeFn.detectRings.address],
	accessConformance: 'exact',
	note: 'Find enclosed holes, retain elongated rings, and exclude centers muted by prior Badge objects.'
};

export const S3_FIND_FAMILY_TICK: OperationSpec = {
	id: 'Tee.findFamily',
	kind: 'compute',
	gate: 'S3',
	unit: 'Tee',
	consumes: [TeePxC.rings.address, ComponentPxC.fields.address],
	produces: [TeePxC.family.address],
	calculations: [TeeFn.findFamily.address],
	accessConformance: 'exact',
	note: 'Pair rings with enclosing bright components and select the common major/minor/area family.'
};

export const S3_FIND_PX_TICK: OperationSpec = {
	id: 'Tee.findPx',
	kind: 'transform',
	gate: 'S3',
	unit: 'Tee',
	consumes: [TeePxC.family.address, ComponentPxC.fields.address],
	produces: [TeePxC.objects.address],
	calculations: [TeeFn.findPx.address],
	accessConformance: 'exact',
	note: 'Construct visible Tee objects from exact accepted bright-component pixels.'
};

const S3_OPS = [S3_DETECT_RINGS_TICK, S3_FIND_FAMILY_TICK, S3_FIND_PX_TICK] as const;
const S3_PLAN: CompiledExecutionPlan = {
	ops: S3_OPS,
	bindings: {},
	planFingerprint: sha256HexSyncText(canonicalJson({ clean: 'S3-visible-tees', ops: S3_OPS }))
};

function detectRings(pxc: PxC): void {
	pxc.set(TeePxC.rings, Tee.detectRings(pxc));
}

function findFamily(pxc: PxC): void {
	pxc.set(TeePxC.family, Tee.findFamily(pxc));
}

function findPx(pxc: PxC): void {
	pxc.set(TeePxC.objects, Tee.findPx(pxc));
}

const S3_RUNTIME: OperationRuntime = {
	implementations: new Map([
		[S3_DETECT_RINGS_TICK.id, detectRings],
		[S3_FIND_FAMILY_TICK.id, findFamily],
		[S3_FIND_PX_TICK.id, findPx]
	]),
	calculationBindings: new Map([
		[S3_DETECT_RINGS_TICK.id, [{ address: TeeFn.detectRings.address, calculate: Tee.detectRings }]],
		[S3_FIND_FAMILY_TICK.id, [{ address: TeeFn.findFamily.address, calculate: Tee.findFamily }]],
		[S3_FIND_PX_TICK.id, [{ address: TeeFn.findPx.address, calculate: Tee.findPx }]]
	])
};

export interface S3Subtraction {
	readonly widthPx: number;
	readonly heightPx: number;
	readonly rgba: Uint8ClampedArray;
	readonly teePx: number;
	readonly overlapPx: number;
	readonly remainingOpaquePx: number;
}

export function materializeS3Subtraction(
	image: CompositeResult,
	tees: readonly Tee[]
): S3Subtraction {
	const px = new Set<number>();
	let visits = 0;
	for (const tee of tees)
		for (const pixel of tee.px) {
			visits++;
			px.add(pixel);
		}
	const rgba = new Uint8ClampedArray(image.rgba);
	for (const pixel of px) rgba[pixel * 4 + 3] = 0;
	let remainingOpaquePx = 0;
	for (let pixel = 0; pixel < image.widthPx * image.heightPx; pixel++)
		if (rgba[pixel * 4 + 3] !== 0) remainingOpaquePx++;
	return {
		widthPx: image.widthPx,
		heightPx: image.heightPx,
		rgba,
		teePx: px.size,
		overlapPx: visits - px.size,
		remainingOpaquePx
	};
}

export interface S3VisibleTeesRun {
	readonly pxc: PxC;
	readonly image: CompositeResult;
	readonly rings: TeeRingSearch;
	readonly family: TeeFamily;
	readonly tees: readonly Tee[];
	readonly plan: CompiledExecutionPlan;
	readonly testimonies: readonly TickTestimony[];
	readonly pcr: Pcr;
}

export function executeS3VisibleTees(pxc: PxC): S3VisibleTeesRun {
	if (!pxc.has(ComponentPxC.fields))
		throw new Error(`S3 requires PxC address '${ComponentPxC.fields.address}'.`);
	if (!pxc.has(BadgePxC.objects))
		throw new Error(`S3 requires PxC address '${BadgePxC.objects.address}'.`);
	registerTee(pxc);
	const testimonies = executeCompiledPlan(
		S3_PLAN,
		pxc,
		nullFeatureContext,
		createMemorySink(),
		S3_RUNTIME
	);
	const pcr = composePcr(
		{
			id: 'S3.visible-tees',
			title: 'Hollow rings → visible Tee objects',
			tickIds: S3_PLAN.ops.map((operation) => operation.id)
		},
		S3_PLAN,
		testimonies
	);
	return {
		pxc,
		image: pxc.get(ComponentPxC.image),
		rings: pxc.get(TeePxC.rings),
		family: pxc.get(TeePxC.family),
		tees: pxc.get(TeePxC.objects),
		plan: S3_PLAN,
		testimonies,
		pcr
	};
}
