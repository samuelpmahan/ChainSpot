import { describe, expect, test } from 'vitest';
import type { SerializableTransform } from '../../src/lib/alignment/types';
import type { AnnotatedHole } from '../../src/lib/domain/annotatedRound';
import { buildCourseOverviewMarkup } from '../../src/lib/graphics/courseOverview';
import { BROADCAST_FRAME, composeBroadcastFrame, fitCropToAspect, holeLengthLabel, placeInFrame } from '../../src/lib/graphics/frame';
import { planHoleGraphic } from '../../src/lib/holeGraphics';

const transform = (k: number): SerializableTransform => ({
	model: 'similarity',
	coefficients: [k, 0, 0, k, 0, 0],
	isInvertible: true,
	determinant: k * k,
	orientation: 1,
	majorAxisScale: k,
	minorAxisScale: k,
	anisotropy: 1,
	shear: 0
});

const hole: AnnotatedHole = {
	id: 'hole-7',
	number: 7,
	tee: { xPx: 200, yPx: 300 },
	basket: { xPx: 500, yPx: 300 },
	shots: [],
	corridorBends: [{ xPx: 350, yPx: 340 }],
	corridorWidthPx: 40
};

describe('placeInFrame (Creator v0 renderScene anchor/scale)', () => {
	test('clamps the scale so the whole composition stays in the 1800 x 960 safe area', () => {
		expect(placeInFrame(900, 100).scale).toBe(2);
		expect(placeInFrame(100, 480).scale).toBe(2);
		expect(placeInFrame(900, 480, 'center', 1.5).scale).toBe(1.5);
	});
	test('anchors at the centre or at a 60 px margin corner', () => {
		expect(placeInFrame(900, 480, 'center', 1)).toEqual({ x: 510, y: 300, scale: 1 });
		expect(placeInFrame(900, 480, 'top-left', 1)).toEqual({ x: 60, y: 60, scale: 1 });
		expect(placeInFrame(900, 480, 'bottom-right', 1)).toEqual({ x: 1920 - 60 - 900, y: 1080 - 60 - 480, scale: 1 });
	});
});

describe('fitCropToAspect', () => {
	test('grows the crop to the aspect about its centre, never shrinks it, and stays inside the target', () => {
		const plan = planHoleGraphic(hole, transform(1), 1000, 1000)!;
		const fitted = fitCropToAspect(plan, 1800 / 960);
		expect(fitted.crop.widthPx / fitted.crop.heightPx).toBeCloseTo(1800 / 960, 9);
		expect(fitted.crop.widthPx).toBeGreaterThanOrEqual(plan.crop.widthPx);
		expect(fitted.crop.heightPx).toBeGreaterThanOrEqual(plan.crop.heightPx);
		expect(fitted.crop.xPx).toBeLessThanOrEqual(plan.crop.xPx);
		expect(fitted.crop.yPx).toBeLessThanOrEqual(plan.crop.yPx);
		expect(fitted.crop.xPx + fitted.crop.widthPx).toBeLessThanOrEqual(1000);
	});
	test('is clipped by a target smaller than the aspect needs', () => {
		const plan = planHoleGraphic(hole, transform(1), 600, 400)!;
		const fitted = fitCropToAspect(plan, 10);
		expect(fitted.crop.xPx).toBe(0);
		expect(fitted.crop.widthPx).toBe(600);
	});
});

describe('holeLengthLabel', () => {
	const plan = planHoleGraphic(hole, transform(1), 1000, 1000)!;
	const centerline = Math.hypot(150, 40) * 2;
	test('px, labelled as px of the named image, when no ground scale is known', () => {
		expect(holeLengthLabel(plan, 'IMG_5641.jpg')).toEqual({
			value: Math.round(centerline),
			unit: 'px',
			referent: 'along the centerline, px of IMG_5641.jpg (no ground scale yet)'
		});
	});
	test('feet when the ground scale is known, with its referent', () => {
		const label = holeLengthLabel(plan, 'naip.png', 2, 'USGS NAIP, 0.293 m/px');
		expect(label).toEqual({ value: Math.round(centerline * 2), unit: 'ft', referent: 'along the centerline, ground scale USGS NAIP, 0.293 m/px' });
	});
	test('no tee or basket, no number', () => {
		expect(holeLengthLabel({ ...plan, tee: null }, 'x.png')).toBeNull();
	});
});

