import type { CompositeResult } from '../../../g0/composite';
import { DEFAULT_EXECUTION, canonicalJson, resolveConfig } from '../../../detectors/threeFactor';
import type { BadgeStageKnobs, BadgeStageResult } from '../../../detectors/threeFactor/badgeStage';
import type { BrightDarkComponentFields } from '../../../detectors/threeFactor/componentField';
import type { ComponentStats } from '../../../detectors/threeFactor/components';
import { g1BadgesFeature } from '../../../detectors/threeFactor/features/g1.badges';
import {
	nullFeatureContext,
	type FeatureContext
} from '../../../detectors/threeFactor/features/types';
import type {
	BadgeEvidence as LegacyBadgeRead,
	RgbaImage
} from '../../../detectors/threeFactor/types';
import type { PxC } from '../../../exec/board';
import { compileExecutionPlan, type CompiledExecutionPlan } from '../../../exec/compile';
import type { OperationSpec, TickTestimony } from '../../../exec/contract';
import { executeCompiledPlan, type OperationRuntime } from '../../../exec/gateway';
import {
	ARTIFACT_EXTRACTORS,
	operationCalculationBindings,
	operationImpls
} from '../../../exec/operations';
import { composePcr, type Pcr } from '../../../exec/pcr';
import { sha256HexSyncText } from '../../../exec/sha256';
import { createMemorySink } from '../../../exec/sink';
import { S0_CROPPED_IMAGE_ADDRESS } from '../../S0/clean';
import { Badge, BadgeFn, BadgePxC, registerBadge, type BadgeMasks } from './Badge';

export { Badge, BadgeFn, BadgePxC } from './Badge';

const LEGACY = {
	localImage: 'localImage',
	viewport: 'viewport',
	masks: 'badgeStage.masks',
	components: 'badgeStage.components',
	reads: 'badges',
	stage: 'stage'
} as const;

export const S1_ACCEPT_CROPPED_IMAGE_TICK: OperationSpec = {
	id: 'badges.acceptCroppedImage',
	kind: 'transform',
	gate: 'G1',
	unit: 'Badge',
	consumes: [S0_CROPPED_IMAGE_ADDRESS],
	produces: [LEGACY.localImage, LEGACY.viewport, BadgePxC.image.address],
	calculations: ['fn.acceptCroppedImage'],
	accessConformance: 'exact',
	note: 'Expose S0 CroppedImage to the inherited mask/component substrate without another decode.'
};

export const S1_BADGE_FAMILY_TICK: OperationSpec = {
	id: 'Badge.detectFamily',
	kind: 'compute',
	gate: 'G1',
	unit: 'Badge',
	consumes: [BadgePxC.image.address, BadgePxC.masks.address, BadgePxC.components.address],
	produces: [BadgePxC.family.address],
	calculations: [BadgeFn.detectFamily.address],
	accessConformance: 'exact',
	note: 'Badge queries shared bright/dark components and selects its current family.'
};

export const S1_COMPONENT_SUBSTRATE_TICK: OperationSpec = {
	id: 'components.publish',
	kind: 'transform',
	gate: 'G1',
	unit: 'components',
	consumes: [LEGACY.masks, LEGACY.components],
	produces: [BadgePxC.masks.address, BadgePxC.components.address],
	calculations: ['fn.publishComponents'],
	accessConformance: 'exact',
	note: 'Publish inherited mask/component results once as generic typed PxC values.'
};

export const S1_BADGE_RECOVERY_TICK: OperationSpec = {
	id: 'Badge.recover',
	kind: 'decide',
	gate: 'G1',
	unit: 'Badge',
	consumes: [
		BadgePxC.image.address,
		BadgePxC.masks.address,
		BadgePxC.components.address,
		BadgePxC.family.address
	],
	produces: [BadgePxC.stage.address, LEGACY.stage],
	calculations: [BadgeFn.recover.address],
	accessConformance: 'exact',
	note: 'Badge performs dark-plate recovery and exposes the transitional shape required by digit reading.'
};

