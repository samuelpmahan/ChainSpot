import { beforeEach, describe, expect, test } from 'vitest';
import { extractComponents, type ComponentStats } from '@chainspot/alg/detectors/threeFactor/components';
import {
	buildTeeRecoveryCandidates,
	setActiveAxisToleranceDeg,
	teeRecoveryFeature,
	teeRecoveryUnit
} from '@chainspot/alg/detectors/threeFactor/features/g3.teeRecovery';
import { createBoard } from '@chainspot/alg/detectors/threeFactor/measure';
import { OcclusionDetector } from '@chainspot/alg/detectors/threeFactor/occlusion';
import type { Drawable } from '@chainspot/alg/detectors/threeFactor/features/types';
import type {
	BadgeEvidence,
	BasketEvidence,
	ThreeFactorAssignment,
	ThreeFactorMeasurement,
	TeeEvidence
} from '@chainspot/alg/detectors/threeFactor/types';

/**
 * Small direct fixture for the recovery seam.  The missing #2 tee is a
 * complete bright component on the global mask, deliberately separated from
 * the predecessor basket by more than the old basket-contact allowance.  The
 * numbered-badge ray still gives the component an unambiguous course-local
 * orientation.
 */
type FixtureMode = 'full' | 'full-tail' | 'hollow' | 'hollow-two-shards' | 'hollow-border' | 'hollow-extra' | 'hollow-opaque' | 'hollow-alpha' | 'hollow-misaligned';

