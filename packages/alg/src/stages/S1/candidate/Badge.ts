import type { CompositeResult } from '../../../g0/composite';
import {
	assembleBadgeV1,
	componentRef,
	containsBbox,
	materializeComponentAssembly,
	materializeRasterComponentPixels,
	type ComponentRasterEvidence,
	type RasterComponentRef
} from '../../../detectors/threeFactor/componentAssembly';
import type { BrightDarkComponentFields } from '../../../detectors/threeFactor/componentField';
import type { ComponentStats } from '../../../detectors/threeFactor/components';
import {
	detectBadgeFamily,
	recoverDarkPlateBadges,
	type BadgeStageKnobs,
	type BadgeStageResult
} from '../../../detectors/threeFactor/badgeStage';
import type { Mask } from '../../../detectors/threeFactor/raster';
import type { BadgeEvidence as LegacyBadgeRead } from '../../../detectors/threeFactor/types';
import { pxFn, pxKey, type PxC } from '../../../exec/board';

export interface BadgeMasks {
	readonly bright: Mask;
	readonly dark: Mask;
}

export const BadgePxC = {
	image: pxKey<CompositeResult>('px.image.cropped'),
	masks: pxKey<BadgeMasks>('px.components.masks'),
	components: pxKey<BrightDarkComponentFields>('px.components'),
	family: pxKey<readonly ComponentStats[]>('px.badges.family'),
	stage: pxKey<BadgeStageResult>('px.badges.stage'),
	reads: pxKey<readonly LegacyBadgeRead[]>('badges'),
	objects: pxKey<readonly Badge[]>('px.badges')
} as const;

interface DetectFamilyArgs {
	readonly width: number;
	readonly dark: Mask;
	readonly bright: readonly ComponentStats[];
	readonly knobs: BadgeStageKnobs;
}

interface RecoverArgs {
	readonly width: number;
	readonly height: number;
	readonly masks: BadgeMasks;
	readonly fields: BrightDarkComponentFields;
	readonly family: readonly ComponentStats[];
	readonly knobs: BadgeStageKnobs;
}

interface FindPxArgs {
	readonly stage: BadgeStageResult;
	readonly fields: BrightDarkComponentFields;
	readonly read: LegacyBadgeRead;
}

interface FoundPx {
	readonly basis: 'bright-family' | 'dark-plate-recovery' | 'unresolved';
	readonly components: readonly RasterComponentRef[];
	readonly px: Uint32Array;
	readonly whitePx: number;
	readonly blackPx: number;
	readonly note?: string;
}

interface MuteArgs {
	readonly found: FoundPx;
	readonly read: LegacyBadgeRead;
	readonly raster: ComponentRasterEvidence;
	readonly radiusPx: number;
}

export const BadgeFn = {
	detectFamily: pxFn<DetectFamilyArgs, ComponentStats[]>('fn.Badge.detectFamily'),
	recover: pxFn<RecoverArgs, BadgeStageResult>('fn.Badge.recover'),
	findPx: pxFn<FindPxArgs, FoundPx>('fn.Badge.findPx'),
	mute: pxFn<MuteArgs, Uint32Array>('fn.Badge.mute')
} as const;

function sortedUnique(parts: readonly Uint32Array[]): Uint32Array {
	const values = new Set<number>();
	for (const part of parts) for (const value of part) values.add(value);
	return Uint32Array.from([...values].sort((left, right) => left - right));
}

function sameBbox(
	left: readonly [number, number, number, number],
	right: readonly [number, number, number, number]
): boolean {
	return left.every((value, index) => value === right[index]);
}

function fillOuter(component: RasterComponentRef, raster: ComponentRasterEvidence): Uint32Array {
	const edge = materializeRasterComponentPixels(component, raster);
	const spans = new Map<number, { minimumX: number; maximumX: number }>();
	for (const pixel of edge) {
		const x = pixel % raster.width;
		const y = (pixel - x) / raster.width;
		const span = spans.get(y);
		if (span) {
			span.minimumX = Math.min(span.minimumX, x);
			span.maximumX = Math.max(span.maximumX, x);
		} else spans.set(y, { minimumX: x, maximumX: x });
	}
	const filled: number[] = [];
	for (const [y, span] of spans) {
		for (let x = span.minimumX; x <= span.maximumX; x++) filled.push(y * raster.width + x);
	}
	return Uint32Array.from(filled.sort((left, right) => left - right));
}

function fillBbox(
	bbox: readonly [number, number, number, number],
	width: number,
	height: number
): Uint32Array {
	const [x, y, bboxWidth, bboxHeight] = bbox;
	const filled: number[] = [];
	for (let yy = Math.max(0, y); yy < Math.min(height, y + bboxHeight); yy++) {
		for (let xx = Math.max(0, x); xx < Math.min(width, x + bboxWidth); xx++) {
			filled.push(yy * width + xx);
		}
	}
	return Uint32Array.from(filled);
}

