import { describe, expect, it } from 'vitest';
import type { RgbaRaster, DetectorEmission } from '@chainspot/alg/detect';
import {
	emitThreeFactorRun,
	objectGraph,
	insertRecoveredEndpoints,
	measureThreeFactor,
	runThreeFactor,
	THREE_FACTOR_ALGO,
	THREE_FACTOR_ALGO_VERSION,
	type ThreeFactorRun
} from '@chainspot/alg/detectors/threeFactor';
import type {
	BadgeEvidence,
	BasketEvidence,
	CorridorParams,
	SupportFieldEvidence,
	TeeEvidence,
	ThreeFactorMeasurement
} from '@chainspot/alg/detectors/threeFactor/types';

const FAST_PARAMS = {
	corridorWidthPx: 24,
	fieldScale: 8,
	orientations: 4,
	widthsSrc: [8],
	patchBadges: false,
	alignmentPower: 2,
	worstWindowSrcPx: 16,
	supportTau: 0.12
} as const;

function raster(widthPx = 96, heightPx = 96): RgbaRaster {
	return {
		imageId: 'a'.repeat(64),
		widthPx,
		heightPx,
		rgba: new Uint8ClampedArray(widthPx * heightPx * 4)
	};
}

function rasterWithBadge(): RgbaRaster {
	const image = raster(64, 64);
	const rgba = image.rgba.slice();
	for (let y = 32; y < 46; y++) {
		for (let x = 10; x < 30; x++) {
			const border = x < 12 || x >= 28 || y < 34 || y >= 44;
			if (!border) continue;
			const p = (y * image.widthPx + x) * 4;
			rgba[p] = 255;
			rgba[p + 1] = 255;
			rgba[p + 2] = 255;
			rgba[p + 3] = 255;
		}
	}
	return { ...image, rgba };
}

function parameters(): CorridorParams {
	return {
		corridorWidthPx: 24,
		fieldScale: 1,
		orientations: 4,
		widthsSrc: [8],
		patchBadges: false,
		alignmentPower: 2,
		worstWindowSrcPx: 4,
		supportTau: 0.12
	};
}

function field(): SupportFieldEvidence {
	return {
		width: 32,
		height: 32,
		scale: 1,
		support: new Float32Array(32 * 32).fill(1),
		bestTheta: new Float32Array(32 * 32),
		parameters: {
			orientations: 4,
			widthsSrc: [8],
			gaussianSigma: 0.8,
			normalizationPercentile: 0.995,
			gamma: 0.7
		}
	};
}

function badge(): BadgeEvidence {
	return {
		detId: 'badge-0',
		component: {
			label: 1,
			cx: 8,
			cy: 8,
			area: 20,
			bboxX: 6,
			bboxY: 6,
			bboxW: 5,
			bboxH: 5,
			major: 5,
			minor: 4,
			angle: 0,
			fill: 0.8
		},
		cxPx: 8,
		cyPx: 8,
		bbox: [6, 6, 5, 5],
		source: 'bright-family',
		digits: [],
		label: '1',
		labelCandidates: [
			{ label: 1, confidence: 0.9 },
			{ label: 7, confidence: 0.1 }
		],
		confidence: 0.9
	};
}

function basket(): BasketEvidence {
	return {
		detId: 'basket-0',
		bbox: [20, 6, 6, 8],
		centerXPx: 23,
		centerYPx: 10,
		tipXPx: 23,
		tipYPx: 14,
		onFrac: 0.95,
		offFrac: 0.05,
		score: 0.9
	};
}

function tee(): TeeEvidence {
	return {
		detId: 'tee-0',
		xPx: 8,
		yPx: 14,
		tier: 'ring',
		angleRad: 0.2,
		ring: {
			bbox: [6, 12, 5, 5],
			area: 12,
			elongation: 1.1,
			ringFrac: 0.85
		},
		bbox: [6, 12, 5, 5],
		area: 12,
		fill: 0.7,
		onRing: true
	};
}

function measurement(): ThreeFactorMeasurement {
	return {
		algo: THREE_FACTOR_ALGO,
		algoVersion: THREE_FACTOR_ALGO_VERSION,
		widthPx: 32,
		heightPx: 32,
		viewport: { topPx: 0, bottomPx: 32, sourceFrame: 'original-image' },
		parameters: parameters(),
		brightMask: { width: 32, height: 32, data: new Uint8Array(32 * 32) },
		darkMask: { width: 32, height: 32, data: new Uint8Array(32 * 32) },
		badges: [badge()],
		baskets: [basket()],
		tees: [tee()],
		field: field(),
		rawPairs: []
	};
}

function emissionsFor(run: ThreeFactorRun): DetectorEmission[] {
	const emissions: DetectorEmission[] = [];
	emitThreeFactorRun({ ...raster(32, 32), imageId: run.imageId }, run, (event) =>
		emissions.push(event)
	);
	return emissions;
}

describe('three-factor root object graph', () => {
	it('keeps detector-owned raster support immutable and records occlusion separately', async () => {
		const { occlude } = await import('@chainspot/alg/detectors/threeFactor');
		const measured = measurement();
		const graph = objectGraph(measured);
		const related = occlude(graph, {
			kind: 'occlusion', occluderId: 'basket-0', occludedId: 'tee-0',
			evidence: { basis: 'alpha-mask', visiblePixels: 8, occludedPixels: 12, note: 'test-only' }
		});
		expect(related.occlusions).toHaveLength(1);
		expect(related.tees[0].raster).toEqual(graph.tees[0].raster);
		expect(measured.tees[0]).toEqual(tee());
	});
});

