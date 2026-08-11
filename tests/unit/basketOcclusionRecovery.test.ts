import { describe, expect, it } from 'vitest';
import {
	basketRecoverySamplesFromGrammar,
	basketRecoverySearchRadiusPx,
	deriveBasketDistanceBand,
	findOccludedBasketMatch,
	findUnresolvedBasketHoles,
	isSameBasketCandidate,
	MIN_MASKED_SCORE
} from '../../src/lib/autoAnnotation/basketOcclusionRecovery';
import type {
	BasketFallbackRaster,
	BasketFallbackTemplate,
	BasketRecoveryGrammarHole,
	BasketRecoveryHoleSample
} from '../../src/lib/autoAnnotation/basketOcclusionRecovery';

/** A basket-shaped template: a wide "cage" top, a tapered body, and a thin dark stem -- distinctive enough that masked correlation over only a fragment of it is still meaningful. */
function buildTemplate(widthPx = 20, heightPx = 30): BasketFallbackTemplate {
	const gray = new Uint8Array(widthPx * heightPx);
	for (let y = 0; y < heightPx; y += 1) {
		for (let x = 0; x < widthPx; x += 1) {
			let value: number;
			if (y < heightPx * 0.45) {
				value = x >= widthPx * 0.1 && x <= widthPx * 0.9 ? 220 : 90;
			} else if (y < heightPx * 0.8) {
				value = x >= widthPx * 0.3 && x <= widthPx * 0.65 ? 195 : 90;
			} else {
				value = x >= widthPx * 0.45 && x <= widthPx * 0.55 ? 55 : 90;
			}
			gray[y * widthPx + x] = value;
		}
	}
	return { gray, widthPx, heightPx };
}

function blankRaster(widthPx: number, heightPx: number, background = 130): BasketFallbackRaster {
	return { gray: new Uint8Array(widthPx * heightPx).fill(background), widthPx, heightPx };
}

function stampTemplate(raster: BasketFallbackRaster, template: BasketFallbackTemplate, leftPx: number, topPx: number): void {
	for (let y = 0; y < template.heightPx; y += 1) {
		for (let x = 0; x < template.widthPx; x += 1) {
			const rx = leftPx + x;
			const ry = topPx + y;
			if (rx < 0 || ry < 0 || rx >= raster.widthPx || ry >= raster.heightPx) continue;
			(raster.gray as Uint8Array)[ry * raster.widthPx + rx] = template.gray[y * template.widthPx + x];
		}
	}
}

/** Paints a solid badge-colored rectangle over the raster, simulating a number badge occluding whatever is underneath. */
function paintBadge(raster: BasketFallbackRaster, xPx: number, yPx: number, widthPx: number, heightPx: number): void {
	const left = Math.round(xPx - widthPx / 2);
	const top = Math.round(yPx - heightPx / 2);
	for (let y = 0; y < heightPx; y += 1) {
		for (let x = 0; x < widthPx; x += 1) {
			const rx = left + x;
			const ry = top + y;
			if (rx < 0 || ry < 0 || rx >= raster.widthPx || ry >= raster.heightPx) continue;
			(raster.gray as Uint8Array)[ry * raster.widthPx + rx] = 10;
		}
	}
}

describe('deriveBasketDistanceBand', () => {
	it('returns undefined without enough trusted samples to learn a course geometry from', () => {
		const samples: BasketRecoveryHoleSample[] = [
			{ holeNumber: 1, distancePx: 100, trusted: true },
			{ holeNumber: 2, distancePx: 110, trusted: true },
			{ holeNumber: 3, distancePx: 90, trusted: false }
		];
		expect(deriveBasketDistanceBand(samples)).toBeUndefined();
	});

	it('learns a plausible band from trusted samples only, ignoring untrusted ones', () => {
		const samples: BasketRecoveryHoleSample[] = [
			{ holeNumber: 1, distancePx: 60, trusted: true },
			{ holeNumber: 2, distancePx: 100, trusted: true },
			{ holeNumber: 3, distancePx: 120, trusted: true },
			{ holeNumber: 4, distancePx: 150, trusted: true },
			{ holeNumber: 5, distancePx: 5000, trusted: false }
		];
		const band = deriveBasketDistanceBand(samples);
		expect(band).toBeDefined();
		expect(band!.lowPx).toBeLessThan(100);
		expect(band!.highPx).toBeLessThan(1000);
		expect(band!.highPx).toBeGreaterThan(band!.lowPx);
	});
});

describe('findUnresolvedBasketHoles', () => {
	it('flags only holes whose assignment distance falls outside the learned band', () => {
		const band = { lowPx: 50, highPx: 200 };
		const samples: BasketRecoveryHoleSample[] = [
			{ holeNumber: 1, distancePx: 100, trusted: true },
			{ holeNumber: 2, distancePx: 1200, trusted: false },
			{ holeNumber: 3, distancePx: 10, trusted: false }
		];
		const unresolved = findUnresolvedBasketHoles(samples, band);
		expect(unresolved.has(1)).toBe(false);
		expect(unresolved.has(2)).toBe(true);
		expect(unresolved.has(3)).toBe(true);
	});
});

