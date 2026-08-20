import {
	applySourceTransform,
	buildSourceTransform
} from '../domain/provenance';
import type {
	CompositePoint,
	DraftComposite,
	SourceCapture,
	SourceRasterPoint,
	SourceTransform
} from '../domain/provenance';
import { integerTranslationOf } from './renderComposite';

/**
 * Pure geometry for Stitch Map's alignment-review surface.
 *
 * Important coordinate contract:
 * - badge xPx/yPx are already physical-badge CENTERS in source-raster pixels;
 * - source transforms are always the pipeline's source-raster -> composite transforms;
 * - browser clipping/scrolling is not represented here. UI code must size one inner
 *   image/overlay plane to the raster aspect ratio, then clip only an outer viewport.
 */

export interface ImagePointPx {
	readonly xPx: number;
	readonly yPx: number;
}

export interface ImagePointPercent {
	readonly leftPct: number;
	readonly topPct: number;
}

/** Maps an image-space point directly onto the same-aspect-ratio render plane. */
export function imagePointPercent(
	point: ImagePointPx,
	outputWidthPx: number,
	outputHeightPx: number
): ImagePointPercent {
	return {
		leftPct: outputWidthPx > 0 ? (point.xPx / outputWidthPx) * 100 : 0,
		topPct: outputHeightPx > 0 ? (point.yPx / outputHeightPx) * 100 : 0
	};
}

export interface RenderedPlaneSize {
	readonly widthPx: number;
	readonly heightPx: number;
}

/**
 * Converts a pointer delta into composite pixels using the actual rendered image plane,
 * never an outer clipped viewport. This is what prevents tall-image Y compression.
 */
export function screenDeltaToImageDelta(
	delta: Readonly<{ xPx: number; yPx: number }>,
	plane: RenderedPlaneSize,
	outputWidthPx: number,
	outputHeightPx: number
): ImagePointPx {
	return {
		xPx: plane.widthPx > 0 ? (delta.xPx * outputWidthPx) / plane.widthPx : 0,
		yPx: plane.heightPx > 0 ? (delta.yPx * outputHeightPx) / plane.heightPx : 0
	};
}

function cropCorners(source: Pick<SourceCapture, 'crop'>): readonly SourceRasterPoint[] {
	const crop = source.crop;
	return [
		{ xPx: crop.xPx, yPx: crop.yPx },
		{ xPx: crop.xPx + crop.widthPx, yPx: crop.yPx },
		{ xPx: crop.xPx + crop.widthPx, yPx: crop.yPx + crop.heightPx },
		{ xPx: crop.xPx, yPx: crop.yPx + crop.heightPx }
	];
}

function translatedTransform(transform: SourceTransform, dxPx: number, dyPx: number): SourceTransform {
	const [a, b, c, d, e, f] = transform.coefficients;
	return buildSourceTransform(transform.model, [a, b, c, d, e + dxPx, f + dyPx]);
}

function withTransform(source: SourceCapture, transform: SourceTransform, markManual: boolean): SourceCapture {
	return {
		...source,
		transform,
		origin: markManual ? { ...source.origin, transform: 'manual' } : source.origin,
		coveragePolygon: cropCorners(source).map((corner) => applySourceTransform(corner, transform))
	};
}

function normalizedSources(sources: readonly SourceCapture[]): {
	readonly sources: readonly SourceCapture[];
	readonly outputWidthPx: number;
	readonly outputHeightPx: number;
} {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const source of sources) {
		for (const point of source.coveragePolygon) {
			minX = Math.min(minX, point.xPx);
			maxX = Math.max(maxX, point.xPx);
			minY = Math.min(minY, point.yPx);
			maxY = Math.max(maxY, point.yPx);
		}
	}
	const shiftX = -Math.floor(minX);
	const shiftY = -Math.floor(minY);
	const outputWidthPx = Math.ceil(maxX) - Math.floor(minX);
	const outputHeightPx = Math.ceil(maxY) - Math.floor(minY);
	return {
		sources: sources.map((source) =>
			withTransform(source, translatedTransform(source.transform, shiftX, shiftY), false)
		),
		outputWidthPx,
		outputHeightPx
	};
}

function withPaintOrder(sources: readonly SourceCapture[]): readonly SourceCapture[] {
	const ranked = sources.map((source, index) => ({
		index,
		key: Math.max(...source.coveragePolygon.map((point) => point.xPx + point.yPx))
	}));
	ranked.sort((a, b) => a.key - b.key || a.index - b.index);
	const order = new Map(ranked.map((entry, rank) => [entry.index, rank]));
	return sources.map((source, index) => ({ ...source, paintOrder: order.get(index)! }));
}

/**
 * Moves ANY contributing source by a composite-space delta while preserving the exact
 * linear terms of every stitch transform (rotation/scale/shear included). The whole
 * union is then normalized back to output origin exactly like stitchPipeline.ts.
 */
