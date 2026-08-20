import { describe, expect, it } from 'vitest';
import {
	boxMeanReflect,
	DEFAULT_RIBBON_MASS_PARAMS,
	greyOpeningReflect,
	keptAreaPx,
	labelComponents,
	nearestComponentLabel,
	nearestKeptDistancePx,
	placeSeeds,
	recommendedKeptLabels,
	segmentRibbonMass,
	topologyBuckets
} from '../../src/lib/autoAnnotation/ribbonMass';
import type { RibbonMassSeedPlacement } from '../../src/lib/autoAnnotation/ribbonMass';

describe('labelComponents', () => {
	it('joins diagonal neighbors (8-connectivity, matching skimage label default)', () => {
		// 1 0
		// 0 1  — one component under 8-connectivity, two under 4.
		const labels = labelComponents(new Uint8Array([1, 0, 0, 1]), 2, 2);
		expect(labels[0]).toBe(1);
		expect(labels[3]).toBe(1);
	});

	it('separates disconnected regions and numbers them in raster-scan order', () => {
		const binary = new Uint8Array([
			1, 1, 0, 0,
			0, 0, 0, 0,
			0, 0, 1, 1
		]);
		const labels = labelComponents(binary, 4, 3);
		expect(labels[0]).toBe(1);
		expect(labels[1]).toBe(1);
		expect(labels[10]).toBe(2);
		expect(labels[11]).toBe(2);
	});
});

describe('boxMeanReflect', () => {
	it('matches a hand-computed reflect-padded mean on a 1-D-like plane', () => {
		// Row [1, 2, 3], window 3, reflect (edge repeated): at index 0 the
		// window is [1, 1, 2] → 4/3; at index 2 it is [2, 3, 3] → 8/3.
		const out = boxMeanReflect(new Float32Array([1, 2, 3]), 3, 1, 3);
		expect(out[0]).toBeCloseTo(4 / 3, 5);
		expect(out[1]).toBeCloseTo(2, 5);
		expect(out[2]).toBeCloseTo(8 / 3, 5);
	});
});

describe('greyOpeningReflect', () => {
	it('removes a bright speck smaller than the kernel but keeps a wide plateau', () => {
		const w = 12;
		const h = 12;
		const plane = new Float32Array(w * h);
		plane[5 * w + 5] = 1; // isolated speck
		const opened = greyOpeningReflect(plane, w, h, 3);
		expect(Math.max(...opened)).toBe(0);

		const plateau = new Float32Array(w * h);
		for (let y = 2; y < 10; y += 1) for (let x = 2; x < 10; x += 1) plateau[y * w + x] = 1;
		const openedPlateau = greyOpeningReflect(plateau, w, h, 3);
		expect(openedPlateau[5 * w + 5]).toBe(1);
	});
});

describe('nearestComponentLabel', () => {
	const w = 5;
	const h = 5;
	// One component: a vertical bar at x=4.
	const labels = new Int32Array(w * h);
	for (let y = 0; y < h; y += 1) labels[y * w + 4] = 1;

	it('returns the direct hit without any search', () => {
		expect(nearestComponentLabel(labels, w, h, 1, 4, 2, 0)).toBe(1);
	});

	it('finds the nearest label within the search radius', () => {
		expect(nearestComponentLabel(labels, w, h, 1, 2, 2, 3)).toBe(1);
	});

	it('returns null outside the search radius and out of bounds', () => {
		expect(nearestComponentLabel(labels, w, h, 1, 0, 2, 2)).toBeNull();
		expect(nearestComponentLabel(labels, w, h, 1, -1, 2, 10)).toBeNull();
	});
});

function placement(
	kind: 'badge' | 'basket',
	holeNumber: number | null,
	componentLabel: number | null
): RibbonMassSeedPlacement {
	return { seedId: `${kind}-${holeNumber}`, kind, holeNumber, componentLabel };
}

describe('topologyBuckets', () => {
	it('keeps the four-way taxonomy: exclusive vs shared same-component are distinct buckets', () => {
		// Hole 1: badge+basket both in component 10, nothing else touches it.
		// Hole 2: badge+basket both in component 20, but hole 3's badge also
		//         touches 20 — connectivity without ownership.
		// Hole 3: badge in 20, basket in 30 — split.
		// Hole 4: basket never landed — noSeedHit.
		const placements = [
			placement('badge', 1, 10),
			placement('basket', 1, 10),
			placement('badge', 2, 20),
			placement('basket', 2, 20),
			placement('badge', 3, 20),
			placement('basket', 3, 30),
			placement('badge', 4, 40),
			placement('basket', 4, null)
		];
		const topology = topologyBuckets(placements, [1, 2, 3, 4]);
		expect(topology.counts).toEqual({
			exclusiveSameComponent: 1,
			sharedSameComponent: 1,
			split: 1,
			noSeedHit: 1
		});
		expect(topology.perHole.find((hole) => hole.holeNumber === 1)?.bucket).toBe(
			'exclusiveSameComponent'
		);
		expect(topology.perHole.find((hole) => hole.holeNumber === 2)?.bucket).toBe('sharedSameComponent');
		expect(topology.sharedConflictComponents).toEqual([{ label: 20, holeNumbers: [2, 3] }]);
	});

	it('ignores identity-free seeds for ownership but they never create buckets', () => {
		const placements = [placement('badge', 1, 10), placement('basket', 1, 10), placement('basket', null, 10)];
		const topology = topologyBuckets(placements, [1]);
		// The identity-free basket cannot make component 10 "shared".
		expect(topology.perHole[0].bucket).toBe('exclusiveSameComponent');
	});
});