describe('basketRecoverySamplesFromGrammar', () => {
	it('marks ambiguous/polarity-conflicted holes untrusted and skips holes missing a badge or basket', () => {
		const holes: BasketRecoveryGrammarHole[] = [
			{
				number: 1,
				numberBadge: {},
				basket: { distancePx: 90, detectorConfidence: 0.9 },
				failures: []
			},
			{
				number: 2,
				numberBadge: {},
				basket: { distancePx: 120, detectorConfidence: 0.9 },
				failures: [{ kind: 'ambiguous-basket' }]
			},
			{
				number: 3,
				numberBadge: {},
				basket: { distancePx: 130, detectorConfidence: 0.9 },
				failures: [{ kind: 'basket-polarity-conflict' }]
			},
			{
				number: 4,
				numberBadge: {},
				basket: { distancePx: 140, detectorConfidence: 0.3 },
				failures: []
			},
			{ number: 5, numberBadge: {}, failures: [] },
			{ number: 6, basket: { distancePx: 999, detectorConfidence: 0.9 }, failures: [] }
		];
		const samples = basketRecoverySamplesFromGrammar(holes);
		expect(samples.map((sample) => sample.holeNumber)).toEqual([1, 2, 3, 4]);
		expect(samples.find((sample) => sample.holeNumber === 1)?.trusted).toBe(true);
		expect(samples.find((sample) => sample.holeNumber === 2)?.trusted).toBe(false);
		expect(samples.find((sample) => sample.holeNumber === 3)?.trusted).toBe(false);
		expect(samples.find((sample) => sample.holeNumber === 4)?.trusted).toBe(false);
	});
});

describe('isSameBasketCandidate', () => {
	it('treats near-identical positions as the same physical basket', () => {
		const a = { xPx: 100, yPx: 100, widthPx: 40, heightPx: 60 };
		const b = { xPx: 104, yPx: 101, widthPx: 40, heightPx: 60 };
		expect(isSameBasketCandidate(a, b)).toBe(true);
	});

	it('treats candidates far enough apart as distinct baskets', () => {
		const a = { xPx: 100, yPx: 100, widthPx: 40, heightPx: 60 };
		const b = { xPx: 160, yPx: 100, widthPx: 40, heightPx: 60 };
		expect(isSameBasketCandidate(a, b)).toBe(false);
	});
});

describe('findOccludedBasketMatch', () => {
	it('recovers a basket whose upper body is covered by a badge-sized rectangle, from the surviving fragment alone', () => {
		const template = buildTemplate();
		const raster = blankRaster(240, 240);
		const trueLeft = 110;
		const trueTop = 100;
		stampTemplate(raster, template, trueLeft, trueTop);
		// Cover most of the cage + tapered body with a badge-sized rectangle,
		// leaving only the stem (plus a sliver of the body) visible -- mirrors
		// the real Lenard hole-9 occlusion this module exists for, where the
		// number badge covers most of the basket glyph.
		const badgeCenterX = trueLeft + template.widthPx / 2;
		const badgeCenterY = trueTop + template.heightPx * 0.33;
		const badgeWidthPx = template.widthPx + 6;
		const badgeHeightPx = template.heightPx * 0.5;
		paintBadge(raster, badgeCenterX, badgeCenterY, badgeWidthPx, badgeHeightPx);

		const trueXPx = trueLeft + template.widthPx / 2;
		const trueYPx = trueTop + template.heightPx * 0.96;
		const match = findOccludedBasketMatch(
			raster,
			template,
			trueXPx + 15, // search center deliberately offset from the true location
			trueYPx - 10,
			40,
			[1],
			[{ xPx: badgeCenterX, yPx: badgeCenterY, widthPx: badgeWidthPx, heightPx: badgeHeightPx }]
		);

		expect(match).toBeDefined();
		expect(match!.score).toBeGreaterThanOrEqual(MIN_MASKED_SCORE);
		expect(Math.hypot(match!.xPx - trueXPx, match!.yPx - trueYPx)).toBeLessThan(6);
		// The badge covered most of the template; only a minority should remain trusted.
		expect(match!.trustedFraction).toBeLessThan(0.5);
	});

	it('does not fabricate a match where the ROI has no real basket-shaped evidence', () => {
		const template = buildTemplate();
		const raster = blankRaster(240, 240, 128);
		const badgeCenterX = 150;
		const badgeCenterY = 130;
		const match = findOccludedBasketMatch(
			raster,
			template,
			badgeCenterX,
			badgeCenterY,
			40,
			[1],
			[{ xPx: badgeCenterX, yPx: badgeCenterY, widthPx: template.widthPx + 6, heightPx: template.heightPx * 0.66 }]
		);
		expect(match).toBeUndefined();
	});
});

describe('basketRecoverySearchRadiusPx', () => {
	it('never searches narrower than the band high edge, and applies a margin above it', () => {
		const band = { lowPx: 50, highPx: 200 };
		expect(basketRecoverySearchRadiusPx(band)).toBeGreaterThan(band.highPx);
	});

	it('floors the radius for a very tight learned band instead of searching a near-zero window', () => {
		const band = { lowPx: 5, highPx: 10 };
		expect(basketRecoverySearchRadiusPx(band)).toBeGreaterThanOrEqual(60);
	});
});