export function translateDraftSource(
	draft: DraftComposite,
	sourceId: string,
	delta: Readonly<{ xPx: number; yPx: number }>
): DraftComposite {
	if (!draft.sources.some((source) => source.sourceId === sourceId)) return draft;
	const moved = draft.sources.map((source) =>
		source.sourceId === sourceId
			? withTransform(source, translatedTransform(source.transform, delta.xPx, delta.yPx), true)
			: source
	);
	const normalized = normalizedSources(moved);
	const ordered = withPaintOrder(normalized.sources);
	return {
		...draft,
		outputWidthPx: normalized.outputWidthPx,
		outputHeightPx: normalized.outputHeightPx,
		resampling: ordered.every((source) => integerTranslationOf(source.transform) !== null)
			? 'none'
			: 'nearest',
		sources: ordered
	};
}

export interface SharedBadgeObservation {
	readonly sourceId: string;
	readonly holeNumber: number;
	/** Physical-badge center in this source raster. */
	readonly xPx: number;
	readonly yPx: number;
	readonly widthPx: number;
	readonly heightPx: number;
	readonly confidence: number;
}

export interface BadgeWitnessLayer {
	readonly sourceId: string;
	readonly observation: SharedBadgeObservation;
	/** Exact object from the current stitch draft; never independently estimated. */
	readonly sourceTransform: SourceTransform;
	readonly opacity: 0.5;
}

export interface BadgeAlignmentWitness {
	readonly holeNumber: number;
	readonly outputCenter: CompositePoint;
	readonly windowSizePx: number;
	readonly layers: readonly BadgeWitnessLayer[];
	readonly minConfidence: number;
}

/**
 * Groups labeled badge observations that occur in 2+ contributing captures and returns
 * the strongest few witnesses. Their layers retain the stitch's exact source transform;
 * the UI may add only a view/lens transform when drawing the magnified crop.
 */
export function deriveBadgeAlignmentWitnesses(
	draft: DraftComposite,
	observations: readonly SharedBadgeObservation[],
	maxWitnesses = 6
): readonly BadgeAlignmentWitness[] {
	const sourceById = new Map(draft.sources.map((source) => [source.sourceId, source]));
	const byHole = new Map<number, SharedBadgeObservation[]>();
	for (const observation of observations) {
		if (!Number.isInteger(observation.holeNumber) || observation.holeNumber <= 0) continue;
		if (!sourceById.has(observation.sourceId)) continue;
		const entries = byHole.get(observation.holeNumber) ?? [];
		if (!entries.some((entry) => entry.sourceId === observation.sourceId)) entries.push(observation);
		byHole.set(observation.holeNumber, entries);
	}

	const witnesses: BadgeAlignmentWitness[] = [];
	for (const [holeNumber, entries] of byHole) {
		if (entries.length < 2) continue;
		const mapped = entries.map((entry) => {
			const source = sourceById.get(entry.sourceId)!;
			return {
				entry,
				source,
				center: applySourceTransform({ xPx: entry.xPx, yPx: entry.yPx }, source.transform)
			};
		});
		const outputCenter = mapped.reduce(
			(acc, item) => ({ xPx: acc.xPx + item.center.xPx / mapped.length, yPx: acc.yPx + item.center.yPx / mapped.length }),
			{ xPx: 0, yPx: 0 }
		);
		const maxBadgeDimension = Math.max(...entries.map((entry) => Math.max(entry.widthPx, entry.heightPx)));
		witnesses.push({
			holeNumber,
			outputCenter,
			windowSizePx: Math.max(48, maxBadgeDimension * 2.5),
			layers: mapped.map(({ entry, source }) => ({
				sourceId: entry.sourceId,
				observation: entry,
				sourceTransform: source.transform,
				opacity: 0.5
			})),
			minConfidence: Math.min(...entries.map((entry) => entry.confidence))
		});
	}
	return witnesses
		.sort((a, b) => b.layers.length - a.layers.length || b.minConfidence - a.minConfidence || a.holeNumber - b.holeNumber)
		.slice(0, Math.max(0, maxWitnesses));
}

export interface FloatingRectPosition {
	readonly xPx: number;
	readonly yPx: number;
}

export function clampFloatingRect(
	position: FloatingRectPosition,
	rect: Readonly<{ widthPx: number; heightPx: number }>,
	viewport: Readonly<{ widthPx: number; heightPx: number }>,
	marginPx = 8
): FloatingRectPosition {
	const maxX = Math.max(marginPx, viewport.widthPx - rect.widthPx - marginPx);
	const maxY = Math.max(marginPx, viewport.heightPx - rect.heightPx - marginPx);
	return {
		xPx: Math.min(maxX, Math.max(marginPx, position.xPx)),
		yPx: Math.min(maxY, Math.max(marginPx, position.yPx))
	};
}