describe('recommendedKeptLabels / keptAreaPx / nearestKeptDistancePx', () => {
	it('unions seed-connected labels with texture-kept labels (never intersects)', () => {
		const kept = recommendedKeptLabels({ textureKeptLabels: new Set([1]) }, [
			placement('basket', 1, 2),
			placement('badge', 1, null)
		]);
		expect([...kept].sort()).toEqual([1, 2]);
	});

	it('measures kept area and nearest kept distance in source px', () => {
		const w = 4;
		const h = 1;
		const labels = new Int32Array([0, 0, 1, 2]);
		expect(keptAreaPx(labels, new Set([1]))).toBe(1);
		// scale 3: query at source x=0 → evidence x=0; label 1 sits at x=2 → 2 evidence px → 6 source px.
		expect(nearestKeptDistancePx(labels, w, h, 3, new Set([1]), 0, 0)).toBeCloseTo(6, 5);
		expect(nearestKeptDistancePx(labels, w, h, 3, new Set(), 0, 0)).toBe(Infinity);
	});
});

describe('segmentRibbonMass', () => {
	/**
	 * Synthetic course: a dark background with one bright, textured
	 * horizontal ribbon and one bright but optically-uniform strip (the
	 * "road"). At evidence scale the ribbon should survive the texture
	 * filter and the road should not.
	 */
	function syntheticRaster(): { data: Uint8Array; widthPx: number; heightPx: number; channels: 4 } {
		const widthPx = 240;
		const heightPx = 180;
		const data = new Uint8Array(widthPx * heightPx * 4);
		for (let y = 0; y < heightPx; y += 1) {
			for (let x = 0; x < widthPx; x += 1) {
				const i = (y * widthPx + x) * 4;
				let value = 60; // dark background
				if (y >= 40 && y < 70) {
					// textured bright ribbon: alternating bright bands
					value = 170 + (((x / 6) | 0) % 2 === 0 ? 60 : -30);
				} else if (y >= 120 && y < 150) {
					// uniform bright road
					value = 200;
				}
				data[i] = value;
				data[i + 1] = value;
				data[i + 2] = value;
				data[i + 3] = 255;
			}
		}
		return { data, widthPx, heightPx, channels: 4 };
	}

	it('admits the textured ribbon by texture and excludes the uniform road', () => {
		const segmentation = segmentRibbonMass(syntheticRaster(), [], DEFAULT_RIBBON_MASS_PARAMS);
		expect(segmentation.widthEv).toBe(80);
		expect(segmentation.heightEv).toBe(60);
		// Both strips become evidence components (bright against the box mean).
		const ribbonLabel = segmentation.labels[18 * segmentation.widthEv + 40];
		const roadLabel = segmentation.labels[45 * segmentation.widthEv + 40];
		expect(ribbonLabel).toBeGreaterThan(0);
		expect(roadLabel).toBeGreaterThan(0);
		expect(ribbonLabel).not.toBe(roadLabel);
		expect(segmentation.textureKeptLabels.has(ribbonLabel)).toBe(true);
		expect(segmentation.textureKeptLabels.has(roadLabel)).toBe(false);
		const roadRecord = segmentation.components.find((component) => component.label === roadLabel);
		expect(roadRecord?.admittedByTexture).toBe(false);
		expect(roadRecord && roadRecord.lStd).toBeLessThan(DEFAULT_RIBBON_MASS_PARAMS.textureLstdMin);
	});

	it('seed connectivity keeps the road only when a seed touches it', () => {
		const segmentation = segmentRibbonMass(syntheticRaster(), [], DEFAULT_RIBBON_MASS_PARAMS);
		const roadLabel = segmentation.labels[45 * segmentation.widthEv + 40];
		const noSeeds = placeSeeds(segmentation, [], DEFAULT_RIBBON_MASS_PARAMS.seedRadiusPx);
		expect(recommendedKeptLabels(segmentation, noSeeds).has(roadLabel)).toBe(false);
		const roadSeed = placeSeeds(
			segmentation,
			[{ seedId: 'badge-1', kind: 'badge', holeNumber: 1, xPx: 120, yPx: 135 }],
			DEFAULT_RIBBON_MASS_PARAMS.seedRadiusPx
		);
		expect(roadSeed[0].componentLabel).toBe(roadLabel);
		expect(recommendedKeptLabels(segmentation, roadSeed).has(roadLabel)).toBe(true);
	});

	it('pre-fills badge boxes so the badge area reads as evidence', () => {
		const raster = syntheticRaster();
		const withBadge = segmentRibbonMass(
			raster,
			[{ xPx: 120, yPx: 90 }], // in the dark gap between the strips
			DEFAULT_RIBBON_MASS_PARAMS
		);
		const badgeLabel = withBadge.labels[30 * withBadge.widthEv + 40];
		expect(badgeLabel).toBeGreaterThan(0);
		const without = segmentRibbonMass(raster, [], DEFAULT_RIBBON_MASS_PARAMS);
		expect(without.labels[30 * without.widthEv + 40]).toBe(0);
	});
});
