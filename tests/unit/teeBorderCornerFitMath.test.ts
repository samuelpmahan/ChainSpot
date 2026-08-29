// teeBorderCornerFit math coverage. The scene mirrors the receipted Heritage
// T6 manual run (2026-08-29): a basket glyph drawn as a WHITE FILL inside a
// black outline, a pad buried under it, and only a small wall remnant poking
// out past the border. The tests assert the four load-bearing behaviors:
//  1. discovery follows the owner's border-adjacency rule and NEVER treats
//     the glyph's own white fill as a candidate or as pad evidence;
//  2. the corner anchor recovers the buried pad's center exactly, with the
//     outline fully accounted (evidence/occluded/transition, zero bare);
//  3. orientation ties are broken by badge aim, not by enumeration order;
//  4. contradictions and unknown pad dims abstain LOUDLY, never guess.

import { describe, expect, test } from 'vitest';
import {
	axisOrthogonalityErrorDeg,
	derivePadDims,
	discoverBorderCandidates,
	resolveGlyphFillLabel,
	runBorderCornerFit,
	undirectedAxisErrorDeg,
	type BorderFitBadge,
	type BorderFitBasket,
	type BorderFitKnobs,
	type BorderFitMasks,
	type BorderFitVisiblePad
} from '@chainspot/alg/detectors/threeFactor/features/g4.teeBorderCornerFitMath';
import { extractComponents } from '@chainspot/alg/detectors/threeFactor/components';

const KNOBS: BorderFitKnobs = {
	minimumPadSampleSize: 3,
	borderMarginPx: 2,
	haloPx: 1,
	candidateAreaCapFactor: 1.25,
	evidenceFloorFactor: 0.5,
	axisOrthogonalToleranceDeg: 10
};

/** Course convention for the scene: pads are 9 long x 7 short, 2px walls. */
const PAD_LONG = 9;
const PAD_SHORT = 7;
const PAD_WALL = 2;

interface Scene {
	readonly width: number;
	readonly height: number;
	readonly bright: Uint8Array;
	readonly dark: Uint8Array;
}

function makeScene(width: number, height: number): Scene {
	return { width, height, bright: new Uint8Array(width * height), dark: new Uint8Array(width * height) };
}

function drawHollowPad(scene: Scene, x0: number, y0: number, w: number, h: number): void {
	for (let y = y0; y < y0 + h; y++) {
		for (let x = x0; x < x0 + w; x++) {
			const onWall =
				x - x0 < PAD_WALL || x0 + w - 1 - x < PAD_WALL || y - y0 < PAD_WALL || y0 + h - 1 - y < PAD_WALL;
			if (onWall) scene.bright[y * scene.width + x] = 1;
		}
	}
}

/** White-filled glyph inside a black outline (the Heritage basket anatomy).
 * The fill overprints whatever bright it covers; the outline overprints both. */
function drawGlyph(scene: Scene, x0: number, y0: number, w: number, h: number): void {
	for (let y = y0; y < y0 + h; y++) {
		for (let x = x0; x < x0 + w; x++) {
			const index = y * scene.width + x;
			const onOutline = x === x0 || x === x0 + w - 1 || y === y0 || y === y0 + h - 1;
			if (onOutline) {
				scene.dark[index] = 1;
				scene.bright[index] = 0;
			} else {
				scene.bright[index] = 1;
				scene.dark[index] = 0;
			}
		}
	}
}

function masksFor(scene: Scene): BorderFitMasks {
	const { labels } = extractComponents({ width: scene.width, height: scene.height, data: scene.bright });
	return {
		width: scene.width,
		height: scene.height,
		bright: scene.bright,
		dark: scene.dark,
		brightLabels: labels
	};
}

function componentsFor(scene: Scene) {
	return extractComponents({ width: scene.width, height: scene.height, data: scene.bright }).components;
}

function labelAt(masks: BorderFitMasks, x: number, y: number): number {
	return masks.brightLabels[y * masks.width + x];
}

/**
 * The reference scene. Three clean visible pads give the course medians.
 * A glyph at [40,20 14x20] buries a pad whose true footprint is
 * [38,24 7x9] (vertical: w=short=7, h=long=9); only its left wall columns
 * x=38..39 x its full height y=24..32 poke out past the glyph outline at
 * x=40. A badge sits due north of the buried pad so the vertical
 * orientation aims at it.
 */
