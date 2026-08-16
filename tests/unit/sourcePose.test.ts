import { describe, expect, it } from 'vitest';
import {
	compositePointFromSource,
	queryContributingSources,
	queryContributingSourcesForRegion,
	rotationDegreesForTransform,
	sourcePointFromComposite
} from '../../src/lib/autoAnnotation/sourcePose';
import { assertCoherentProvenance, buildSourceTransform } from '../../src/lib/domain/provenance';
import {
	centeredSimilarityTransform,
	compositeProvenanceFixture,
	similaritySourceTransform,
	sourceCaptureFixture
} from '../helpers/provenanceFixtures';

describe('queryContributingSources', () => {
	it('returns an unconstrained signal (not an empty list) when provenance is absent -- distinguishable from "no source contributes here"', () => {
		expect(queryContributingSources(undefined, { xPx: 10, yPx: 10 })).toEqual({
			kind: 'unconstrained',
			reason: 'no-provenance'
		});
		expect(queryContributingSources(null, { xPx: 10, yPx: 10 })).toEqual({
			kind: 'unconstrained',
			reason: 'no-provenance'
		});
	});

	it('returns exactly the one source covering a point outside any overlap', () => {
		const a = sourceCaptureFixture({
			sourceId: 'a',
			widthPx: 100,
			heightPx: 100,
			crop: { xPx: 0, yPx: 0, widthPx: 100, heightPx: 80 },
			transform: similaritySourceTransform(0, 1, 0, 0),
			paintOrder: 0
		});
		const b = sourceCaptureFixture({
			sourceId: 'b',
			widthPx: 100,
			heightPx: 100,
			crop: { xPx: 0, yPx: 0, widthPx: 100, heightPx: 80 },
			transform: similaritySourceTransform(30, 1, 2000, 2000),
			paintOrder: 1
		});
		const provenance = compositeProvenanceFixture([a, b], { compositingPolicy: 'stitch-ascending-bottom-right-v1' });

		const query = queryContributingSources(provenance, { xPx: 50, yPx: 40 });
		expect(query.kind).toBe('contributors');
		if (query.kind !== 'contributors') throw new Error('unreachable');
		expect(query.contributors.map((c) => c.sourceId)).toEqual(['a']);
		expect(query.contributors[0].rotationDeg).toBeCloseTo(0, 5);
	});

	it('returns an empty contributors list (never "unconstrained") for a point definitely outside every source', () => {
		const a = sourceCaptureFixture({
			sourceId: 'a',
			widthPx: 100,
			heightPx: 100,
			crop: { xPx: 0, yPx: 0, widthPx: 100, heightPx: 80 },
			transform: similaritySourceTransform(0, 1, 0, 0),
			paintOrder: 0
		});
		const provenance = compositeProvenanceFixture([a]);

		const query = queryContributingSources(provenance, { xPx: 100000, yPx: 100000 });
		expect(query).toEqual({ kind: 'contributors', contributors: [] });
	});

	it('admits ALL contributing sources at an overlap region, each with its own distinct pose -- not just the first/arbitrary one', () => {
		const shared = { xPx: 500, yPx: 500 };
		const cropA = { xPx: 0, yPx: 0, widthPx: 200, heightPx: 160 };
		const cropB = { xPx: 0, yPx: 0, widthPx: 220, heightPx: 180 };
		const cropC = { xPx: 10, yPx: 10, widthPx: 180, heightPx: 150 };

		const a = sourceCaptureFixture({
			sourceId: 'a-upright',
			widthPx: 300,
			heightPx: 300,
			crop: cropA,
			transform: centeredSimilarityTransform(0, 1, cropA, shared),
			paintOrder: 0
		});
		const b = sourceCaptureFixture({
			sourceId: 'b-rotated-30',
			widthPx: 300,
			heightPx: 300,
			crop: cropB,
			transform: centeredSimilarityTransform(30, 1.1, cropB, shared),
			paintOrder: 1
		});
		const c = sourceCaptureFixture({
			sourceId: 'c-rotated-neg45-scaled',
			widthPx: 300,
			heightPx: 300,
			crop: cropC,
			transform: centeredSimilarityTransform(-45, 1.3, cropC, shared),
			paintOrder: 2
		});
		const provenance = compositeProvenanceFixture([a, b, c]);
		// The fixture itself must be internally coherent (coveragePolygon really
		// does equal transform(crop), paintOrder really is a permutation) --
		// otherwise this test would be validating a broken fixture, not the
		// pose-query API.
		expect(() => assertCoherentProvenance(provenance)).not.toThrow();

		const query = queryContributingSources(provenance, shared);
		expect(query.kind).toBe('contributors');
		if (query.kind !== 'contributors') throw new Error('unreachable');
		expect(query.contributors.map((contributor) => contributor.sourceId)).toEqual([
			'a-upright',
			'b-rotated-30',
			'c-rotated-neg45-scaled'
		]);

		const byId = new Map(query.contributors.map((contributor) => [contributor.sourceId, contributor]));
		expect(byId.get('a-upright')!.rotationDeg).toBeCloseTo(0, 5);
		expect(byId.get('b-rotated-30')!.rotationDeg).toBeCloseTo(30, 5);
		expect(byId.get('b-rotated-30')!.approxScale).toBeCloseTo(1.1, 5);
		expect(byId.get('c-rotated-neg45-scaled')!.rotationDeg).toBeCloseTo(315, 5);
		expect(byId.get('c-rotated-neg45-scaled')!.approxScale).toBeCloseTo(1.3, 5);

		// The three poses are genuinely different, not one pose reported three times.
		const rotations = query.contributors.map((contributor) => contributor.rotationDeg).sort((x, y) => x - y);
		expect(new Set(rotations.map((value) => Math.round(value)))).toEqual(new Set([0, 30, 315]));
	});
});