export const S1_BADGE_OBJECTS_TICK: OperationSpec = {
	id: 'Badge.findPx',
	kind: 'transform',
	gate: 'G1',
	unit: 'Badge',
	consumes: [BadgePxC.stage.address, BadgePxC.components.address, LEGACY.reads],
	produces: [BadgePxC.objects.address],
	calculations: [BadgeFn.findPx.address, BadgeFn.mute.address],
	accessConformance: 'exact',
	note: 'Construct Badge objects whose has map names the operations and component parts that define them.'
};

const resolved = resolveConfig(
	{
		schema: 'threeFactor-config@1',
		name: 'S1-badges-candidate',
		execution: ['badgeStage', 'badges']
	},
	DEFAULT_EXECUTION
);
const paramsHash = sha256HexSyncText(canonicalJson(resolved));
const inherited = compileExecutionPlan(resolved, paramsHash);

function inheritedTick(id: string): OperationSpec {
	const tick = inherited.ops.find((operation) => operation.id === id);
	if (!tick) throw new Error(`S1: inherited operation '${id}' is unavailable.`);
	return tick;
}

const S1_OPS = [
	S1_ACCEPT_CROPPED_IMAGE_TICK,
	inheritedTick('badgeStage.masks'),
	inheritedTick('badgeStage.components'),
	S1_COMPONENT_SUBSTRATE_TICK,
	S1_BADGE_FAMILY_TICK,
	S1_BADGE_RECOVERY_TICK,
	inheritedTick('badges'),
	S1_BADGE_OBJECTS_TICK
] as const;

const S1_PLAN: CompiledExecutionPlan = {
	...inherited,
	ops: S1_OPS,
	planFingerprint: sha256HexSyncText(
		canonicalJson({ candidate: 'S1-badges', base: inherited.planFingerprint, ops: S1_OPS })
	)
};

function acceptCroppedImage(pxc: PxC): void {
	const cropped = pxc.get<CompositeResult>(S0_CROPPED_IMAGE_ADDRESS);
	const localImage: RgbaImage = {
		width: cropped.widthPx,
		height: cropped.heightPx,
		data: cropped.rgba
	};
	pxc.set(LEGACY.localImage, localImage);
	pxc.set(LEGACY.viewport, { topPx: 0, bottomPx: cropped.heightPx });
	pxc.set(BadgePxC.image, cropped);
}

function publishComponents(pxc: PxC): void {
	pxc.set(BadgePxC.masks, pxc.get<BadgeMasks>(LEGACY.masks));
	pxc.set(BadgePxC.components, pxc.get<BrightDarkComponentFields>(LEGACY.components));
}

function detectFamily(pxc: PxC, ctx: FeatureContext): void {
	const knobs = ctx.resolve(g1BadgesFeature).knobs as unknown as BadgeStageKnobs;
	pxc.set(BadgePxC.family, Badge.detectFamily(pxc, knobs));
}

function recover(pxc: PxC, ctx: FeatureContext): void {
	const knobs = ctx.resolve(g1BadgesFeature).knobs as unknown as BadgeStageKnobs;
	const stage = Badge.recover(pxc, knobs);
	pxc.set(BadgePxC.stage, stage);
	pxc.set(LEGACY.stage, stage);
}

function constructBadges(pxc: PxC): void {
	const reads = pxc.get<LegacyBadgeRead[]>(LEGACY.reads);
	pxc.set(
		BadgePxC.objects,
		reads.map((read) => Badge.fromRead(pxc, read))
	);
}

const S1_RUNTIME: OperationRuntime = {
	implementations: new Map([
		...operationImpls,
		[S1_ACCEPT_CROPPED_IMAGE_TICK.id, acceptCroppedImage],
		[S1_COMPONENT_SUBSTRATE_TICK.id, publishComponents],
		[S1_BADGE_FAMILY_TICK.id, detectFamily],
		[S1_BADGE_RECOVERY_TICK.id, recover],
		[S1_BADGE_OBJECTS_TICK.id, constructBadges]
	]),
	calculationBindings: new Map([
		...operationCalculationBindings,
		[
			S1_ACCEPT_CROPPED_IMAGE_TICK.id,
			[{ address: 'fn.acceptCroppedImage', calculate: acceptCroppedImage }]
		],
		[
			S1_COMPONENT_SUBSTRATE_TICK.id,
			[{ address: 'fn.publishComponents', calculate: publishComponents }]
		],
		[
			S1_BADGE_FAMILY_TICK.id,
			[{ address: BadgeFn.detectFamily.address, calculate: Badge.detectFamily }]
		],
		[S1_BADGE_RECOVERY_TICK.id, [{ address: BadgeFn.recover.address, calculate: Badge.recover }]],
		[
			S1_BADGE_OBJECTS_TICK.id,
			[
				{ address: BadgeFn.findPx.address, calculate: Badge.fromRead },
				{ address: BadgeFn.mute.address, calculate: Badge.fromRead }
			]
		]
	]),
	artifactExtractors: ARTIFACT_EXTRACTORS
};