describe('composeBroadcastFrame', () => {
	test('is a 1920 x 1080 frame embedding the product hole graphic, with no info card inside the map', () => {
		const plan = planHoleGraphic(hole, transform(1), 1000, 1000)!;
		const frame = composeBroadcastFrame(plan, 'data:image/png;base64,AAAA', { targetName: 'shot.png', courseName: "Dash's Track" });
		expect(frame.svg.startsWith(`<svg xmlns="http://www.w3.org/2000/svg" width="${BROADCAST_FRAME.widthPx}" height="${BROADCAST_FRAME.heightPx}"`)).toBe(true);
		expect(frame.svg).toContain('href="data:image/png;base64,AAAA"');
		expect(frame.svg).toContain('HOLE 7');
		expect(frame.svg).toContain(' px</text>');
		expect(frame.svg).toContain("DASH'S TRACK");
		expect(frame.svg).not.toContain('>Hole 7<');
		// Filled to the safe area: 1800 x 960 at margin 60.
		expect(frame.bounds.width).toBeCloseTo(1800, 6);
		expect(frame.bounds.height).toBeCloseTo(960, 6);
		expect(frame.bounds.x).toBeCloseTo(60, 6);
	});

	test('the same hole at two target scales gives the same frame layout and title card', () => {
		const small = composeBroadcastFrame(planHoleGraphic(hole, transform(1), 1000, 1000)!, 'blob:t', { targetName: 'a.png', feetPerPixel: 1 });
		const large = composeBroadcastFrame(planHoleGraphic(hole, transform(3), 3000, 3000)!, 'blob:t', { targetName: 'a.png', feetPerPixel: 1 / 3 });
		for (const key of ['x', 'y', 'width', 'height'] as const) expect(large.bounds[key]).toBeCloseTo(small.bounds[key], 6);
		expect(large.effectiveScale * 3).toBeCloseTo(small.effectiveScale, 9);
		expect(large.length).toEqual(small.length);
		const card = (svg: string) => svg.slice(svg.indexOf('<g data-role="title-card">'));
		expect(card(large.svg)).toBe(card(small.svg));
		// Marker radius on screen = unit x scale: the same on both.
		const radius = (svg: string, scale: number) => Number(/<circle[^>]* r="([0-9.]+)"/.exec(svg)![1]) * scale;
		expect(radius(large.svg, large.effectiveScale)).toBeCloseTo(radius(small.svg, small.effectiveScale), 2);
	});
});

describe('buildCourseOverviewMarkup', () => {
	test('one raster, every hole overlay and label, the pairs, and a legend', () => {
		const plans = [hole, { ...hole, id: 'hole-8', number: 8, tee: { xPx: 600, yPx: 700 }, basket: { xPx: 800, yPx: 650 }, corridorBends: [] }].map(
			(h) => planHoleGraphic(h, transform(1), 1000, 1000)!
		);
		const markup = buildCourseOverviewMarkup(plans, 'blob:basemap', 1000, 1000, {
			needsReview: new Set(['hole-8']),
			pairs: [{ id: 'p1', label: 'Tee 7', target: { xPx: 10, yPx: 10 }, expected: { xPx: 12, yPx: 11 } }],
			summary: ['similarity fit on 4 pairs'],
			title: 'Test'
		});
		expect(markup.match(/<image /g)!.length).toBe(1);
		expect(markup).toContain('data-hole="7"');
		expect(markup).toContain('data-hole="8"');
		expect(markup).toContain('data-pair="p1"');
		expect(markup).toContain('hole the CV flags for review');
		expect(markup).toContain('similarity fit on 4 pairs');
		expect(markup).not.toContain('>Hole 7<');
	});
});

describe('composeBroadcastFrame title card placement', () => {
	test('moves off the bottom-left corner when the tee sits there', () => {
		// A hole whose tee lands bottom-left of its (16:9-filled) crop.
		const plan = planHoleGraphic({ ...hole, tee: { xPx: 100, yPx: 600 }, basket: { xPx: 700, yPx: 300 }, corridorBends: [] }, transform(1), 1000, 1000)!;
		const frame = composeBroadcastFrame(plan, 'blob:t', { targetName: 'a.png' });
		const card = /<g data-role="title-card"><rect x="([0-9.]+)" y="([0-9.]+)"/.exec(frame.svg)!;
		const [cx, cy] = [Number(card[1]), Number(card[2])];
		const s = frame.effectiveScale;
		const tee = { x: frame.bounds.x + (plan.tee!.xPx - frame.plan.crop.xPx) * s, y: frame.bounds.y + (plan.tee!.yPx - frame.plan.crop.yPx) * s };
		expect(cx > tee.x || cy > tee.y + 20 || cy + 200 < tee.y).toBe(true);
	});
});
