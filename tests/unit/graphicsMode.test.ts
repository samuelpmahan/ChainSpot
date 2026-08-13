import { describe, expect, test } from 'vitest';
import { GraphicsMode } from '../../src/lib/graphics/graphicsMode.svelte';
import type { GraphicsModeInputs } from '../../src/lib/graphics/graphicsMode.svelte';
import type { HoleGraphicPlan } from '../../src/lib/holeGraphics';
import type { AnnotatedHole } from '../../src/lib/domain/annotatedRound';
import type { SerializableTransform } from '../../src/lib/alignment/types';
import { naipImageGeoReference } from '../../src/lib/elevationProfile';
import type { GeoRasterReference } from '../../src/lib/elevationProfile';

const IDENTITY: SerializableTransform = {
	model: 'similarity',
	coefficients: [1, 0, 0, 1, 0, 0],
	isInvertible: true,
	determinant: 1,
	orientation: 1,
	majorAxisScale: 1,
	minorAxisScale: 1,
	anisotropy: 1,
	shear: 0
};

/** A hole placed well inside a 1000x1000 target — plans in-bounds under the default 16:9 framing. */
const IN_BOUNDS_HOLE: AnnotatedHole = {
	id: 'in-bounds',
	number: 1,
	tee: { xPx: 500, yPx: 500 },
	basket: { xPx: 600, yPx: 500 },
	shots: [],
	corridorBends: [],
	corridorWidthPx: 60
};

/** A hole placed at the target's corner — its padded 16:9 crop falls outside [0, 1000] x [0, 1000]. */
const OUT_OF_BOUNDS_HOLE: AnnotatedHole = {
	id: 'out-of-bounds',
	number: 2,
	tee: { xPx: 5, yPx: 5 },
	shots: [],
	corridorBends: [],
	corridorWidthPx: 60
};

/** A hole with no placed points at all — never produces a plan. */
const EMPTY_HOLE: AnnotatedHole = {
	id: 'empty',
	number: 3,
	shots: [],
	corridorBends: [],
	corridorWidthPx: 60
};

/** Minimal plan fixture -- only the fields `elevationEligible`/`buildAndDownloadElevation` read matter. */
function fakePlan(overrides: Partial<HoleGraphicPlan> = {}): HoleGraphicPlan {
	return {
		holeId: 'h1',
		number: 1,
		tee: { xPx: 10, yPx: 10 },
		basket: { xPx: 90, yPx: 10 },
		shots: [],
		corridorBand: null,
		centerline: [
			{ xPx: 10, yPx: 10 },
			{ xPx: 90, yPx: 10 }
		],
		bends: [],
		walkingPath: [],
		crop: { xPx: 0, yPx: 0, widthPx: 100, heightPx: 100 },
		outOfBounds: false,
		targetWidthPx: 100,
		targetHeightPx: 100,
		...overrides
	};
}

function fakeInputs(overrides: Partial<GraphicsModeInputs> = {}): GraphicsModeInputs {
	return {
		holes: () => [],
		transform: () => null,
		targetSize: () => null,
		targetImageHref: () => null,
		feetPerPixel: () => undefined,
		walkingPath: () => undefined,
		geoReference: () => null,
		...overrides
	};
}

const REFERENCE: GeoRasterReference = naipImageGeoReference({ lat: 33, lon: -96 }, 100, 100);