describe('3factor-dev72 Detector adapter', () => {
	it('runs deterministically on valid blank raster evidence', () => {
		const image = raster();
		const first = runThreeFactor(image, FAST_PARAMS);
		const second = runThreeFactor(image, FAST_PARAMS);

		expect(first.measurement).toEqual(second.measurement);
		expect(first.assignment).toEqual(second.assignment);
		expect(first.measurement.viewport.sourceFrame).toBe('original-image');
	});

	it('rejects malformed raster dimensions and accepts reference-sized frame metadata', () => {
		expect(() =>
			measureThreeFactor({ ...raster(), rgba: new Uint8ClampedArray(3) }, FAST_PARAMS)
		).toThrow(/rgba length/);

		const result = measureThreeFactor(raster(1920, 1080), FAST_PARAMS);
		expect(result.widthPx).toBe(1920);
		expect(result.heightPx).toBe(1080);
		expect(result.viewport.sourceFrame).toBe('original-image');
	});

	it('restores detections from a cropped viewport into original-image y coordinates', () => {
		const result = measureThreeFactor(rasterWithBadge(), {
			...FAST_PARAMS,
			viewport: { topPx: 20, bottomPx: 64 }
		});

		expect(result.viewport).toEqual({ topPx: 20, bottomPx: 64, sourceFrame: 'original-image' });
		expect(result.badges.length).toBeGreaterThan(0);
		expect(result.badges[0].cyPx).toBeGreaterThanOrEqual(32);
		expect(result.badges[0].bbox[1]).toBeGreaterThanOrEqual(32);
	});

	it('inserts distant recovered tees, dedups within 14px, and never mutates the measurement (frozen semantics)', () => {
		const measured = measurement();
		const snapshot = structuredClone(measured);

		// within 14px of the existing tee at (8, 14): frozen recovery SKIPS it
		const deduped = insertRecoveredEndpoints(measured, [
			{
				xPx: 9,
				yPx: 15,
				provenance: { source: 'explicit-injected', note: 'near duplicate', score: 0.7 }
			}
		]);
		expect(deduped.tees).toHaveLength(1);
		expect(deduped.tees.some((candidate) => candidate.tier === 'recovered')).toBe(false);

		// beyond the dedup radius: inserted with recovered tier + provenance
		const inserted = insertRecoveredEndpoints(measured, [
			{
				xPx: 28,
				yPx: 30,
				provenance: { source: 'explicit-injected', note: 'test recovery', score: 0.7 }
			}
		]);
		expect(inserted.tees).toHaveLength(2);
		expect(
			inserted.tees.find((candidate) => candidate.tier === 'recovered')?.recovery?.source
		).toBe('explicit-injected');

		// "preserves raw measurements" pinned for real: deep equality, not length
		expect(measured).toEqual(snapshot);
	});

	it('emits stamped objects, labels, and final associations in input pixel coordinates', () => {
		const run: ThreeFactorRun = {
			imageId: 'b'.repeat(64),
			measurement: measurement(),
			objects: objectGraph(measurement()),
		assignment: {
				measurement: measurement(),
				tees: [tee()],
				scoredPairs: [],
				assignments: [
					{
						badgeId: 'badge-0',
						teeId: 'tee-0',
						basketId: 'basket-0',
						score: 1.4,
						rank: 1,
						ownership: 'selected',
						alternatives: []
					}
				]
			}
		};
		const emissions = emissionsFor(run);
		const objects = emissions.filter((event) => event.kind === 'object');
		const labels = emissions.filter((event) => event.kind === 'label');
		const associations = emissions.filter((event) => event.kind === 'association');

		expect(objects.map((event) => event.detId)).toEqual(['badge-0', 'basket-0', 'tee-0']);
		expect(labels).toHaveLength(1);
		expect(labels[0]).toMatchObject({
			detId: 'badge-0',
			n: 1,
			confidence: 0.9,
			candidates: [{ n: 7, confidence: 0.1 }]
		});
		expect(labels[0].candidates?.some((candidate) => candidate.n === labels[0].n)).toBe(false);
		expect(associations.map((event) => [event.fromDetId, event.toDetId, event.relation])).toEqual([
			['tee-0', 'badge-0', 'tee-of'],
			['basket-0', 'badge-0', 'basket-of']
		]);
		for (const event of emissions) {
			expect(event.imageId).toBe('b'.repeat(64));
			expect(event.algo).toBe(THREE_FACTOR_ALGO);
			expect(event.algoVersion).toBe(THREE_FACTOR_ALGO_VERSION);
			expect(event.confidence).toBeGreaterThanOrEqual(0);
			expect(event.confidence).toBeLessThanOrEqual(1);
		}
	});

	it('keeps event IDs and coordinates stable across repeated emission', () => {
		const run: ThreeFactorRun = {
			imageId: 'c'.repeat(64),
			measurement: measurement(),
			objects: objectGraph(measurement()),
		assignment: {
				measurement: measurement(),
				tees: [tee()],
				scoredPairs: [],
				assignments: []
			}
		};

		expect(emissionsFor(run)).toEqual(emissionsFor(run));
	});
});