function referenceScene() {
	const scene = makeScene(80, 60);
	drawHollowPad(scene, 5, 5, PAD_LONG, PAD_SHORT);
	drawHollowPad(scene, 20, 5, PAD_LONG, PAD_SHORT);
	drawHollowPad(scene, 5, 40, PAD_SHORT, PAD_LONG);
	drawHollowPad(scene, 38, 24, PAD_SHORT, PAD_LONG); // buried pad, drawn first...
	drawGlyph(scene, 40, 20, 14, 20); // ...then the glyph overprints all but x=38..39
	const masks = masksFor(scene);
	const components = componentsFor(scene);
	const visiblePads: BorderFitVisiblePad[] = [
		{ teeId: 'tee-0', componentLabel: labelAt(masks, 5, 5), majorPx: PAD_LONG, minorPx: PAD_SHORT, areaPx: 48 },
		{ teeId: 'tee-1', componentLabel: labelAt(masks, 20, 5), majorPx: PAD_LONG, minorPx: PAD_SHORT, areaPx: 48 },
		{ teeId: 'tee-2', componentLabel: labelAt(masks, 5, 40), majorPx: PAD_LONG, minorPx: PAD_SHORT, areaPx: 48 }
	];
	const basket: BorderFitBasket = {
		detId: 'basket-0',
		bboxLocal: [40, 20, 14, 20],
		whiteBboxLocal: [41, 21, 12, 18],
		centerXLocalPx: 47,
		centerYLocalPx: 30
	};
	const badgeNorth: BorderFitBadge = { detId: 'badge-6', label: '6', cxLocalPx: 41, cyLocalPx: 4, bboxLocal: [37, 1, 8, 6] };
	return { scene, masks, components, visiblePads, basket, badgeNorth };
}

describe('derivePadDims', () => {
	test('medians from visible pads, wall from area/perimeter, with provenance', () => {
		const pads: BorderFitVisiblePad[] = [
			{ teeId: 'a', componentLabel: 1, majorPx: 17, minorPx: 12, areaPx: 130 },
			{ teeId: 'b', componentLabel: 2, majorPx: 16, minorPx: 12, areaPx: 124 },
			{ teeId: 'c', componentLabel: 3, majorPx: 17, minorPx: 13, areaPx: 133 }
		];
		const dims = derivePadDims(pads, KNOBS);
		expect(dims.isFallback).toBe(false);
		expect(dims.longPx).toBe(17);
		expect(dims.shortPx).toBe(12);
		expect(dims.wallPx).toBe(2); // 130 / (2*29) = 2.24 -> 2
		expect(dims.provenance).toContain('visible tee pads');
	});

	test('too few pads => loud fallback, never a guessed size', () => {
		const dims = derivePadDims(
			[{ teeId: 'a', componentLabel: 1, majorPx: 17, minorPx: 12, areaPx: 130 }],
			KNOBS
		);
		expect(dims.isFallback).toBe(true);
		expect(Number.isNaN(dims.longPx)).toBe(true);
		expect(dims.provenance).toContain('UNKNOWN');
	});
});

describe('discovery (owner border-adjacency rule)', () => {
	test('finds the remnant, excludes the glyph fill BY NAME, never silently', () => {
		const { masks, components, visiblePads, basket } = referenceScene();
		const dims = derivePadDims(visiblePads, KNOBS);
		const discovery = discoverBorderCandidates(masks, components, [basket], visiblePads, dims, KNOBS);
		expect(discovery.candidates).toHaveLength(1);
		const remnant = discovery.candidates[0].component;
		expect(remnant.bboxX).toBe(38);
		expect(remnant.bboxW).toBe(2);
		expect(discovery.candidates[0].anchorBasketIds).toEqual(['basket-0']);
		// the glyph's white fill touched the border too -- excluded with a name
		const glyphRow = discovery.excluded.find((row) => row.reason === 'basket-glyph-fill');
		expect(glyphRow).toBeDefined();
		const glyphLabel = resolveGlyphFillLabel(masks, basket);
		expect(glyphRow?.componentLabel).toBe(glyphLabel);
	});

	test('a component owned by a visible tee is excluded by name', () => {
		const { scene } = referenceScene();
		// move a visible pad flush against the glyph border so it becomes adjacent
		drawHollowPad(scene, 31, 22, PAD_LONG, PAD_SHORT); // right edge x=39, glyph outline at x=40
		const masks = masksFor(scene);
		const components = componentsFor(scene);
		const adjacentPadLabel = labelAt(masks, 31, 22);
		const visiblePads: BorderFitVisiblePad[] = [
			{ teeId: 'tee-0', componentLabel: labelAt(masks, 5, 5), majorPx: 9, minorPx: 7, areaPx: 48 },
			{ teeId: 'tee-1', componentLabel: labelAt(masks, 20, 5), majorPx: 9, minorPx: 7, areaPx: 48 },
			{ teeId: 'tee-3', componentLabel: adjacentPadLabel, majorPx: 9, minorPx: 7, areaPx: 48 }
		];
		const basket: BorderFitBasket = {
			detId: 'basket-0',
			bboxLocal: [40, 20, 14, 20],
			whiteBboxLocal: [41, 21, 12, 18],
			centerXLocalPx: 47,
			centerYLocalPx: 30
		};
		const dims = derivePadDims(visiblePads, KNOBS);
		const discovery = discoverBorderCandidates(masks, components, [basket], visiblePads, dims, KNOBS);
		const owned = discovery.excluded.find((row) => row.reason === 'owned-by-visible-tee');
		expect(owned?.componentLabel).toBe(adjacentPadLabel);
	});
});

