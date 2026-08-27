import { describe, expect, test } from 'vitest';
import { extractComponents, type ComponentStats } from '@chainspot/alg/detectors/threeFactor/components';
import {
	buildTeeRecoveryCandidates,
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
	// Badge #1 (predecessor), badge #2 (target), and one known tee pad.
	fill(10, 10, 3, 3);
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
			label,
			labelCandidates: [{ label: Number(label), confidence: 1 }],
			confidence: 1
		};
	};
	const badges = [badgeEvidence('badge-1', '1', 10, 10), badgeEvidence('badge-2', '2', 69, 36)];
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

function runRecovery(fixture: ReturnType<typeof recoveryFixture>, occlusion: OcclusionDetector) {
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
	teeRecoveryUnit.run(board, {
		occlusion,
		resolve: (feature) => ({ enabled: feature.id === 'teeRecovery', knobs: {} }),
		measure() {},
		overlay(_unitId, drawable) {
			drawables.push(drawable);
		},
		heatmap() {},
		span() {
			return () => {};
		}
	});
	return drawables;
}

describe('teeRecovery visible-component evidence contract', () => {
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

		const receipt = runRecovery(fixture, new OcclusionDetector()).find((drawable) => drawable.verdict === 'rejected');
		expect(receipt).toBeDefined();
		expect(receipt?.reason).toMatch(/unexplained|footprint|visible|component/i);
	});

	test('accepts a 9-pixel shard wholly on a fitted hollow tee support band', () => {
		const fixture = recoveryFixture('hollow');
		const drawables = runRecovery(fixture, new OcclusionDetector());
		const shard = drawables.find((drawable) => drawable.verdict === 'accepted' && drawable.visualRole === 'tee-shard');
		expect(shard?.type).toBe('pixelSet');
		if (shard?.type !== 'pixelSet') throw new Error('accepted shard did not retain exact pixels');
		expect(shard.pixels).toHaveLength(9);
		expect(drawables.filter((drawable) => drawable.verdict === 'info' && drawable.visualRole === 'tee-corner-tick')).toHaveLength(4);
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

		const drawables = runRecovery(fixture, occlusion);
		const shard = drawables.find((drawable) => drawable.verdict === 'accepted' && drawable.visualRole === 'tee-shard');
		expect(shard?.type).toBe('pixelSet');
		if (shard?.type !== 'pixelSet') throw new Error('accepted shard did not retain exact pixels');
		expect(shard.values?.supportingComponents).toBe(2);
		expect(shard.pixels).not.toContainEqual([35, 33]);
		expect(shard.pixels).not.toContainEqual([35, 41]);
	});

	test('combines separately labeled shards that fit one shared tee pose', () => {
		const fixture = recoveryFixture('hollow-two-shards');
		const { candidates } = build(fixture);
		expect(candidates).toHaveLength(1);
		expect(candidates[0]?.supportingComponentIds).toHaveLength(2);
		expect(candidates[0]?.fragmentPixels).toHaveLength(13);

		const drawables = runRecovery(fixture, new OcclusionDetector());
		const shard = drawables.find((drawable) => drawable.verdict === 'accepted' && drawable.visualRole === 'tee-shard');
		expect(shard?.type).toBe('pixelSet');
		if (shard?.type !== 'pixelSet') throw new Error('accepted shard did not retain exact pixels');
		expect(shard.values?.supportingComponents).toBe(2);
		expect(shard.pixels).toHaveLength(13);
	});

	test('rejects one non-occluded bright pixel outside the hollow support band and names the evidence', () => {
		const fixture = recoveryFixture('hollow-extra');
		const drawables = runRecovery(fixture, new OcclusionDetector());
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
		const accepted = runRecovery(opaqueFixture, opaque);
		expect(accepted.some((drawable) => drawable.verdict === 'accepted' && drawable.visualRole === 'tee-shard')).toBe(true);

		const alphaFixture = recoveryFixture('hollow-alpha');
		const alphaPoint = alphaFixture.contradictionPoint;
		expect(alphaPoint).toBeDefined();
		const alpha = new OcclusionDetector();
		alpha.registerAlpha({ kindAt: (x, y) => (x === alphaPoint?.[0] && y === alphaPoint?.[1] ? 'ALPHA' : 'UNKNOWN') });
		const rejected = runRecovery(alphaFixture, alpha);
		const receipt = rejected.find((drawable) => drawable.verdict === 'rejected');
		expect(receipt).toBeDefined();
		expect(receipt?.reason).toMatch(/unexplained|outside|footprint|visible|alpha/i);
	});

	test('rejects a rigid hollow component when no support fit lies within 3 degrees of the badge ray', () => {
		const drawables = runRecovery(recoveryFixture('hollow-misaligned'), new OcclusionDetector());
		const receipt = drawables.find((drawable) => drawable.verdict === 'rejected');
		expect(receipt).toBeDefined();
		expect(receipt?.reason).toMatch(/badge ray|3.?°|support fit/i);
	});
});
