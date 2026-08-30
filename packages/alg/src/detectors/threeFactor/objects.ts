import type { ComponentStats } from './components';
import {
	assembleBadgeV1,
	assembleBasketV1,
	assembleTeeV1,
	learnBasketShellFamilyV1,
	type ComponentAssembly,
	type ComponentAssemblyFailure,
	type ComponentAssemblyResult
} from './componentAssembly';
import type { BadgeEvidence, BasketEvidence, TeeEvidence, ThreeFactorMeasurement } from './types';

export type RasterOwnership = {
	readonly bbox: readonly [number, number, number, number];
	readonly detectorId: string;
	readonly kind: 'observed' | 'fitted';
	/**
	 * Present on component-backed acquisition. `failed` is deliberately
	 * first-class: downstream code must not quietly reinterpret detector/fitted
	 * geometry as the physical object perimeter.
	 */
	readonly componentAssembly?: ComponentAssemblyResult;
};

export interface Badge {
	readonly kind: 'badge';
	readonly id: string;
	readonly raster: RasterOwnership;
	readonly evidence: BadgeEvidence;
}

export interface Basket {
	readonly kind: 'basket';
	readonly id: string;
	readonly raster: RasterOwnership;
	readonly evidence: BasketEvidence;
}

export interface Tee {
	readonly kind: 'tee';
	readonly id: string;
	readonly raster: RasterOwnership;
	readonly evidence: TeeEvidence;
}

export type CourseObject = Badge | Basket | Tee;

export interface Occlusion {
	readonly kind: 'occlusion';
	readonly occluderId: string;
	readonly occludedId: string;
	readonly evidence: {
		readonly basis: 'alpha-mask' | 'pixel-support';
		readonly visiblePixels: number;
		readonly occludedPixels: number;
		readonly note: string;
	};
}

/** The stable object seam: base objects keep only their own measured support. */
export interface ObjectGraph {
	readonly badges: readonly Badge[];
	readonly baskets: readonly Basket[];
	readonly tees: readonly Tee[];
	readonly occlusions: readonly Occlusion[];
}

/**
 * The component sets are stage evidence already computed by badgeStage. V1
 * explicitly requires callers to hand them in; acquisition never re-thresholds
 * pixels or re-extracts connected components behind the caller's back.
 */
export interface ObjectComponentEvidence {
	readonly brightComponents: readonly ComponentStats[];
	readonly darkComponents: readonly ComponentStats[];
}

function failure(
	seedBbox: readonly [number, number, number, number],
	reason: string
): ComponentAssemblyFailure {
	return { status: 'failed', seedBbox, reason };
}

function rasterFromAssembly(
	detectorId: string,
	fallbackBbox: readonly [number, number, number, number],
	fallbackKind: 'observed' | 'fitted',
	assembly: ComponentAssemblyResult
): RasterOwnership {
	return {
		detectorId,
		bbox: assembly.status === 'assembled' ? assembly.bbox : fallbackBbox,
		kind: assembly.status === 'assembled' ? 'observed' : fallbackKind,
		componentAssembly: assembly
	};
}

function sourceComponentLabel(source: string | undefined): number | null {
	if (!source) return null;
	const match = /^bright-component:(-?\d+)$/.exec(source);
	return match ? Number(match[1]) : null;
}

/**
 * V1 component-backed root-object acquisition.
 *
 * Clean badges/tees use their bright outer CC. Clean baskets use their bright
 * body plus the exact modal enclosing dark-shell CC. Recovery/overlap cases
 * remain root objects for detector testimony, but their componentAssembly is
 * FAILED instead of fabricating a perimeter. Consumers that need a physical
 * object must call requireComponentAssembly().
 */
