import { describe, expect, it } from 'vitest';
import { createControlPointPair, createImageAsset, createProjectState } from '../../src/lib/domain/project';
import type { ControlPointPair, ImageAsset, PointCoordinates } from '../../src/lib/domain/project';
import {
	CLUSTERED_MIN_NORM_SPAN,
	NEAR_DUPLICATE_MIN_DISTANCE_PX,
	SIMILARITY_MIN_PAIRS,
	AFFINE_MIN_PAIRS,
	countText,
	coverageDiagnostic,
	coverageWarningText,
	deriveDiagnostics,
	derivePairCounts,
	deriveReadiness,
	diagnosticsCopy,
	imageDiagnostics,
	nearDuplicateDiagnostic,
	nearDuplicateWarningText,
	readinessText
} from '../../src/lib/diagnostics';

const NOW = () => new Date('2026-08-03T00:00:00.000Z');

function sourceImage(widthPx = 1000, heightPx = 1000): ImageAsset {
	return createImageAsset({
		id: 'source-1',
		role: 'source-overview',
		fileName: 'source.png',
		mimeType: 'image/png',
		widthPx,
		heightPx
	});
}

function targetImage(widthPx = 1000, heightPx = 1000): ImageAsset {
	return createImageAsset({
		id: 'target-1',
		role: 'target-basemap',
		fileName: 'target.png',
		mimeType: 'image/png',
		widthPx,
		heightPx
	});
}

function pair(
	id: string,
	ordinal: number,
	source: ImageAsset,
	target: ImageAsset,
	sourcePoint: PointCoordinates,
	targetPoint: PointCoordinates
): ControlPointPair {
	return createControlPointPair({
		id,
		ordinal,
		sourceImage: source,
		targetImage: target,
		sourceCoordinates: sourcePoint,
		targetCoordinates: targetPoint,
		now: NOW
	});
}

function point(xPx: number, yPx: number): PointCoordinates {
	return { xPx, yPx };
}

describe('P0-012 pair counts', () => {
	it('distinguishes durable complete pairs from the transient pending half-pair', () => {
		expect(derivePairCounts([], false)).toEqual({ complete: 0, pending: 0 });
		expect(derivePairCounts([], true)).toEqual({ complete: 0, pending: 1 });
		expect(derivePairCounts([{ ordinal: 1 }, { ordinal: 2 }], false)).toEqual({
			complete: 2,
			pending: 0
		});
		expect(derivePairCounts([{ ordinal: 1 }], true)).toEqual({ complete: 1, pending: 1 });
	});

	it('renders count copy that never merges pending into complete', () => {
		expect(countText({ complete: 0, pending: 0 })).toBe('0 complete pairs');
		expect(countText({ complete: 1, pending: 0 })).toBe('1 complete pair');
		expect(countText({ complete: 2, pending: 1 })).toBe('2 complete pairs · 1 pending point');
	});
});

describe('P0-012 readiness thresholds', () => {
	it('derives similarity at 2 complete pairs and affine at 3', () => {
		expect(SIMILARITY_MIN_PAIRS).toBe(2);
		expect(AFFINE_MIN_PAIRS).toBe(3);
		expect(deriveReadiness(0)).toEqual({ similarityReady: false, affineReady: false });
		expect(deriveReadiness(1)).toEqual({ similarityReady: false, affineReady: false });
		expect(deriveReadiness(2)).toEqual({ similarityReady: true, affineReady: false });
		expect(deriveReadiness(3)).toEqual({ similarityReady: true, affineReady: true });
	});

	it('rejects a non-integer or negative count deterministically', () => {
		expect(() => deriveReadiness(1.5)).toThrow();
		expect(() => deriveReadiness(-1)).toThrow();
	});

	it('changes readiness copy exactly at the documented thresholds', () => {
		expect(readinessText(0)).toBe(
			`A future similarity registration will need ${SIMILARITY_MIN_PAIRS} complete pairs.`
		);
		expect(readinessText(1)).toBe(
			`A future similarity registration will need ${SIMILARITY_MIN_PAIRS} complete pairs.`
		);
		expect(readinessText(2)).toBe(
			`Enough complete pairs (2) for a future similarity registration.`
		);
		expect(readinessText(3)).toBe(
			`Enough complete pairs (3) for a future affine registration.`
		);
		expect(readinessText(5)).toBe(
			`Enough complete pairs (5) for a future affine registration.`
		);
	});

	it('never claims geometric suitability, alignment, or a transform in copy', () => {
		for (const text of [readinessText(0), readinessText(2), readinessText(3)]) {
			expect(text).not.toMatch(/suitab|align|transform|residual|homograph/i);
		}
	});
});