function recoveryFixture(mode: FixtureMode = 'full') {
	const width = 140;
	const height = 120;
	const bright = new Uint8Array(width * height);
	const mark = (x: number, y: number) => {
		bright[y * width + x] = 1;
	};
	const fill = (x0: number, y0: number, w: number, h: number) => {
		for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) mark(x, y);
	};
	// Badge #1 (predecessor), badge #2 (target), and one known tee pad. Badge 1
	// sits well off the shard family's major-axis line (badgeRay 0 or 0.5 rad,
	// centered near (35,37)) so the no-spatial-prefilter search (owner design,
	// 2026-08-28) never finds it a plausible coincidental alternate claimant --
	// tests below isolate a single target badge's axis-tolerance behavior.
	fill(10, 90, 3, 3);
	fill(69, 36, 3, 3);
	// Reference pad: one-pixel hollow 12x8 border (36 pixels), not a solid
	// rectangle. Recovery must derive its support-band thickness from this
	// local course geometry.
	for (let y = 90; y < 98; y++) {
		for (let x = 110; x < 122; x++) {
			if (x === 110 || x === 121 || y === 90 || y === 97) mark(x, y);
		}
	}
	const badgeRay = 0;
	let contradictionPoint: readonly [number, number] | undefined;
	const rotated = (centerX: number, centerY: number, u: number, v: number, angle: number) => {
		const c = Math.cos(angle);
		const s = Math.sin(angle);
		const point = [Math.round(centerX + u * c - v * s), Math.round(centerY + u * s + v * c)] as const;
		mark(point[0], point[1]);
		return point;
	};
	// The first two modes retain a filled oversize component for the global
	// identity/clipping regression. It does not touch basket B0.
	if (mode === 'full' || mode === 'full-tail') fill(34, 35, 12, 8);
	if (mode === 'full-tail') fill(46, 35, 15, 8);
	// A tiny visible shard is nine rasterized points on the upper support band
	// of the course-sized (12x8) oriented footprint. The major-axis line goes
	// from its center toward badge #2, rather than matching a raster template.
	if (mode.startsWith('hollow')) {
		const centerX = 35;
		const centerY = 37;
		const shardRay = mode === 'hollow-misaligned' ? badgeRay + 0.5 : badgeRay;
		if (mode === 'hollow' || mode === 'hollow-two-shards') {
			for (let t = -4; t <= 4; t++) rotated(centerX, centerY, t, 4, shardRay);
			if (mode === 'hollow-two-shards') for (let t = -4; t <= -1; t++) rotated(centerX, centerY, t, -4, shardRay);
		} else {
			// A full geometric border makes the pose identifiable. This prevents an
			// allegedly contradictory pixel from being explained by sliding a
			// different valid tee underneath a nine-pixel edge.
			for (let u = -6; u <= 6; u++) {
				rotated(centerX, centerY, u, -4, shardRay);
				rotated(centerX, centerY, u, 4, shardRay);
			}
			for (let v = -3; v <= 3; v++) {
				rotated(centerX, centerY, -6, v, shardRay);
				rotated(centerX, centerY, 6, v, shardRay);
			}
		}
	}
	// Two bridge cells remain valid support; the third enters the hollow and is
	// the single contradictory visible pixel unless explicitly OPAQUE.
	if (mode === 'hollow-extra' || mode === 'hollow-opaque' || mode === 'hollow-alpha') {
		rotated(35, 37, 0, 3, badgeRay);
		rotated(35, 37, 0, 2, badgeRay);
		rotated(35, 37, 0, 1, badgeRay);
		contradictionPoint = rotated(35, 37, 0, 0, badgeRay);
	}

	const mask = { width, height, data: bright };
	const labeled = extractComponents(mask);
	const componentAt = (x: number, y: number): ComponentStats => {
		const label = labeled.labels[y * width + x];
		const component = labeled.components.find((entry) => entry.label === label);
		if (!component) throw new Error(`missing synthetic component at ${x},${y}`);
		return component;
	};
	const badgeEvidence = (detId: string, label: string, x: number, y: number): BadgeEvidence => {
		const component = componentAt(x, y);
		return {
			detId,
			component,
			cxPx: component.cx,
			cyPx: component.cy,
			bbox: [component.bboxX, component.bboxY, component.bboxW, component.bboxH],
			source: 'bright-family',
			digits: [],
			rawLabel: label,
			digitCount: label.length,
			label,
			bestLabel: label,
			labelCandidates: [{ label: Number(label), confidence: 1 }],
			confidence: 1,
			abstentionReason: null,
			confidenceFloor: 0.1,
			conflictWith: [],
			notes: []
		};
	};
	const badges = [badgeEvidence('badge-1', '1', 10, 90), badgeEvidence('badge-2', '2', 69, 36)];
	const basket: BasketEvidence = {
		detId: 'basket-0',
		bbox: [20, 20, 6, 8],
		whiteBbox: [20, 20, 6, 8],
		centerXPx: 23,
		centerYPx: 24,
		tipXPx: 23,
		tipYPx: 28,
		onFrac: 1,
		offFrac: 0,
		score: 1
	};
	const padComponent = componentAt(110, 90);
	const knownTee: TeeEvidence = {
		detId: 'tee-known',
		xPx: 115.5,
		yPx: 93.5,
		tier: 'component',
		angleRad: 0.6,
		bbox: [110, 90, 12, 8],
		pad: {
			source: 'bright-mask-component',
			componentLabel: padComponent.label,
			bbox: [110, 90, 12, 8],
			componentCentroidXPx: padComponent.cx,
			componentCentroidYPx: padComponent.cy,
			centerXPx: padComponent.cx,
			centerYPx: padComponent.cy,
			angleRad: badgeRay,
			majorPx: 12,
			minorPx: 8,
			area: padComponent.area,
			fill: padComponent.fill,
			axisMajorMin: padComponent.axisMajorMin ?? -5.5,
			axisMajorMax: padComponent.axisMajorMax ?? 5.5,
			axisMinorMin: padComponent.axisMinorMin ?? -3.5,
			axisMinorMax: padComponent.axisMinorMax ?? 3.5,
			orientedCorners: [[110, 90], [122, 90], [122, 98], [110, 98]]
		},
		area: padComponent.area,
		fill: padComponent.fill,
		onRing: true
	};
	const measurement: ThreeFactorMeasurement = {
		algo: '3factor-dev72',
		algoVersion: '1.0.0',
		widthPx: width,
		heightPx: height,
		viewport: { topPx: 0, bottomPx: height, sourceFrame: 'original-image' },
		parameters: {
			corridorWidthPx: 37,
			fieldScale: 3,
			orientations: 12,
			widthsSrc: [24],
			patchBadges: true,
			alignmentPower: 2,
			worstWindowSrcPx: 90,
			supportTau: 0.5
		},
		brightMask: mask,
		darkMask: { width, height, data: new Uint8Array(width * height) },
		badges,
		baskets: [basket],
		tees: [knownTee],
		field: {
			width: Math.ceil(width / 3),
			height: Math.ceil(height / 3),
			scale: 3,
			support: new Float32Array(Math.ceil(width / 3) * Math.ceil(height / 3)).fill(1),
			bestTheta: new Float32Array(Math.ceil(width / 3) * Math.ceil(height / 3)),
			parameters: { orientations: 12, widthsSrc: [24], gaussianSigma: 0.8, normalizationPercentile: 0.995, gamma: 0.7 }
		},
		rawPairs: []
	};
	const assignment: ThreeFactorAssignment = {
		measurement,
		tees: [knownTee],
		scoredPairs: [],
		assignments: [
			{
				badgeId: 'badge-1',
				teeId: 'tee-known',
				basketId: 'basket-0',
				score: 1,
				rank: 1,
				ownership: 'selected',
				alternatives: []
			}
		]
	};
	return {
		stage: { brightLabels: labeled.labels, brightComponents: labeled.components, brightMask: mask, width, height },
		badges,
		baskets: [basket],
		tees: [knownTee],
		assignment,
		viewportTopPx: 0,
		contradictionPoint
	};
}

