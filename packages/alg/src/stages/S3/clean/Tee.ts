import {
	detectTeeRings,
	type TeeRing
} from '../../../detectors/threeFactor/endpoints';
import {
	componentRef,
	materializeRasterComponentPixels,
	type ComponentRasterEvidence,
	type RasterComponentRef
} from '../../../detectors/threeFactor/componentAssembly';
import type { BrightDarkComponentFields } from '../../../detectors/threeFactor/componentField';
import type { ComponentStats } from '../../../detectors/threeFactor/components';
import { pxFn, pxKey, type PxC } from '../../../exec/board';
import { BadgePxC, type Badge } from '../../S1/clean/Badge';
import { ComponentPxC } from '../../componentPxC';

export interface TeeRingSearch {
	readonly enclosed: readonly TeeRing[];
	readonly elongated: readonly TeeRing[];
	readonly excludedByBadge: readonly TeeRing[];
	readonly candidates: readonly TeeRing[];
}

export interface TeeFrameMeasure {
	readonly ring: TeeRing;
	readonly frame: ComponentStats;
}

export interface TeeFamily {
	readonly measured: readonly TeeFrameMeasure[];
	readonly unframed: readonly TeeRing[];
	readonly members: readonly TeeFrameMeasure[];
	readonly anchor: TeeFrameMeasure | null;
}

interface DetectRingsArgs {
	readonly fields: BrightDarkComponentFields;
	readonly badges: readonly Badge[];
}

interface FindFamilyArgs {
	readonly rings: TeeRingSearch;
	readonly fields: BrightDarkComponentFields;
}

interface FindPxArgs {
	readonly member: TeeFrameMeasure;
	readonly fields: BrightDarkComponentFields;
}

interface FoundTeePx {
	readonly frame: RasterComponentRef;
	readonly px: Uint32Array;
}

export const TeePxC = {
	rings: pxKey<TeeRingSearch>('px.tees.rings'),
	family: pxKey<TeeFamily>('px.tees.family'),
	objects: pxKey<readonly Tee[]>('px.tees')
} as const;

export const TeeFn = {
	detectRings: pxFn<DetectRingsArgs, TeeRingSearch>('fn.Tee.detectRings'),
	findFamily: pxFn<FindFamilyArgs, TeeFamily>('fn.Tee.findFamily'),
	findPx: pxFn<FindPxArgs, FoundTeePx>('fn.Tee.findPx')
} as const;

const FRAME_AREA_MIN = 10;
const FRAME_AREA_MAX = 500;
const FRAME_MAX_WIDTH = 50;
const FRAME_MAX_HEIGHT = 50;
const MAJOR_RATIO = 1.25;
const MINOR_RATIO = 1.25;
const AREA_RATIO = 1.5;

function centerPixel(ring: TeeRing, width: number, height: number): number | null {
	const x = Math.round(ring.cx);
	const y = Math.round(ring.cy);
	return x >= 0 && y >= 0 && x < width && y < height ? y * width + x : null;
}

const detectRingsCalculation = ({ fields, badges }: DetectRingsArgs): TeeRingSearch => {
	const enclosed = detectTeeRings(fields.bright.mask);
	const elongated = enclosed.filter((ring) => ring.kind === 'tee-rect');
	const muted = new Set<number>();
	for (const badge of badges) for (const pixel of badge.has.mute.px) muted.add(pixel);
	const excludedByBadge: TeeRing[] = [];
	const candidates: TeeRing[] = [];
	for (const ring of elongated) {
		const pixel = centerPixel(ring, fields.bright.mask.width, fields.bright.mask.height);
		if (pixel !== null && muted.has(pixel)) excludedByBadge.push(ring);
		else candidates.push(ring);
	}
	return { enclosed, elongated, excludedByBadge, candidates };
};

function enclosingFrame(
	ring: TeeRing,
	components: readonly ComponentStats[]
): ComponentStats | null {
	return (
		components
			.filter(
				(component) =>
					component.area >= FRAME_AREA_MIN &&
					component.area <= FRAME_AREA_MAX &&
					component.bboxW <= FRAME_MAX_WIDTH &&
					component.bboxH <= FRAME_MAX_HEIGHT &&
					ring.cx >= component.bboxX &&
					ring.cx <= component.bboxX + component.bboxW &&
					ring.cy >= component.bboxY &&
					ring.cy <= component.bboxY + component.bboxH
			)
			.sort(
				(left, right) =>
					left.bboxW * left.bboxH - right.bboxW * right.bboxH ||
					right.area - left.area ||
					left.label - right.label
			)[0] ?? null
	);
}

function logRatio(left: number, right: number): number {
	return Math.abs(Math.log(Math.max(left, 1) / Math.max(right, 1)));
}