export interface S1Subtraction {
	readonly widthPx: number;
	readonly heightPx: number;
	readonly rgba: Uint8ClampedArray;
	readonly badgePx: number;
	readonly addedMutePx: number;
	readonly mutedPx: number;
	readonly overlapPx: number;
	readonly remainingOpaquePx: number;
}

function subtract(image: CompositeResult, parts: readonly Uint32Array[]): S1Subtraction {
	const muted = new Set<number>();
	let visits = 0;
	for (const part of parts)
		for (const pixel of part) {
			visits++;
			muted.add(pixel);
		}
	const rgba = new Uint8ClampedArray(image.rgba);
	for (const pixel of muted) rgba[pixel * 4 + 3] = 0;
	let remainingOpaquePx = 0;
	for (let pixel = 0; pixel < image.widthPx * image.heightPx; pixel++)
		if (rgba[pixel * 4 + 3] !== 0) remainingOpaquePx++;
	return {
		widthPx: image.widthPx,
		heightPx: image.heightPx,
		rgba,
		badgePx: 0,
		addedMutePx: 0,
		mutedPx: muted.size,
		overlapPx: visits - muted.size,
		remainingOpaquePx
	};
}

/** Materializer-only alpha subtraction; neither raster is written back to PxC. */
export function materializeS1Subtractions(
	run: Pick<S1BadgesCandidateRun, 'croppedImage' | 'badges'>
): { badgePx: S1Subtraction; muted: S1Subtraction } {
	const core = new Set<number>();
	for (const badge of run.badges) for (const pixel of badge.px) core.add(pixel);
	const badgePx = subtract(
		run.croppedImage,
		run.badges.map((badge) => badge.px)
	);
	const muted = subtract(
		run.croppedImage,
		run.badges.map((badge) => badge.has.mute.px)
	);
	return {
		badgePx: { ...badgePx, badgePx: core.size },
		muted: { ...muted, badgePx: core.size, addedMutePx: muted.mutedPx - core.size }
	};
}

export interface S1BadgesCandidateRun {
	readonly pxc: PxC;
	readonly croppedImage: CompositeResult;
	readonly masks: BadgeMasks;
	readonly components: BrightDarkComponentFields;
	readonly family: readonly ComponentStats[];
	readonly stage: BadgeStageResult;
	readonly badges: readonly Badge[];
	readonly plan: CompiledExecutionPlan;
	readonly testimonies: readonly TickTestimony[];
	readonly pcr: Pcr;
}

export function executeS1BadgesCandidate(pxc: PxC): S1BadgesCandidateRun {
	if (!pxc.has(S0_CROPPED_IMAGE_ADDRESS))
		throw new Error(`S1 requires PxC address '${S0_CROPPED_IMAGE_ADDRESS}'.`);
	registerBadge(pxc);
	const sink = createMemorySink();
	const testimonies = executeCompiledPlan(S1_PLAN, pxc, nullFeatureContext, sink, S1_RUNTIME);
	const pcr = composePcr(
		{
			id: 'S1.badges-candidate',
			title: 'CroppedImage → Badge objects',
			tickIds: S1_PLAN.ops.map((operation) => operation.id)
		},
		S1_PLAN,
		testimonies
	);
	return {
		pxc,
		croppedImage: pxc.get(BadgePxC.image),
		masks: pxc.get(BadgePxC.masks),
		components: pxc.get(BadgePxC.components),
		family: pxc.get(BadgePxC.family),
		stage: pxc.get(BadgePxC.stage),
		badges: pxc.get(BadgePxC.objects),
		plan: S1_PLAN,
		testimonies,
		pcr
	};
}