export function acquireObjectGraphV1(
	measurement: ThreeFactorMeasurement,
	components: ObjectComponentEvidence
): ObjectGraph {
	const { brightComponents, darkComponents } = components;
	const brightByLabel = new Map(brightComponents.map((component) => [component.label, component] as const));
	const topPx = measurement.viewport.topPx;

	const basketBodies = measurement.baskets.flatMap((evidence) => {
		if (evidence.tier === 'occlusion-recovery') return [];
		const label = sourceComponentLabel(evidence.source);
		const component = label === null ? undefined : brightByLabel.get(label);
		return component ? [component] : [];
	});
	const basketShellFamily = learnBasketShellFamilyV1(basketBodies, darkComponents);

	return {
		badges: measurement.badges.map((evidence) => {
			let assembly: ComponentAssemblyResult;
			if (evidence.source !== 'bright-family') {
				assembly = failure(
					evidence.bbox,
					'dark-plate recovery has no trustworthy intact outer bright component in object-perimeter V1'
				);
			} else {
				const outer = brightByLabel.get(evidence.component.label);
				assembly = outer
					? assembleBadgeV1(outer, brightComponents, darkComponents, topPx)
					: failure(evidence.bbox, `badge outer bright component ${evidence.component.label} is unavailable`);
			}
			return {
				kind: 'badge' as const,
				id: evidence.detId,
				raster: rasterFromAssembly(evidence.detId, evidence.bbox, 'observed', assembly),
				evidence
			};
		}),
		baskets: measurement.baskets.map((evidence) => {
			let assembly: ComponentAssemblyResult;
			const label = sourceComponentLabel(evidence.source);
			const body = label === null ? undefined : brightByLabel.get(label);
			if (evidence.tier === 'occlusion-recovery' || !body) {
				assembly = failure(
					evidence.bbox,
					'accepted basket has no intact bright body component; overlap/recovery is object-perimeter V2'
				);
			} else if (!basketShellFamily) {
				assembly = failure(evidence.bbox, 'no unique intact basket outer-shell component family exists in this run');
			} else {
				assembly = assembleBasketV1(body, darkComponents, basketShellFamily, topPx);
			}
			return {
				kind: 'basket' as const,
				id: evidence.detId,
				raster: rasterFromAssembly(evidence.detId, evidence.bbox, 'fitted', assembly),
				evidence
			};
		}),
		tees: measurement.tees.map((evidence) => {
			let assembly: ComponentAssemblyResult;
			const component = evidence.pad ? brightByLabel.get(evidence.pad.componentLabel) : undefined;
			if (evidence.tier === 'recovered' || !component) {
				assembly = failure(
					evidence.bbox,
					evidence.tier === 'recovered'
						? 'recovered/occluded tee has no intact outer bright component; object-perimeter V2'
						: 'tee has no accepted intact outer bright component'
				);
			} else {
				assembly = assembleTeeV1(component, topPx);
			}
			return {
				kind: 'tee' as const,
				id: evidence.detId,
				raster: rasterFromAssembly(
					evidence.detId,
					evidence.bbox,
					evidence.tier === 'recovered' ? 'fitted' : 'observed',
					assembly
				),
				evidence
			};
		}),
		occlusions: []
	};
}

/**
 * Legacy adapter retained while consumers migrate. It carries detector/fitted
 * boxes only and therefore must not be used when exact object ownership is
 * required. New physical-object consumers should use acquireObjectGraphV1.
 */
export function objectGraph(measurement: ThreeFactorMeasurement): ObjectGraph {
	return {
		badges: measurement.badges.map((evidence) => ({
			kind: 'badge',
			id: evidence.detId,
			raster: { detectorId: evidence.detId, bbox: evidence.bbox, kind: 'observed' },
			evidence
		})),
		baskets: measurement.baskets.map((evidence) => ({
			kind: 'basket',
			id: evidence.detId,
			raster: { detectorId: evidence.detId, bbox: evidence.bbox, kind: 'fitted' },
			evidence
		})),
		tees: measurement.tees.map((evidence) => ({
			kind: 'tee',
			id: evidence.detId,
			raster: {
				detectorId: evidence.detId,
				bbox: evidence.bbox,
				kind: evidence.tier === 'recovered' ? 'fitted' : 'observed'
			},
			evidence
		})),
		occlusions: []
	};
}

export function requireComponentAssembly(object: CourseObject): ComponentAssembly {
	const assembly = object.raster.componentAssembly;
	if (!assembly)
		throw new Error(`${object.kind} ${object.id} has legacy detector geometry, not component-backed ownership.`);
	if (assembly.status === 'failed')
		throw new Error(`${object.kind} ${object.id} component assembly failed: ${assembly.reason}`);
	return assembly;
}

export function occlude(graph: ObjectGraph, relation: Occlusion): ObjectGraph {
	const known = new Set([...graph.badges, ...graph.baskets, ...graph.tees].map((object) => object.id));
	if (!known.has(relation.occluderId) || !known.has(relation.occludedId))
		throw new Error('Occlusion endpoints must be existing root objects.');
	if (relation.occluderId === relation.occludedId) throw new Error('An object cannot occlude itself.');
	if (relation.evidence.visiblePixels < 0 || relation.evidence.occludedPixels < 0)
		throw new Error('Occlusion pixel counts must be non-negative.');
	return { ...graph, occlusions: [...graph.occlusions, relation] };
}