describe('the corner fit (Heritage T6 shape)', () => {
	test('recovers the buried pad center exactly, outline fully accounted, zero bare', () => {
		const { masks, components, visiblePads, basket, badgeNorth } = referenceScene();
		const result = runBorderCornerFit(masks, components, [basket], [badgeNorth], visiblePads, KNOBS);
		expect(result.claims).toHaveLength(1);
		const claim = result.claims[0];
		// true buried pad: [38,24 7x9] => center (41, 28)
		expect(claim.teeXPx).toBe(41);
		expect(claim.teeYPx).toBe(28);
		expect(claim.placement.barePx).toBe(0);
		expect(claim.placement.candidateOffOutlinePx).toBe(0);
		expect(claim.placement.evidencePx).toBeGreaterThan(0);
		expect(claim.placement.occludedPx).toBeGreaterThan(0);
		expect(
			claim.placement.evidencePx +
				claim.placement.occludedPx +
				claim.placement.transitionPx +
				claim.placement.barePx
		).toBe(claim.placement.outlinePx);
		expect(claim.aimBadgeId).toBe('badge-6');
		// vertical pad => axis PI/2
		expect(claim.angleRad).toBeCloseTo(Math.PI / 2, 10);
		// single eligible badge => no runner-up => the aim is resolved
		expect(claim.aimResolved).toBe(true);
		expect(claim.aimResolutionBoundPx).toBe(9); // one course pad length
	});

	test('two eligible badges within the axis-quantization bound carry an UNRESOLVED aim', () => {
		const { masks, components, visiblePads, basket } = referenceScene();
		// two unserved badges nearly collinear with the vertical axis: bearing
		// difference from the pad center (41,28) is under atan(1/9)=6.34deg
		const badges: BorderFitBadge[] = [
			{ detId: 'badge-a', label: '5', cxLocalPx: 41, cyLocalPx: 4, bboxLocal: [37, 1, 8, 6] },
			{ detId: 'badge-b', label: '6', cxLocalPx: 43, cyLocalPx: 4, bboxLocal: [39, 1, 8, 6] }
		];
		const result = runBorderCornerFit(masks, components, [basket], badges, visiblePads, KNOBS);
		expect(result.claims).toHaveLength(1);
		const claim = result.claims[0];
		expect(claim.teeXPx).toBe(41);
		expect(claim.teeYPx).toBe(28);
		expect(claim.aimResolved).toBe(false);
		expect(claim.aimRunnerUpBadgeId).toBeTruthy();
		expect((claim.aimRunnerUpRangePx ?? Infinity) - claim.aimRangePx).toBeLessThan(
			claim.aimResolutionBoundPx
		);
	});

	test('orientation tie is broken by badge aim: the same corner claims vertical for a north badge and horizontal for an east badge', () => {
		// A true symmetric corner: only a 2x2 block at the pad's top-left corner
		// is visible; basket ink covers everything east (glyph) AND south (a
		// second ink run), so the vertical pad [38,24 7x9] and the horizontal
		// pad [38,24 9x7] are BOTH contradiction-free with identical evidence.
		// Exactly the Heritage T6 ambiguity class -- only the badge can decide.
		const buildScene = () => {
			const scene = makeScene(80, 60);
			drawHollowPad(scene, 5, 5, PAD_LONG, PAD_SHORT);
			drawHollowPad(scene, 20, 5, PAD_LONG, PAD_SHORT);
			drawHollowPad(scene, 5, 40, PAD_SHORT, PAD_LONG);
			drawGlyph(scene, 40, 18, 20, 24); // covers x>=40
			for (let y = 26; y <= 40; y++) {
				for (let x = 36; x <= 39; x++) scene.dark[y * scene.width + x] = 1; // ink south
			}
			for (let y = 24; y <= 25; y++) {
				for (let x = 38; x <= 39; x++) scene.bright[y * scene.width + x] = 1; // the corner
			}
			return scene;
		};
		const basket: BorderFitBasket = {
			detId: 'basket-0',
			bboxLocal: [36, 18, 24, 24],
			whiteBboxLocal: [41, 19, 18, 22],
			centerXLocalPx: 50,
			centerYLocalPx: 30
		};
		// the 2x2=4px corner sits under the evidence floor at the default factor;
		// lower it for this scene (floor = 2*7*0.25 = 3.5 <= 4)
		const knobs: BorderFitKnobs = { ...KNOBS, evidenceFloorFactor: 0.25 };
		const runWith = (badge: BorderFitBadge) => {
			const scene = buildScene();
			const masks = masksFor(scene);
			const components = componentsFor(scene);
			const visiblePads: BorderFitVisiblePad[] = [
				{ teeId: 'tee-0', componentLabel: labelAt(masks, 5, 5), majorPx: 9, minorPx: 7, areaPx: 48 },
				{ teeId: 'tee-1', componentLabel: labelAt(masks, 20, 5), majorPx: 9, minorPx: 7, areaPx: 48 },
				{ teeId: 'tee-2', componentLabel: labelAt(masks, 5, 40), majorPx: 9, minorPx: 7, areaPx: 48 }
			];
			return runBorderCornerFit(masks, components, [basket], [badge], visiblePads, knobs);
		};
		const north = runWith({ detId: 'badge-n', label: '6', cxLocalPx: 41, cyLocalPx: 2, bboxLocal: [37, -1, 8, 6] });
		const east = runWith({ detId: 'badge-e', label: '7', cxLocalPx: 79, cyLocalPx: 27, bboxLocal: [75, 24, 8, 6] });
		expect(north.claims).toHaveLength(1);
		expect(north.claims[0].angleRad).toBeCloseTo(Math.PI / 2, 10);
		expect(north.claims[0].aimBadgeId).toBe('badge-n');
		expect(east.claims).toHaveLength(1);
		expect(east.claims[0].angleRad).toBeCloseTo(0, 10);
		expect(east.claims[0].aimBadgeId).toBe('badge-e');
	});

	test('a badge covered by visible-tee testimony cannot steal the tie-break', () => {
		// Same symmetric corner, BOTH badges on the board: the east badge is a
		// perfect horizontal aim (0deg) but is COVERED, so the vertical
		// orientation aiming at the unserved north badge must win -- this is
		// the exact failure the first Heritage production run showed (a far,
		// already-served badge collinear with the wrong axis by chance).
		const scene = makeScene(80, 60);
		drawHollowPad(scene, 5, 5, PAD_LONG, PAD_SHORT);
		drawHollowPad(scene, 20, 5, PAD_LONG, PAD_SHORT);
		drawHollowPad(scene, 5, 40, PAD_SHORT, PAD_LONG);
		drawGlyph(scene, 40, 18, 20, 24);
		for (let y = 26; y <= 40; y++) {
			for (let x = 36; x <= 39; x++) scene.dark[y * scene.width + x] = 1;
		}
		for (let y = 24; y <= 25; y++) {
			for (let x = 38; x <= 39; x++) scene.bright[y * scene.width + x] = 1;
		}
		const masks = masksFor(scene);
		const components = componentsFor(scene);
		const visiblePads: BorderFitVisiblePad[] = [
			{ teeId: 'tee-0', componentLabel: labelAt(masks, 5, 5), majorPx: 9, minorPx: 7, areaPx: 48 },
			{ teeId: 'tee-1', componentLabel: labelAt(masks, 20, 5), majorPx: 9, minorPx: 7, areaPx: 48 },
			{ teeId: 'tee-2', componentLabel: labelAt(masks, 5, 40), majorPx: 9, minorPx: 7, areaPx: 48 }
		];
		const basket: BorderFitBasket = {
			detId: 'basket-0',
			bboxLocal: [36, 18, 24, 24],
			whiteBboxLocal: [41, 19, 18, 22],
			centerXLocalPx: 50,
			centerYLocalPx: 30
		};
		const badges: BorderFitBadge[] = [
			{ detId: 'badge-n', label: '6', cxLocalPx: 41, cyLocalPx: 2, bboxLocal: [37, -1, 8, 6] },
			{ detId: 'badge-e', label: '7', cxLocalPx: 79, cyLocalPx: 27, bboxLocal: [75, 24, 8, 6] }
		];
		const knobs: BorderFitKnobs = { ...KNOBS, evidenceFloorFactor: 0.25 };
		const result = runBorderCornerFit(masks, components, [basket], badges, visiblePads, knobs, [
			'badge-e'
		]);
		expect(result.claims).toHaveLength(1);
		expect(result.claims[0].angleRad).toBeCloseTo(Math.PI / 2, 10);
		expect(result.claims[0].aimBadgeId).toBe('badge-n');
		expect(result.aimEligibility.eligibleBadgeIds).toEqual(['badge-n']);
		expect(result.aimEligibility.coveredBadgeIds).toEqual(['badge-e']);
	});

	test('a remnant with no contradiction-free placement abstains loudly', () => {
		const scene = makeScene(80, 60);
		drawHollowPad(scene, 5, 5, PAD_LONG, PAD_SHORT);
		drawHollowPad(scene, 20, 5, PAD_LONG, PAD_SHORT);
		drawHollowPad(scene, 5, 40, PAD_SHORT, PAD_LONG);
		drawGlyph(scene, 40, 20, 14, 20);
		// a 2px-wide bar THIRTY pixels tall glued to the glyph's left outline
		// -- longer than any pad this course owns (long side 9), so every
		// placement leaves an overhang of remnant pixels far off the wall
		// band: the candidate must abstain loudly, never claim. This is the
		// real path-segment-glued-to-a-basket class. (2026-08-29: this scene
		// replaced a thin 2x5 remnant -- under the wall-smear +
		// anti-alias-halo accounting a small glyph-adjacent remnant honestly
		// ADMITS a pad tucked under the glyph, exactly the Heritage T6
		// geometry, so it stopped being a contradiction case at all.)
		for (let y = 8; y < 38; y++) for (let x = 38; x < 40; x++) scene.bright[y * scene.width + x] = 1;
		const masks = masksFor(scene);
		const components = componentsFor(scene);
		const visiblePads: BorderFitVisiblePad[] = [
			{ teeId: 'tee-0', componentLabel: labelAt(masks, 5, 5), majorPx: 9, minorPx: 7, areaPx: 48 },
			{ teeId: 'tee-1', componentLabel: labelAt(masks, 20, 5), majorPx: 9, minorPx: 7, areaPx: 48 },
			{ teeId: 'tee-2', componentLabel: labelAt(masks, 5, 40), majorPx: 9, minorPx: 7, areaPx: 48 }
		];
		const basket: BorderFitBasket = {
			detId: 'basket-0',
			bboxLocal: [40, 20, 14, 20],
			whiteBboxLocal: [41, 21, 12, 18],
			centerXLocalPx: 47,
			centerYLocalPx: 30
		};
		const result = runBorderCornerFit(
			masks,
			components,
			[basket],
			[{ detId: 'badge-6', label: '6', cxLocalPx: 41, cyLocalPx: 4, bboxLocal: [37, 1, 8, 6] }],
			visiblePads,
			KNOBS
		);
		expect(result.claims).toHaveLength(0);
		const abstention = result.abstentions.find(
			(row) => row.reason === 'no-contradiction-free-placement'
		);
		expect(abstention).toBeDefined();
		expect(abstention?.detail).toContain('never accepted');
	});

	test('unknown course pad dims abstain for the whole feature', () => {
		const { masks, components, basket, badgeNorth } = referenceScene();
		const result = runBorderCornerFit(masks, components, [basket], [badgeNorth], [], KNOBS);
		expect(result.claims).toHaveLength(0);
		expect(result.abstentions[0]?.reason).toBe('course-pad-dims-unknown');
	});
});

describe('small helpers', () => {
	test('axisOrthogonalityErrorDeg folds to the nearest image axis', () => {
		expect(axisOrthogonalityErrorDeg(0)).toBeCloseTo(0, 10);
		expect(axisOrthogonalityErrorDeg(Math.PI / 2)).toBeCloseTo(0, 10);
		expect(axisOrthogonalityErrorDeg(Math.PI / 4)).toBeCloseTo(45, 10);
		expect(axisOrthogonalityErrorDeg((95 * Math.PI) / 180)).toBeCloseTo(5, 10);
	});

	test('undirectedAxisErrorDeg treats theta and theta+pi as identical', () => {
		expect(undirectedAxisErrorDeg(Math.PI / 2, -Math.PI / 2)).toBeCloseTo(0, 10);
		expect(undirectedAxisErrorDeg(0, Math.PI)).toBeCloseTo(0, 10);
		expect(undirectedAxisErrorDeg(Math.PI / 2, 0)).toBeCloseTo(90, 10);
	});
});