function expand(px: Uint32Array, width: number, height: number, radiusPx: number): Uint32Array {
	const expanded = new Set<number>(px);
	for (const pixel of px) {
		const x = pixel % width;
		const y = (pixel - x) / width;
		for (let dy = -radiusPx; dy <= radiusPx; dy++) {
			for (let dx = -radiusPx; dx <= radiusPx; dx++) {
				if (dx * dx + dy * dy > radiusPx * radiusPx) continue;
				const xx = x + dx;
				const yy = y + dy;
				if (xx >= 0 && yy >= 0 && xx < width && yy < height) expanded.add(yy * width + xx);
			}
		}
	}
	return Uint32Array.from([...expanded].sort((left, right) => left - right));
}

const detectFamilyCalculation = ({ width, dark, bright, knobs }: DetectFamilyArgs) =>
	detectBadgeFamily(width, dark, bright, knobs);

const recoverCalculation = ({ width, height, masks, fields, family, knobs }: RecoverArgs) => {
	const badges = [...family];
	const badgeSources: ('bright-family' | 'dark-plate-recovery')[] = badges.map(
		() => 'bright-family'
	);
	const plateBboxes: (readonly [number, number, number, number] | null)[] = badges.map(() => null);
	recoverDarkPlateBadges(
		width,
		masks.bright,
		masks.dark,
		badges,
		badgeSources,
		plateBboxes,
		knobs,
		fields.dark.components
	);
	return {
		width,
		height,
		brightMask: masks.bright,
		darkMask: masks.dark,
		brightLabels: fields.bright.labels,
		brightComponents: [...fields.bright.components],
		darkLabels: fields.dark.labels,
		darkComponents: [...fields.dark.components],
		badges,
		badgeSources,
		plateBboxes,
		badgeCount: badges.length,
		plateInteriorMarginPx: knobs.plateInteriorMargin,
		plateFrameTolerancePx: knobs.plateFrameTolerancePx
	} satisfies BadgeStageResult;
};

const findPxCalculation = ({ stage, fields, read }: FindPxArgs): FoundPx => {
	const raster: ComponentRasterEvidence = {
		width: stage.width,
		height: stage.height,
		topPx: 0,
		brightLabels: fields.bright.labels,
		darkLabels: fields.dark.labels
	};
	if (read.source === 'bright-family') {
		const outer = fields.bright.components.find(
			(component) => component.label === read.component.label
		);
		if (!outer)
			return {
				basis: 'unresolved',
				components: [],
				px: new Uint32Array(),
				whitePx: 0,
				blackPx: 0,
				note: 'outer bright component unavailable'
			};
		const assembly = assembleBadgeV1(outer, fields.bright.components, fields.dark.components);
		if (assembly.status === 'failed')
			return {
				basis: 'unresolved',
				components: [],
				px: new Uint32Array(),
				whitePx: 0,
				blackPx: 0,
				note: assembly.reason
			};
		const materialized = materializeComponentAssembly(assembly, raster);
		const white = sortedUnique(
			materialized.components
				.filter((part) => part.polarity === 'bright')
				.map((part) => materializeRasterComponentPixels(part, raster))
		);
		const black = sortedUnique(
			materialized.components
				.filter((part) => part.polarity === 'dark')
				.map((part) => materializeRasterComponentPixels(part, raster))
		);
		return {
			basis: 'bright-family',
			components: materialized.components,
			px: materialized.ownedPixels,
			whitePx: white.length,
			blackPx: black.length
		};
	}
	if (!read.plateBbox)
		return {
			basis: 'unresolved',
			components: [],
			px: new Uint32Array(),
			whitePx: 0,
			blackPx: 0,
			note: 'recovered badge has no plate bounds'
		};
	const plate = fields.dark.components.find((component) =>
		sameBbox([component.bboxX, component.bboxY, component.bboxW, component.bboxH], read.plateBbox!)
	);
	if (!plate)
		return {
			basis: 'unresolved',
			components: [],
			px: new Uint32Array(),
			whitePx: 0,
			blackPx: 0,
			note: 'recovered dark plate unavailable'
		};
	const components = [
		componentRef('dark', plate),
		...fields.bright.components
			.filter((component) =>
				containsBbox(read.plateBbox!, [
					component.bboxX,
					component.bboxY,
					component.bboxW,
					component.bboxH
				])
			)
			.map((component) => componentRef('bright', component))
	];
	const white = sortedUnique(
		components
			.filter((part) => part.polarity === 'bright')
			.map((part) => materializeRasterComponentPixels(part, raster))
	);
	const black = sortedUnique(
		components
			.filter((part) => part.polarity === 'dark')
			.map((part) => materializeRasterComponentPixels(part, raster))
	);
	return {
		basis: 'dark-plate-recovery',
		components,
		px: sortedUnique([white, black]),
		whitePx: white.length,
		blackPx: black.length,
		note: '7/9 overlap remains a recovery concern'
	};
};