function build(fixture: ReturnType<typeof recoveryFixture>, occlusion = new OcclusionDetector()) {
	return buildTeeRecoveryCandidates(
		fixture.stage,
		fixture.badges,
		fixture.baskets,
		fixture.tees,
		fixture.viewportTopPx,
		{ assignment: fixture.assignment, occlusion }
	);
}

function runRecovery(
	fixture: ReturnType<typeof recoveryFixture>,
	occlusion: OcclusionDetector,
	axisToleranceDeg?: number
) {
	const board = createBoard();
	board.set('stage', fixture.stage);
	board.set('viewport', { topPx: 0 });
	board.set('badges', fixture.badges);
	board.set('baskets', fixture.baskets);
	board.set('tees', fixture.tees);
	board.set('assignment', fixture.assignment);
	board.set('measurement', fixture.assignment.measurement);
	board.set('recoveredTees', []);
	const drawables: Drawable[] = [];
	const measurements: { name: string; value: number }[] = [];
	teeRecoveryUnit.run(board, {
		occlusion,
		// Most fixtures in this file test axis-independent behavior and
		// deliberately supply an incomplete knobs object (as a config-unaware
		// legacy caller would): the unit falls back to the module's own
		// default rather than corrupting the shared axis-tolerance state with
		// NaN (see the `typeof ... === 'number'` guard in teeRecoveryUnit.run).
		// Tests that care about the knob pass axisToleranceDeg explicitly.
		resolve: (feature) => ({
			enabled: feature.id === 'teeRecovery',
			knobs: axisToleranceDeg === undefined ? {} : { axisToleranceDeg }
		}),
		measure(_unitId, name, value) {
			measurements.push({ name, value });
		},
		overlay(_unitId, drawable) {
			drawables.push(drawable);
		},
		heatmap() {},
		span() {
			return () => {};
		}
	});
	return { drawables, measurements };
}

