import { describe, expect, test } from 'vitest';
import { GraphicsMode } from '../../src/lib/graphics/graphicsMode.svelte';
import type { GraphicsModeInputs } from '../../src/lib/graphics/graphicsMode.svelte';
import type { HoleGraphicPlan } from '../../src/lib/holeGraphics';
import type { AnnotatedHole } from '../../src/lib/domain/annotatedRound';
import type { SerializableTransform } from '../../src/lib/alignment/types';
import { naipImageGeoReference } from '../../src/lib/elevationProfile';
import type { GeoRasterReference } from '../../src/lib/elevationProfile';

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
		targetWidthPx: 100,
		targetHeightPx: 100,
		targetRotationDeg: 0,
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
		targetRotationDeg: () => 0,
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

describe('GraphicsMode.plans (CHSPT-44 rotation wiring)', () => {
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
	const hole: AnnotatedHole = {
		id: 'h1',
		number: 1,
		tee: { xPx: 10, yPx: 10 },
		basket: { xPx: 90, yPx: 10 },
		shots: [],
		corridorBends: [],
		corridorWidthPx: 20
	};

	test('threads targetRotationDeg from inputs onto every derived plan', () => {
		const mode = new GraphicsMode(
			fakeInputs({
				holes: () => [hole],
				transform: () => IDENTITY,
				targetSize: () => ({ widthPx: 200, heightPx: 200 }),
				targetRotationDeg: () => 30
			})
		);
		expect(mode.plans).toHaveLength(1);
		expect(mode.plans[0].targetRotationDeg).toBe(30);
	});

	test('defaults to unrotated (0deg) plans, matching pre-CHSPT-44 behavior', () => {
		const mode = new GraphicsMode(
			fakeInputs({
				holes: () => [hole],
				transform: () => IDENTITY,
				targetSize: () => ({ widthPx: 200, heightPx: 200 })
			})
		);
		expect(mode.plans[0].targetRotationDeg).toBe(0);
	});
});