describe('GraphicsMode elevation-profile gating', () => {
	test('ineligible when the target has no known geo-reference', () => {
		const mode = new GraphicsMode(fakeInputs({ geoReference: () => null }));
		expect(mode.elevationEligible(fakePlan())).toBe(false);
	});

	test('ineligible when the hole has fewer than two centerline points (no tee/basket routing)', () => {
		const mode = new GraphicsMode(fakeInputs({ geoReference: () => REFERENCE }));
		expect(mode.elevationEligible(fakePlan({ centerline: [] }))).toBe(false);
		expect(mode.elevationEligible(fakePlan({ centerline: [{ xPx: 10, yPx: 10 }] }))).toBe(false);
	});

	test('eligible with a routed centerline and a known geo-reference', () => {
		const mode = new GraphicsMode(fakeInputs({ geoReference: () => REFERENCE }));
		expect(mode.elevationEligible(fakePlan())).toBe(true);
	});

	test('buildAndDownloadElevation no-ops when ineligible, leaving no busy/error state', async () => {
		const mode = new GraphicsMode(fakeInputs({ geoReference: () => null }));
		await mode.buildAndDownloadElevation(fakePlan());
		expect(mode.elevationBuilding.size).toBe(0);
		expect(mode.elevationErrors.size).toBe(0);
		expect(mode.elevationStats.size).toBe(0);
	});

	test('surfaces a retry-oriented error and clears the busy state when EPQS is unreachable', async () => {
		const failingFetch: typeof fetch = async () => {
			throw new Error('network down');
		};
		const mode = new GraphicsMode(fakeInputs({ geoReference: () => REFERENCE }));
		// buildAndDownloadElevation always uses the module's own fetch; simulate the
		// EPQS failure at the global level so no other network call is required.
		const originalFetch = globalThis.fetch;
		globalThis.fetch = failingFetch;
		try {
			await mode.buildAndDownloadElevation(fakePlan());
		} finally {
			globalThis.fetch = originalFetch;
		}
		expect(mode.elevationBuilding.size).toBe(0);
		expect(mode.elevationErrors.get(fakePlan().holeId)).toMatch(/elevation lookup failed/i);
		expect(mode.elevationStats.size).toBe(0);
	});
});

describe('GraphicsMode hole selection', () => {
	function realInputs(): GraphicsModeInputs {
		return fakeInputs({
			holes: () => [IN_BOUNDS_HOLE, OUT_OF_BOUNDS_HOLE, EMPTY_HOLE],
			transform: () => IDENTITY,
			targetSize: () => ({ widthPx: 1000, heightPx: 1000 }),
			targetImageHref: () => 'blob:http://example/target'
		});
	}

	test('selectedPlan is null before any hole is selected', () => {
		const mode = new GraphicsMode(realInputs());
		expect(mode.selectedHoleId).toBeNull();
		expect(mode.selectedPlan).toBeNull();
	});

	test('selectHole selects the matching plan', () => {
		const mode = new GraphicsMode(realInputs());
		mode.selectHole(IN_BOUNDS_HOLE.id);
		expect(mode.selectedPlan?.holeId).toBe(IN_BOUNDS_HOLE.id);
	});

	test('selecting a hole with no placed points reports no plan instead of substituting a different hole', () => {
		const mode = new GraphicsMode(realInputs());
		mode.selectHole(EMPTY_HOLE.id);
		expect(mode.selectedPlan).toBeNull();
		// Still the explicitly selected (empty) hole, not silently reset.
		expect(mode.selectedHoleId).toBe(EMPTY_HOLE.id);
	});

	test('outOfBoundsCount reflects holes whose framing does not fit the target', () => {
		const mode = new GraphicsMode(realInputs());
		expect(mode.plans).toHaveLength(2); // EMPTY_HOLE never plans at all
		expect(mode.plans.find((plan) => plan.holeId === OUT_OF_BOUNDS_HOLE.id)?.outOfBounds).toBe(true);
		expect(mode.plans.find((plan) => plan.holeId === IN_BOUNDS_HOLE.id)?.outOfBounds).toBe(false);
		expect(mode.outOfBoundsCount).toBe(1);
	});
});

describe('GraphicsMode export gating on out-of-bounds plans', () => {
	test('downloadOne refuses an out-of-bounds plan without attempting to render it', async () => {
		const mode = new GraphicsMode(
			fakeInputs({
				holes: () => [OUT_OF_BOUNDS_HOLE],
				transform: () => IDENTITY,
				targetSize: () => ({ widthPx: 1000, heightPx: 1000 }),
				targetImageHref: () => 'blob:http://example/target'
			})
		);
		const plan = mode.plans[0];
		expect(plan.outOfBounds).toBe(true);
		await mode.downloadOne(plan);
		expect(mode.downloading.size).toBe(0);
		expect(mode.error).toBeNull();
	});

	test('downloadAll no-ops (no zip attempt) when every plan is out of bounds', async () => {
		const mode = new GraphicsMode(
			fakeInputs({
				holes: () => [OUT_OF_BOUNDS_HOLE],
				transform: () => IDENTITY,
				targetSize: () => ({ widthPx: 1000, heightPx: 1000 }),
				targetImageHref: () => 'blob:http://example/target'
			})
		);
		expect(mode.outOfBoundsCount).toBe(1);
		await mode.downloadAll();
		expect(mode.zipping).toBe(false);
		expect(mode.error).toBeNull();
	});
});