describe('P0-012 clustered-coverage diagnostics', () => {
	it('warns only when both normalized span axes are below the documented threshold', () => {
		expect(CLUSTERED_MIN_NORM_SPAN).toBe(0.4);
		// Exactly at the threshold boundary on one axis: not clustered (>= threshold).
		const boundary = coverageDiagnostic([point(0, 0), point(CLUSTERED_MIN_NORM_SPAN * 1000, 0)], 1000, 1000);
		expect(boundary.clustered).toBe(false);
		expect(boundary.normSpanX).toBeCloseTo(CLUSTERED_MIN_NORM_SPAN, 12);
		expect(boundary.normSpanY).toBe(0);
		// Just below the threshold on both axes: clustered.
		const clustered = coverageDiagnostic(
			[point(0, 0), point(CLUSTERED_MIN_NORM_SPAN * 1000 - 1, CLUSTERED_MIN_NORM_SPAN * 1000 - 1)],
			1000,
			1000
		);
		expect(clustered.clustered).toBe(true);
		// Distributed corners: not clustered.
		const distributed = coverageDiagnostic([point(0, 0), point(999, 999)], 1000, 1000);
		expect(distributed.clustered).toBe(false);
		expect(distributed.normSpanX).toBeCloseTo(0.999, 12);
		expect(distributed.normSpanY).toBeCloseTo(0.999, 12);
	});

	it('cannot assess fewer than two points and reports null spans', () => {
		for (const points of [[], [point(10, 10)]]) {
			const result = coverageDiagnostic(points, 1000, 1000);
			expect(result.clustered).toBe(false);
			expect(result.normSpanX).toBeNull();
			expect(result.normSpanY).toBeNull();
		}
	});

	it('rejects non-positive image dimensions deterministically', () => {
		expect(() => coverageDiagnostic([point(0, 0), point(1, 1)], 0, 1000)).toThrow();
	});

	it('produces non-blocking warning copy only for clustered fixtures', () => {
		const clustered = coverageDiagnostic([point(10, 10), point(20, 20)], 1000, 1000);
		const warning = coverageWarningText('UDisc source', clustered);
		expect(warning).toMatch(/UDisc source: coverage warning/);
		expect(warning).toContain('%');
		expect(coverageWarningText('UDisc source', coverageDiagnostic([point(0, 0), point(900, 900)], 1000, 1000))).toBeNull();
	});
});

describe('P0-012 near-duplicate diagnostics', () => {
	it('warns when two points are closer than the documented image-space distance', () => {
		expect(NEAR_DUPLICATE_MIN_DISTANCE_PX).toBe(12);
		// Exactly at the threshold boundary: not a near duplicate (>= threshold).
		const boundary = nearDuplicateDiagnostic([point(0, 0), point(NEAR_DUPLICATE_MIN_DISTANCE_PX, 0)]);
		expect(boundary.nearDuplicate).toBe(false);
		expect(boundary.minDistancePx).toBe(NEAR_DUPLICATE_MIN_DISTANCE_PX);
		// Just below the threshold: near duplicate.
		const near = nearDuplicateDiagnostic([point(0, 0), point(NEAR_DUPLICATE_MIN_DISTANCE_PX - 0.1, 0)]);
		expect(near.nearDuplicate).toBe(true);
		// A spread pair is fine.
		expect(nearDuplicateDiagnostic([point(0, 0), point(500, 500)]).nearDuplicate).toBe(false);
	});

	it('cannot assess fewer than two points', () => {
		const result = nearDuplicateDiagnostic([point(5, 5)]);
		expect(result.minDistancePx).toBeNull();
		expect(result.ordinals).toBeNull();
		expect(result.nearDuplicate).toBe(false);
	});

	it('maps the closest pair to their ordinals for per-image diagnostics', () => {
		const source = sourceImage();
		const target = targetImage();
		const pairs = [
			pair('pair-1', 1, source, target, point(10, 10), point(100, 100)),
			pair('pair-2', 2, source, target, point(16, 10), point(200, 200)),
			pair('pair-3', 3, source, target, point(400, 400), point(300, 300))
		];
		const diagnostics = imageDiagnostics(pairs, source);
		expect(diagnostics.nearDuplicate.nearDuplicate).toBe(true);
		expect(diagnostics.nearDuplicate.ordinals).toEqual([1, 2]);
		expect(diagnostics.coverage.pointCount).toBe(3);
	});

	it('produces non-blocking warning copy only for close fixtures', () => {
		const near = nearDuplicateDiagnostic([point(10, 10), point(18, 10)]);
		expect(nearDuplicateWarningText('Clean target', near)).toMatch(/Clean target: near-duplicate warning/);
		expect(nearDuplicateWarningText('Clean target', nearDuplicateDiagnostic([point(0, 0), point(400, 400)]))).toBeNull();
	});
});

describe('P0-012 integrated summary', () => {
	it('excludes the pending half-pair from durable per-image diagnostics', () => {
		const source = sourceImage();
		const target = targetImage();
		const pairs = [
			pair('pair-1', 1, source, target, point(20, 20), point(40, 40)),
			pair('pair-2', 2, source, target, point(500, 500), point(600, 600))
		];
		const base = createProjectState({ createId: () => 'project-1', now: NOW });
		const images = [source, target];

		const noPending = deriveDiagnostics(pairs, images, false);
		const withPending = deriveDiagnostics(pairs, images, true);

		// Only the transient pending count changes; durable per-image point counts stay 2.
		expect(withPending.counts).toEqual({ complete: 2, pending: 1 });
		expect(noPending.counts).toEqual({ complete: 2, pending: 0 });
		expect(withPending.source.coverage.pointCount).toBe(2);
		expect(withPending.source.nearDuplicate.pointCount).toBe(2);
		expect(withPending.target.coverage.pointCount).toBe(2);

		// Without images, diagnostics fall back to empty without throwing.
		const empty = deriveDiagnostics([], [], true);
		expect(empty.counts).toEqual({ complete: 0, pending: 1 });
		expect(empty.source.coverage.pointCount).toBe(0);
		expect(empty.source.nearDuplicate.ordinals).toBeNull();
		expect(empty.target.coverage.pointCount).toBe(0);

		const copy = diagnosticsCopy(withPending);
		expect(copy.count).toBe('2 complete pairs · 1 pending point');
		expect(copy.readiness).toContain('similarity');
		expect(copy.warnings).toEqual([]);
		expect(base.controlPointPairs).toEqual([]);
	});
});