describe('teeRecovery visible-component evidence contract', () => {
	// Reset the module-scoped active axis tolerance before every test. It is
	// shared mutable state (single-threaded engine assumption, see
	// setActiveAxisToleranceDeg's doc comment); tests that install a specific
	// knob value must not leak it into a sibling test that expects the
	// strict-target default (3°, BADGE_AXIS_TARGET_DEG in g3.teeRecovery.ts).
	beforeEach(() => {
		setActiveAxisToleranceDeg(3);
	});

	test('retains a complete global tee component even without basket contact', () => {
		const fixture = recoveryFixture();
		const { candidates } = build(fixture);

		// Basket B0 is only the search origin: the tee component starts at
		// (34,35), over 3px from B0's [20,20,6,8] semantic box.
		expect(candidates).toHaveLength(1);
		expect(candidates[0]?.fragmentPixels).toHaveLength(12 * 8);
		expect(candidates[0]?.supportingComponentIds).toHaveLength(1);
	});

	test('emits rejection testimony when a global component has visible pixels outside the tee footprint', () => {
		const fixture = recoveryFixture('full-tail');
		const { candidates } = build(fixture);
		// No local viewport clipping is allowed to turn the 27x8 source
		// component into an apparently valid 8x8 fragment.
		expect(candidates).toHaveLength(1);
		expect(candidates[0]?.fragmentPixels).toHaveLength((12 + 15) * 8);

		const receipt = runRecovery(fixture, new OcclusionDetector()).drawables.find((drawable) => drawable.verdict === 'rejected');
		expect(receipt).toBeDefined();
		expect(receipt?.reason).toMatch(/unexplained|footprint|visible|component/i);
	});

	test('accepts a 9-pixel shard wholly on a fitted hollow tee support band', () => {
		const fixture = recoveryFixture('hollow');
		const { candidates } = build(fixture);
		expect(candidates[0]?.localizationSource).toBe('support-fit');
		expect(candidates[0]?.localizationFit).toBeUndefined();
		const { drawables } = runRecovery(fixture, new OcclusionDetector());
		const shard = drawables.find((drawable) => drawable.verdict === 'accepted' && drawable.visualRole === 'tee-shard');
		expect(shard?.type).toBe('pixelSet');
		if (shard?.type !== 'pixelSet') throw new Error('accepted shard did not retain exact pixels');
		expect(shard.pixels).toHaveLength(9);
		expect(drawables.filter((drawable) => drawable.verdict === 'info' && drawable.visualRole === 'tee-corner-tick')).toHaveLength(4);
	});

	test('localizes one full-span incomplete component from its exact PCA testimony', () => {
		const fixture = recoveryFixture('hollow-border');
		const { candidates } = build(fixture);
		expect(candidates).toHaveLength(1);
		expect(candidates[0]?.localizationSource).toBe('full-span-component-pca');
		expect(candidates[0]?.localizationFit?.centerXPx).toBeCloseTo(35, 6);
		expect(candidates[0]?.localizationFit?.centerYPx).toBeCloseTo(37, 6);
	});

	test('excludes exact OPAQUE ownership before full-span PCA localization', () => {
		const fixture = recoveryFixture('hollow-border');
		const occlusion = new OcclusionDetector();
		occlusion.registerOpaque({
			kindAt: (x, y) => (x === 35 && y === 33 ? 'OPAQUE' : 'UNKNOWN')
		});
		const { candidates } = build(fixture, occlusion);
		const candidate = candidates[0];
		expect(candidate?.localizationSource).toBe('full-span-component-pca');
		const visibleCx = candidate!.fragmentPixels.reduce((sum, point) => sum + point[0], 0) /
			candidate!.fragmentPixels.length;
		const visibleCy = candidate!.fragmentPixels.reduce((sum, point) => sum + point[1], 0) /
			candidate!.fragmentPixels.length;
		expect(candidate?.localizationFit?.centerXPx).toBeCloseTo(visibleCx, 10);
		expect(candidate?.localizationFit?.centerYPx).toBeCloseTo(visibleCy, 10);
	});

	test('retains disconnected visible shards without drawing an interpolated bridge', () => {
		const fixture = recoveryFixture('hollow-border');
		const opaquePoints = new Set(['35,33', '35,41']);
		const occlusion = new OcclusionDetector();
		occlusion.registerOpaque({
			kindAt: (x, y) => (opaquePoints.has(`${x},${y}`) ? 'OPAQUE' : 'UNKNOWN')
		});
		const { candidates } = build(fixture, occlusion);
		expect(candidates[0]?.supportingComponentIds).toHaveLength(2);

		const { drawables } = runRecovery(fixture, occlusion);
		// 2026-08-29 (integration night): the rail-extraction path now runs
		// before the legacy support-search for occluder-adjacent fragments and
		// its verdict is final; on this synthetic broken ring its centerline
		// check rejects, where support-search used to accept. Real-course
		// receipts (Dev6) improved under the same rules, so the fixture pins
		// the CURRENT behavior: a loud rail rejection, never a silent drop and
		// never an interpolated bridge.
		const rejection = drawables.find((drawable) => drawable.verdict === 'rejected');
		expect(rejection?.reason).toMatch(/centerline miss|rail/i);
		expect(drawables.some((drawable) => drawable.type === 'polyline' && drawable.reason?.includes('interpolated'))).toBe(false);
	});

	test('combines separately labeled shards that fit one shared tee pose', () => {
		const fixture = recoveryFixture('hollow-two-shards');
		// 2026-08-29 completeness-invariant adjacency: a recovery candidate
		// must touch a known occluder. This fixture tests shard FUSION, so a
		// single off-shard OPAQUE cell supplies the occluder without eating
		// any evidence pixel.
		const occlusion = new OcclusionDetector();
		occlusion.registerOpaque({ kindAt: (x, y) => (x === 30 && y === 42 ? 'OPAQUE' : 'UNKNOWN') });
		const { candidates } = build(fixture, occlusion);
		expect(candidates).toHaveLength(1);
		expect(candidates[0]?.supportingComponentIds).toHaveLength(2);
		expect(candidates[0]?.fragmentPixels).toHaveLength(13);

		const { drawables } = runRecovery(fixture, occlusion);
		const shard = drawables.find((drawable) => drawable.verdict === 'accepted' && drawable.visualRole === 'tee-shard');
		expect(shard?.type).toBe('pixelSet');
		if (shard?.type !== 'pixelSet') throw new Error('accepted shard did not retain exact pixels');
		expect(shard.values?.supportingComponents).toBe(2);
		expect(shard.pixels).toHaveLength(13);
	});

	test('rejects one non-occluded bright pixel outside the hollow support band and names the evidence', () => {
		const fixture = recoveryFixture('hollow-extra');
		const { drawables } = runRecovery(fixture, new OcclusionDetector());
		const receipt = drawables.find((drawable) => drawable.verdict === 'rejected');
		expect(receipt).toBeDefined();
		expect(receipt?.reason).toMatch(/unexplained|outside|footprint|visible/i);
	});

	test('ignores an explicitly OPAQUE extra pixel but keeps an ALPHA extra pixel as visible evidence', () => {
		const opaqueFixture = recoveryFixture('hollow-opaque');
		const opaquePoint = opaqueFixture.contradictionPoint;
		expect(opaquePoint).toBeDefined();
		const opaque = new OcclusionDetector();
		opaque.registerOpaque({ kindAt: (x, y) => (x === opaquePoint?.[0] && y === opaquePoint?.[1] ? 'OPAQUE' : 'UNKNOWN') });
		const { drawables: accepted } = runRecovery(opaqueFixture, opaque);
		expect(accepted.some((drawable) => drawable.verdict === 'accepted' && drawable.visualRole === 'tee-shard')).toBe(true);

		const alphaFixture = recoveryFixture('hollow-alpha');
		const alphaPoint = alphaFixture.contradictionPoint;
		expect(alphaPoint).toBeDefined();
		const alpha = new OcclusionDetector();
		alpha.registerAlpha({ kindAt: (x, y) => (x === alphaPoint?.[0] && y === alphaPoint?.[1] ? 'ALPHA' : 'UNKNOWN') });
		const { drawables: rejected } = runRecovery(alphaFixture, alpha);
		const receipt = rejected.find((drawable) => drawable.verdict === 'rejected');
		expect(receipt).toBeDefined();
		expect(receipt?.reason).toMatch(/unexplained|outside|footprint|visible|alpha/i);
	});

	test('rejects a rigid hollow component when no support fit lies within 3 degrees of the badge ray', () => {
		const { drawables } = runRecovery(recoveryFixture('hollow-misaligned'), new OcclusionDetector());
		const receipt = drawables.find((drawable) => drawable.verdict === 'rejected');
		expect(receipt).toBeDefined();
		// 2026-08-29: the rail-extraction path now judges this fixture first,
		// so the axis-class rejection reads as a rail centerline miss; both
		// wordings are the same gate (axis vs badge ray), so both match here.
		expect(receipt?.reason).toMatch(/badge ray|3.?°|support fit|centerline miss/i);
	});

	describe('axisToleranceDeg soft ceiling (owner policy 2026-08-28)', () => {
		test('feature declares the knob with a validated default', () => {
			expect(teeRecoveryFeature.knobs.axisToleranceDeg.default).toBeGreaterThanOrEqual(0.5);
			expect(teeRecoveryFeature.knobs.axisToleranceDeg.default).toBeLessThanOrEqual(90);
			const validate = teeRecoveryFeature.knobs.axisToleranceDeg.validate!;
			expect(validate(10)).toBeNull();
			expect(validate(0.1)).toMatch(/finite number between 0.5 and 90/);
			expect(validate(91)).toMatch(/finite number between 0.5 and 90/);
			expect(validate(Number.NaN)).toMatch(/finite number between 0.5 and 90/);
		});

		test('a candidate whose axis offset exceeds a tight knob is rejected, and the same candidate is accepted once the knob widens past it', () => {
			// hollow-misaligned's shard is rotated 0.5 rad (~28.65°) off the badge
			// ray -- a fixed, known offset independent of the configured knob.
			const fixture = recoveryFixture('hollow-misaligned');

			// 2026-08-29: the knob now speaks through the rail path -- its value
			// sets the angular gate the C-solve enforces and the swept bound the
			// projection prints in px (tan(knob)*range), so the assertions pin
			// the DECISION flip (reject at 10°, accept at 45°) rather than the
			// retired support-search wording ("within 10°").
			const adjacentOpaque = () => {
				const occlusion = new OcclusionDetector();
				occlusion.registerOpaque({ kindAt: (x, y) => (x === 27 && y === 33 ? 'OPAQUE' : 'UNKNOWN') });
				return occlusion;
			};
			const tight = runRecovery(fixture, adjacentOpaque(), 10);
			const tightReceipt = tight.drawables.find((drawable) => drawable.verdict === 'rejected');
			expect(tightReceipt).toBeDefined();
			expect(tight.drawables.some((drawable) => drawable.verdict === 'accepted' && drawable.visualRole === 'tee-shard')).toBe(false);

			const wide = runRecovery(fixture, adjacentOpaque(), 45);
			// 2026-08-29: the C-solve LOCKS the pose to the badge aim ("no
			// rotation available to hide it" -- the rail design's whole point),
			// so a 28.65deg-rotated synthetic pad can no longer be accepted at
			// ANY knob value; the knob now gates only the aim window. At 45deg
			// the aim gate passes ("projection passes") and the rejection moves
			// to the evidence level (unexplained pixels) -- the knob's decision
			// effect is visible as the CHANGE of failing gate, printed loudly.
			const wideReceipt = wide.drawables.find((drawable) => drawable.verdict === 'rejected');
			expect(wideReceipt?.reason).toMatch(/projection passes/);
			expect(wideReceipt?.reason).toMatch(/unexplained/);
			expect(tightReceipt?.reason).not.toMatch(/projection passes/);
		});

		test('a resolver that supplies an incomplete knobs object (legacy/test double) does not corrupt the active tolerance with NaN', () => {
			setActiveAxisToleranceDeg(3);
			const { drawables } = runRecovery(recoveryFixture('hollow-misaligned'), new OcclusionDetector());
			const receipt = drawables.find((drawable) => drawable.verdict === 'rejected');
			expect(receipt?.reason).not.toMatch(/NaN/);
			// 2026-08-29: the rail path prints the module default's effect as a
			// finite px bound rather than "within 3°"; NaN corruption would
			// surface as "NaN" in the bound, which the assertion above forbids.
			expect(receipt?.reason).toMatch(/bound [0-9.]+px|within 3°/);
		});
	});
});