const muteCalculation = ({ found, read, raster, radiusPx }: MuteArgs): Uint32Array => {
	const support =
		found.basis === 'bright-family' && found.components[0]
			? fillOuter(found.components[0], raster)
			: fillBbox(read.bbox, raster.width, raster.height);
	return expand(support, raster.width, raster.height, radiusPx);
};

export function registerBadge(pxc: PxC): void {
	pxc.register(BadgeFn.detectFamily, detectFamilyCalculation);
	pxc.register(BadgeFn.recover, recoverCalculation);
	pxc.register(BadgeFn.findPx, findPxCalculation);
	pxc.register(BadgeFn.mute, muteCalculation);
}

export interface BadgeHas {
	readonly detectFamily?: {
		readonly fn: typeof BadgeFn.detectFamily.address;
		readonly outer: RasterComponentRef;
	};
	readonly recover?: {
		readonly fn: typeof BadgeFn.recover.address;
		readonly plate: RasterComponentRef;
	};
	readonly findPx: {
		readonly fn: typeof BadgeFn.findPx.address;
		readonly parts: readonly RasterComponentRef[];
	};
	readonly readDigit: { readonly fn: 'fn.readCourseBadges'; readonly label: string | null };
	readonly mute: {
		readonly fn: typeof BadgeFn.mute.address;
		readonly radiusPx: number;
		readonly px: Uint32Array;
	};
}

export class Badge {
	readonly label: string | null;
	readonly source: LegacyBadgeRead['source'];
	readonly bbox: readonly [number, number, number, number];
	readonly rawLabel: string;
	readonly confidence: number;
	readonly abstentionReason: LegacyBadgeRead['abstentionReason'];
	readonly has: BadgeHas;
	readonly px: Uint32Array;
	readonly whitePx: number;
	readonly blackPx: number;
	readonly note?: string;

	private constructor(read: LegacyBadgeRead, found: FoundPx, muted: Uint32Array) {
		this.label = read.label;
		this.source = read.source;
		this.bbox = read.bbox;
		this.rawLabel = read.rawLabel;
		this.confidence = read.confidence;
		this.abstentionReason = read.abstentionReason;
		this.px = found.px;
		this.whitePx = found.whitePx;
		this.blackPx = found.blackPx;
		this.note = found.note;
		const outer = found.components.find((part) => part.polarity === 'bright');
		const plate = found.components.find((part) => part.polarity === 'dark');
		this.has = {
			...(read.source === 'bright-family' && outer
				? { detectFamily: { fn: BadgeFn.detectFamily.address, outer } }
				: {}),
			...(read.source === 'dark-plate-recovery' && plate
				? { recover: { fn: BadgeFn.recover.address, plate } }
				: {}),
			findPx: { fn: BadgeFn.findPx.address, parts: found.components },
			readDigit: { fn: 'fn.readCourseBadges', label: read.label },
			mute: { fn: BadgeFn.mute.address, radiusPx: 2, px: muted }
		};
	}

	static detectFamily(pxc: PxC, knobs: BadgeStageKnobs): readonly ComponentStats[] {
		const image = pxc.get(BadgePxC.image);
		const masks = pxc.get(BadgePxC.masks);
		const fields = pxc.get(BadgePxC.components);
		return pxc.call(BadgeFn.detectFamily, {
			width: image.widthPx,
			dark: masks.dark,
			bright: fields.bright.components,
			knobs
		});
	}

	static recover(pxc: PxC, knobs: BadgeStageKnobs): BadgeStageResult {
		const image = pxc.get(BadgePxC.image);
		return pxc.call(BadgeFn.recover, {
			width: image.widthPx,
			height: image.heightPx,
			masks: pxc.get(BadgePxC.masks),
			fields: pxc.get(BadgePxC.components),
			family: pxc.get(BadgePxC.family),
			knobs
		});
	}

	static fromRead(pxc: PxC, read: LegacyBadgeRead): Badge {
		const stage = pxc.get(BadgePxC.stage);
		const fields = pxc.get(BadgePxC.components);
		const found = pxc.call(BadgeFn.findPx, { stage, fields, read });
		const raster: ComponentRasterEvidence = {
			width: stage.width,
			height: stage.height,
			topPx: 0,
			brightLabels: fields.bright.labels,
			darkLabels: fields.dark.labels
		};
		const muted = pxc.call(BadgeFn.mute, { found, read, raster, radiusPx: 2 });
		return new Badge(read, found, muted);
	}
}