describe('queryContributingSourcesForRegion', () => {
	it('returns both sources when a search region straddles the shared edge of two adjacent (non-overlapping-at-a-point) coverage polygons', () => {
		const left = sourceCaptureFixture({
			sourceId: 'left',
			widthPx: 100,
			heightPx: 100,
			crop: { xPx: 0, yPx: 0, widthPx: 100, heightPx: 100 },
			transform: similaritySourceTransform(0, 1, 0, 0),
			paintOrder: 0
		});
		const right = sourceCaptureFixture({
			sourceId: 'right',
			widthPx: 100,
			heightPx: 100,
			crop: { xPx: 0, yPx: 0, widthPx: 100, heightPx: 100 },
			transform: similaritySourceTransform(0, 1, 100, 0),
			paintOrder: 1
		});
		const provenance = compositeProvenanceFixture([left, right], { compositingPolicy: 'stitch-ascending-bottom-right-v1' });

		// A point exactly on the seam belongs to neither polygon's open interior in a plain
		// ray-cast test, but a small region straddling the seam genuinely overlaps both.
		const straddling = queryContributingSourcesForRegion(provenance, { xPx: 95, yPx: 40, widthPx: 10, heightPx: 10 });
		expect(straddling.kind).toBe('contributors');
		if (straddling.kind !== 'contributors') throw new Error('unreachable');
		expect(straddling.contributors.map((c) => c.sourceId).sort()).toEqual(['left', 'right']);

		const leftOnly = queryContributingSourcesForRegion(provenance, { xPx: 10, yPx: 10, widthPx: 10, heightPx: 10 });
		if (leftOnly.kind !== 'contributors') throw new Error('unreachable');
		expect(leftOnly.contributors.map((c) => c.sourceId)).toEqual(['left']);
	});

	it('returns unconstrained for a region query with no provenance, matching the point-query contract', () => {
		expect(queryContributingSourcesForRegion(undefined, { xPx: 0, yPx: 0, widthPx: 5, heightPx: 5 })).toEqual({
			kind: 'unconstrained',
			reason: 'no-provenance'
		});
	});
});

describe('sourcePointFromComposite / compositePointFromSource', () => {
	it('round-trips a source-raster point through a rotated + scaled transform', () => {
		const transform = similaritySourceTransform(37, 1.4, 300, 150);
		const contributor = { transform };
		const sourcePoint = { xPx: 22, yPx: 9 };
		const compositePoint = compositePointFromSource(sourcePoint, contributor);
		const recovered = sourcePointFromComposite(compositePoint, contributor);
		expect(recovered).not.toBeNull();
		expect(recovered!.xPx).toBeCloseTo(sourcePoint.xPx, 6);
		expect(recovered!.yPx).toBeCloseTo(sourcePoint.yPx, 6);
	});

	it('returns null (never an invented approximate mapping) when the transform is not invertible', () => {
		const singular = buildSourceTransform('affine', [1, 0, 0, 0, 0, 0]);
		expect(singular.isInvertible).toBe(false);
		const result = sourcePointFromComposite({ xPx: 5, yPx: 5 }, { transform: singular });
		expect(result).toBeNull();
	});
});

describe('rotationDegreesForTransform', () => {
	it('is 0 for an identity/translation-only transform', () => {
		expect(rotationDegreesForTransform(similaritySourceTransform(0, 1, 40, -20))).toBeCloseTo(0, 6);
	});

	it('recovers a positive rotation exactly', () => {
		expect(rotationDegreesForTransform(similaritySourceTransform(72, 2, 0, 0))).toBeCloseTo(72, 6);
	});

	it('normalizes a negative rotation into [0, 360)', () => {
		expect(rotationDegreesForTransform(similaritySourceTransform(-10, 1, 0, 0))).toBeCloseTo(350, 6);
	});
});
