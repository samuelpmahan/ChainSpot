import type { BadgeEvidence, BasketEvidence, TeeEvidence, ThreeFactorMeasurement } from './types';

export type RasterOwnership = {
	readonly bbox: readonly [number, number, number, number];
	readonly detectorId: string;
	readonly kind: 'observed' | 'fitted';
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
			raster: { detectorId: evidence.detId, bbox: evidence.bbox, kind: evidence.tier === 'recovered' ? 'fitted' : 'observed' },
			evidence
		})),
		occlusions: []
	};
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