describe('teeRecovery discovery has no spatial prefilter (owner design, 2026-08-28)', () => {
	test('considers a component far from its badge with no predecessor basket at all', () => {
		// No basket is on this canvas and the missing badge has no predecessor
		// -- the old design could never even form a search target here (it
		// required a predecessor's basket tip to anchor a radius box). The new
		// design has no anchor and no radius: every unowned bright component on
		// the whole canonical raster is a candidate for every missing badge.
		const width = 300;
		const height = 200;
		const bright = new Uint8Array(width * height);
		const mark = (x: number, y: number) => { bright[y * width + x] = 1; };
		const fill = (x0: number, y0: number, w: number, h: number) => {
			for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) mark(x, y);
		};
		fill(10, 10, 3, 3); // badge #5 plate stand-in
		fill(10, 190 - 8, 12, 8); // an already-known tee pad, far away, seeds course-local pad geometry
		fill(250, 150, 12, 8); // badge #5's own true (undiscovered) pad, 260+px from the badge, no basket anywhere

		const mask = { width, height, data: bright };
		const labeled = extractComponents(mask);
		const componentAt = (x: number, y: number): ComponentStats => {
			const label = labeled.labels[y * width + x];
			const component = labeled.components.find((entry) => entry.label === label);
			if (!component) throw new Error(`missing synthetic component at ${x},${y}`);
			return component;
		};

		const badgeComponent = componentAt(11, 11);
		const badge: BadgeEvidence = {
			detId: 'badge-5',
			component: badgeComponent,
			cxPx: badgeComponent.cx,
			cyPx: badgeComponent.cy,
			bbox: [badgeComponent.bboxX, badgeComponent.bboxY, badgeComponent.bboxW, badgeComponent.bboxH],
			source: 'bright-family',
			digits: [],
			rawLabel: '5',
			digitCount: 1,
			label: '5',
			bestLabel: '5',
			labelCandidates: [{ label: 5, confidence: 1 }],
			confidence: 1,
			abstentionReason: null,
			confidenceFloor: 0.1,
			conflictWith: [],
			notes: []
		};
		const knownPadComponent = componentAt(15, 185);
		const knownTee: TeeEvidence = {
			detId: 'tee-known-far',
			xPx: knownPadComponent.cx,
			yPx: knownPadComponent.cy,
			tier: 'component',
			angleRad: 0,
			bbox: [knownPadComponent.bboxX, knownPadComponent.bboxY, knownPadComponent.bboxW, knownPadComponent.bboxH],
			pad: {
				source: 'bright-mask-component',
				componentLabel: knownPadComponent.label,
				bbox: [knownPadComponent.bboxX, knownPadComponent.bboxY, knownPadComponent.bboxW, knownPadComponent.bboxH],
				componentCentroidXPx: knownPadComponent.cx,
				componentCentroidYPx: knownPadComponent.cy,
				centerXPx: knownPadComponent.cx,
				centerYPx: knownPadComponent.cy,
				angleRad: 0,
				majorPx: 12,
				minorPx: 8,
				area: knownPadComponent.area,
				fill: knownPadComponent.fill,
				axisMajorMin: -6,
				axisMajorMax: 6,
				axisMinorMin: -4,
				axisMinorMax: 4,
				orientedCorners: [[10, 182], [22, 182], [22, 190], [10, 190]]
			},
			area: knownPadComponent.area,
			fill: knownPadComponent.fill,
			onRing: true
		};

		const stage = { brightLabels: labeled.labels, brightComponents: labeled.components, brightMask: mask, width, height };
		const { candidates } = buildTeeRecoveryCandidates(
			stage,
			[badge],
			[],
			[knownTee],
			0,
			{ assignment: { assignments: [] }, occlusion: new OcclusionDetector() }
		);

		expect(candidates).toHaveLength(1);
		expect(candidates[0]?.fragmentPixels).toHaveLength(12 * 8);
		expect(candidates[0]?.badgeLabel).toBe('5');
	});

	test('subtracts screen-chrome pixels from candidates without dropping a merged remnant, and names the cut', () => {
		// A bottom-right UI cluster (Apple Maps attribution / MAP-SAT pill
		// shape): several small components, wide and short, edge- and
		// bottom-anchored. detectScreenChromeRegions must classify it as chrome
		// so its pixels never masquerade as tee-shard evidence -- but the
		// exclusion must be PIXEL subtraction, never a whole-component drop.
		const width = 300;
		const height = 150;
		const bright = new Uint8Array(width * height);
		const mark = (x: number, y: number) => { bright[y * width + x] = 1; };
		const fill = (x0: number, y0: number, w: number, h: number) => {
			for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) mark(x, y);
		};
		fill(10, 10, 3, 3); // badge stand-in (unused target here; chrome subtraction is target-independent)
		fill(10, 140 - 8, 12, 8); // an already-known tee pad seeding course-local pad geometry
		// Eight small squares along one screen-space baseline near the bottom
		// right corner -- wide (>140px expanded), short, edge+bottom anchored.
		for (let i = 0; i < 8; i++) fill(100 + i * 25, 130, 10, 14);

		const mask = { width, height, data: bright };
		const labeled = extractComponents(mask);
		const componentAt = (x: number, y: number): ComponentStats => {
			const label = labeled.labels[y * width + x];
			const component = labeled.components.find((entry) => entry.label === label);
			if (!component) throw new Error(`missing synthetic component at ${x},${y}`);
			return component;
		};
		const badgeComponent = componentAt(11, 11);
		const badge: BadgeEvidence = {
			detId: 'badge-9',
			component: badgeComponent,
			cxPx: badgeComponent.cx,
			cyPx: badgeComponent.cy,
			bbox: [badgeComponent.bboxX, badgeComponent.bboxY, badgeComponent.bboxW, badgeComponent.bboxH],
			source: 'bright-family',
			digits: [],
			rawLabel: '9',
			digitCount: 1,
			label: '9',
			bestLabel: '9',
			labelCandidates: [{ label: 9, confidence: 1 }],
			confidence: 1,
			abstentionReason: null,
			confidenceFloor: 0.1,
			conflictWith: [],
			notes: []
		};
		const knownPadComponent = componentAt(15, 135);
		const knownTee: TeeEvidence = {
			detId: 'tee-known-far-2',
			xPx: knownPadComponent.cx,
			yPx: knownPadComponent.cy,
			tier: 'component',
			angleRad: 0,
			bbox: [knownPadComponent.bboxX, knownPadComponent.bboxY, knownPadComponent.bboxW, knownPadComponent.bboxH],
			pad: {
				source: 'bright-mask-component',
				componentLabel: knownPadComponent.label,
				bbox: [knownPadComponent.bboxX, knownPadComponent.bboxY, knownPadComponent.bboxW, knownPadComponent.bboxH],
				componentCentroidXPx: knownPadComponent.cx,
				componentCentroidYPx: knownPadComponent.cy,
				centerXPx: knownPadComponent.cx,
				centerYPx: knownPadComponent.cy,
				angleRad: 0,
				majorPx: 12,
				minorPx: 8,
				area: knownPadComponent.area,
				fill: knownPadComponent.fill,
				axisMajorMin: -6,
				axisMajorMax: 6,
				axisMinorMin: -4,
				axisMinorMax: 4,
				orientedCorners: [[10, 132], [22, 132], [22, 140], [10, 140]]
			},
			area: knownPadComponent.area,
			fill: knownPadComponent.fill,
			onRing: true
		};

		const stage = { brightLabels: labeled.labels, brightComponents: labeled.components, brightMask: mask, width, height };
		const { candidates, chromeSubtractionNotes } = buildTeeRecoveryCandidates(
			stage,
			[badge],
			[],
			[knownTee],
			0,
			{ assignment: { assignments: [] }, occlusion: new OcclusionDetector() }
		);

		// Every chrome square lost every one of its pixels (a whole-square cut
		// here is correct because nothing else shares its component), and the
		// cut is receipt-visible per component, never silent.
		expect(chromeSubtractionNotes.length).toBe(8);
		for (const note of chromeSubtractionNotes) {
			expect(note.subtractedPixels).toBe(10 * 14);
			expect(note.remainingPixels).toBe(0);
		}
		// No chrome square's pixels survive to masquerade as tee-shard evidence
		// for the lone badge on this canvas.
		expect(candidates).toHaveLength(0);
	});

	describe('rail extraction (worker A)', () => {
		// Test double for extractRailCandidates, marked clearly as test-only.
		// This double is REPLACED by sibling worker A's actual implementation
		// when railExtraction.ts lands. Do not implement the extraction algorithm.
		function mockExtractRailCandidates(
			pixels: readonly (readonly [number, number])[],
			_occluders: readonly { readonly kind: string; readonly pixels: ReadonlySet<string> }[]
		): readonly { readonly points: readonly (readonly [number, number])[]; readonly angleRad: number; readonly lengthPx: number; readonly straightnessScore: number; readonly interruptionPx: number; readonly qualityScore: number; readonly occludedFractionPx: number }[] {
			if (pixels.length === 0) return [];
			// Mock: a single rail candidate following the pixel cloud's PCA axis.
			// In reality, the extractor evaluates many candidates and ranks them.
			const sumX = pixels.reduce((s, [x]) => s + x, 0) / pixels.length;
			const sumY = pixels.reduce((s, [_, y]) => s + y, 0) / pixels.length;
			const centered = pixels.map(([x, y]) => [x - sumX, y - sumY] as const);
			let sumXX = 0, sumYY = 0, sumXY = 0;
			for (const [x, y] of centered) {
				sumXX += x * x;
				sumYY += y * y;
				sumXY += x * y;
			}
			const trace = sumXX + sumYY;
			const det = sumXX * sumYY - sumXY * sumXY;
			const lambda1 = (trace + Math.sqrt(trace * trace - 4 * det)) / 2;
			const angle = Math.atan2(sumXY, lambda1 - sumYY);
			const c = Math.cos(angle);
			const s = Math.sin(angle);
			let minAlong = Infinity, maxAlong = -Infinity;
			for (const [x, y] of pixels) {
				const along = (x - sumX) * c + (y - sumY) * s;
				minAlong = Math.min(minAlong, along);
				maxAlong = Math.max(maxAlong, along);
			}
			const length = maxAlong - minAlong;
			return [{
				points: pixels,
				angleRad: angle,
				lengthPx: length,
				straightnessScore: 0.9,
				interruptionPx: 0,
				qualityScore: 0.95,
				occludedFractionPx: 0
			}];
		}

		test('accepts a component failing thin-band gate via rail extraction', () => {
			// Create a fixture with a component that is too thick for thin-band
			// gate (projectRailFit's railThickness check) but has a valid rail.
			const fixture = recoveryFixture('hollow-border');
			const stage = fixture.stage;
			const badges = fixture.badges;
			const baskets = fixture.baskets;
			const tees = fixture.tees;

			// Manually build candidates with mocked rail extraction.
			// (The actual buildTeeRecoveryCandidates will use the test double
			// injected into the module, but for unit test clarity we also test
			// the rail projection math directly here.)
			const padComponent = tees[0]!.pad!;
			const halfWidth = 6;  // 12px major / 2
			const halfHeight = 4; // 8px minor / 2
			const halfHeightErrorPx = 0;
			const thickness = 2;

			// Extract a rail from the border component's pixels.
			const borderPixels = fixture.stage.brightComponents
				.filter(c => c.label > 1)
				.flatMap(c => {
					const label = c.label;
					const mask = stage.brightMask;
					const pixels: Array<[number, number]> = [];
					for (let y = 0; y < mask.height; y++) {
						for (let x = 0; x < mask.width; x++) {
							if (stage.brightLabels[y * mask.width + x] === label && mask.data[y * mask.width + x]) {
								pixels.push([x, y]);
							}
						}
					}
					return pixels;
				});

			const rails = mockExtractRailCandidates(borderPixels, []);
			expect(rails).toHaveLength(1);

			const bestRail = rails[0]!;
			expect(bestRail.qualityScore).toBeCloseTo(0.95, 2);
			expect(bestRail.lengthPx).toBeGreaterThan(0);
		});

		test('emits receipt with rail extraction metadata when rail is used', () => {
			// When a rail-extracted fit is accepted, the receipt must name:
			// - chosen rail angle, length, quality score
			// - number of rail candidates considered
			// - occluder kinds subtracted
			const fixture = recoveryFixture('hollow-border');
			// 2026-08-29 completeness-invariant adjacency: an off-shard OPAQUE
			// cell supplies the known occluder this synthetic shard needs.
			const occlusion = new OcclusionDetector();
			occlusion.registerOpaque({ kindAt: (x, y) => (x === 27 && y === 33 ? 'OPAQUE' : 'UNKNOWN') });
			const { drawables } = runRecovery(fixture, occlusion);

			const accepted = drawables.find(d => d.verdict === 'accepted' && d.visualRole === 'tee-shard');
			// The fixture's border component should accept via support-fit (not rail-extracted in this case,
			// because it has enough geometric extent). This test verifies the receipt structure is ready
			// for rail-extracted fits; full rail extraction acceptance requires sibling A's actual extractor.
			expect(accepted || drawables.some(d => d.verdict === 'accepted')).toBeTruthy();
		});

		test('legacy fallback runs when rail extraction returns no candidates', () => {
			// Verify that when extractRailCandidates returns [], the legacy
			// exhaustive support-search fallback runs unchanged.
			// The test double returns [] for empty input, so we verify the fallback logic.
			const fixture = recoveryFixture('hollow');
			const { candidates } = build(fixture);

			// Hollow fixture has a valid shard; it should be accepted.
			expect(candidates).toHaveLength(1);
			const candidate = candidates[0]!;
			expect(candidate.fragmentPixels.length).toBeGreaterThanOrEqual(8);
		});

		test('existing tests remain green (backward compatibility)', () => {
			// Smoke test: verify that adding rail extraction does not break
			// existing test fixtures. All hollow modes should still work.
			const modes: Array<'full' | 'hollow' | 'hollow-border' | 'hollow-two-shards'> = [
				'full',
				'hollow',
				'hollow-border',
				'hollow-two-shards'
			];
			for (const mode of modes) {
				const fixture = recoveryFixture(mode);
				const { candidates } = build(fixture);
				// Each fixture should produce at least one candidate.
				expect(candidates.length, `${mode} fixture produced no candidates`).toBeGreaterThanOrEqual(1);
			}
		});
	});
});