export function selectTeeFamily(
	measured: readonly TeeFrameMeasure[]
): { readonly members: readonly TeeFrameMeasure[]; readonly anchor: TeeFrameMeasure | null } {
	let members: readonly TeeFrameMeasure[] = [];
	let anchor: TeeFrameMeasure | null = null;
	let bestSpread = Infinity;
	for (const seed of measured) {
		const family = measured.filter(
			(candidate) =>
				logRatio(candidate.frame.major, seed.frame.major) <= Math.log(MAJOR_RATIO) &&
				logRatio(candidate.frame.minor, seed.frame.minor) <= Math.log(MINOR_RATIO) &&
				logRatio(candidate.frame.area, seed.frame.area) <= Math.log(AREA_RATIO)
		);
		const spread = family.reduce(
			(sum, candidate) =>
				sum +
				logRatio(candidate.frame.major, seed.frame.major) +
				logRatio(candidate.frame.minor, seed.frame.minor) +
				logRatio(candidate.frame.area, seed.frame.area),
			0
		);
		if (family.length > members.length || (family.length === members.length && spread < bestSpread)) {
			members = family;
			anchor = seed;
			bestSpread = spread;
		}
	}
	return {
		members: [...members].sort((left, right) => left.ring.cy - right.ring.cy || left.ring.cx - right.ring.cx),
		anchor
	};
}

const findFamilyCalculation = ({ rings, fields }: FindFamilyArgs): TeeFamily => {
	const measured: TeeFrameMeasure[] = [];
	const unframed: TeeRing[] = [];
	for (const ring of rings.candidates) {
		const frame = enclosingFrame(ring, fields.bright.components);
		if (frame) measured.push({ ring, frame });
		else unframed.push(ring);
	}
	const selected = selectTeeFamily(measured);
	return { measured, unframed, ...selected };
};

const findPxCalculation = ({ member, fields }: FindPxArgs): FoundTeePx => {
	const frame = componentRef('bright', member.frame);
	const raster: ComponentRasterEvidence = {
		width: fields.bright.mask.width,
		height: fields.bright.mask.height,
		topPx: 0,
		brightLabels: fields.bright.labels,
		darkLabels: fields.dark.labels
	};
	return { frame, px: materializeRasterComponentPixels(frame, raster) };
};

export function registerTee(pxc: PxC): void {
	pxc.register(TeeFn.detectRings, detectRingsCalculation);
	pxc.register(TeeFn.findFamily, findFamilyCalculation);
	pxc.register(TeeFn.findPx, findPxCalculation);
}

export interface TeeHas {
	readonly detectRings: {
		readonly fn: typeof TeeFn.detectRings.address;
		readonly hole: TeeRing;
	};
	readonly findFamily: {
		readonly fn: typeof TeeFn.findFamily.address;
		readonly frame: RasterComponentRef;
	};
	readonly findPx: {
		readonly fn: typeof TeeFn.findPx.address;
		readonly parts: readonly RasterComponentRef[];
	};
}

export class Tee {
	readonly center: readonly [number, number];
	readonly innerBbox: readonly [number, number, number, number];
	readonly bbox: readonly [number, number, number, number];
	readonly angleRad: number;
	readonly has: TeeHas;
	readonly px: Uint32Array;

	private constructor(member: TeeFrameMeasure, found: FoundTeePx) {
		this.center = [member.ring.cx, member.ring.cy];
		this.innerBbox = [
			member.ring.bboxX,
			member.ring.bboxY,
			member.ring.bboxW,
			member.ring.bboxH
		];
		this.bbox = found.frame.bbox;
		this.angleRad = member.frame.angle;
		this.px = found.px;
		this.has = {
			detectRings: { fn: TeeFn.detectRings.address, hole: member.ring },
			findFamily: { fn: TeeFn.findFamily.address, frame: found.frame },
			findPx: { fn: TeeFn.findPx.address, parts: [found.frame] }
		};
	}

	static detectRings(pxc: PxC): TeeRingSearch {
		return pxc.call(TeeFn.detectRings, {
			fields: pxc.get(ComponentPxC.fields),
			badges: pxc.get(BadgePxC.objects)
		});
	}

	static findFamily(pxc: PxC): TeeFamily {
		return pxc.call(TeeFn.findFamily, {
			rings: pxc.get(TeePxC.rings),
			fields: pxc.get(ComponentPxC.fields)
		});
	}

	static findPx(pxc: PxC): readonly Tee[] {
		const fields = pxc.get(ComponentPxC.fields);
		return pxc.get(TeePxC.family).members.map((member) => {
			const found = pxc.call(TeeFn.findPx, { member, fields });
			return new Tee(member, found);
		});
	}
}
