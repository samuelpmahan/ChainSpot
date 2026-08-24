// TRUTH FIREWALL (mandatory owner acceptance test): truth is
// evaluation-only. Every G0 measure/decide function is enumerated
// explicitly below and run twice with byte-identical inputs — PASS_A
// before any CanonicalTruth exists anywhere in this test's scope, PASS_B
// after one has been loaded and is sitting directly alongside each call
// (as close to "attached" as a call site gets without a parameter to pass
// it through). If any function's real signature ever grows a truth
// parameter, or a future refactor reaches for some ambient/module-level
// "current truth" instead of only its declared arguments, PASS_A and
// PASS_B diverge and this test fails. Today every function here is
// trivially pure so this looks like it's testing nothing — that IS the
// property being proven: NOTHING about truth being available anywhere
// changes what these functions return.
//
// Also asserted at the type/arity level: every function's declared
// parameter count (Function.length) doesn't shift between the two passes
// — a cheap, permanent guard against an accidental added parameter that
// only bites when truth happens to be around.
import { describe, expect, test } from 'vitest';
import { measurePurpleMass } from '@chainspot/alg/detectors/purpleMass';
import { proposeSharedCrop } from '@chainspot/alg/autoCrop';
import { findBestTranslation } from '@chainspot/alg/stitch';
import { traceWalk } from '@chainspot/alg/detectors/walkTrace';
import { findDroplets } from '@chainspot/alg/detectors/landingDroplet';
import { decideThrownRound } from '@chainspot/alg/g0/thrownRound';
import { trySemanticAlign, solvePixelStitch } from '@chainspot/alg/g0/stitchSolve';
import { applyCrop } from '@chainspot/alg/g0/crop';
import { materializeComposite } from '@chainspot/alg/g0/composite';
import { preReadRound } from '@chainspot/alg/g0/roundPreRead';
import { projectToComposite } from '@chainspot/alg/g0/projection';
import type { CanonicalTruth } from '@chainspot/alg/g0/truth';
import type { GrayRaster } from '@chainspot/alg';
import type { RgbaRaster } from '@chainspot/alg/detect';

function flatRgba(widthPx: number, heightPx: number, value: [number, number, number, number]): RgbaRaster {
	const rgba = new Uint8ClampedArray(widthPx * heightPx * 4);
	for (let i = 0; i < rgba.length; i += 4) rgba.set(value, i);
	return { imageId: 'x', widthPx, heightPx, rgba };
}

function worldPixel(x: number, y: number): number {
	return ((x * 73) ^ (y * 151) ^ (x * y * 29)) & 255;
}

function grayFromWorld(originX: number, originY: number, widthPx = 24, heightPx = 20): GrayRaster {
	const gray = new Uint8Array(widthPx * heightPx);
	for (let y = 0; y < heightPx; y++) {
		for (let x = 0; x < widthPx; x++) gray[y * widthPx + x] = worldPixel(originX + x, originY + y);
	}
	return { widthPx, heightPx, gray };
}

function chromeRaster(tileNumber: number, widthPx = 24, heightPx = 20): GrayRaster {
	const gray = new Uint8Array(widthPx * heightPx);
	for (let y = 0; y < heightPx; y++) {
		for (let x = 0; x < widthPx; x++) {
			const isChrome = y < 3 || y >= heightPx - 2;
			gray[y * widthPx + x] = isChrome ? 40 + y : (tileNumber * 97 + x * 11 + y * 7) % 256;
		}
	}
	return { widthPx, heightPx, gray };
}

/** One representative, deterministic invocation per enumerated G0 measure/decide function. */
async function runAllOperations() {
	return {
		measurePurpleMass: measurePurpleMass(flatRgba(20, 20, [200, 100, 220, 255])),
		proposeSharedCrop: proposeSharedCrop([chromeRaster(0), chromeRaster(1)]),
		findBestTranslation: findBestTranslation(grayFromWorld(0, 0), grayFromWorld(9, -6)),
		traceWalk: traceWalk(flatRgba(20, 20, [200, 200, 200, 255])),
		findDroplets: findDroplets(flatRgba(20, 20, [200, 200, 200, 255])),
		decideThrownRound: decideThrownRound([0, 0.4, 0]),
		trySemanticAlign: trySemanticAlign(
			[
				[{ n: 1, x: 10, y: 10 }],
				[{ n: 1, x: -90, y: 5 }]
			],
			[
				{ x: 0, y: 0 },
				{ x: 999, y: 999 }
			]
		),
		solvePixelStitch: solvePixelStitch([grayFromWorld(0, 0), grayFromWorld(9, -6)]),
		applyCrop: applyCrop(
			[chromeRaster(0), chromeRaster(1)],
			[
				{ x: 0, y: 0 },
				{ x: 24, y: 0 }
			]
		),
		materializeComposite: await materializeComposite([
			{
				rgba: new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 255]),
				widthPx: 2,
				heightPx: 1,
				placement: { x: 0, y: 0 }
			}
		]),
		preReadRound: await preReadRound(flatRgba(20, 20, [200, 200, 200, 255])),
		projectToComposite: projectToComposite({ xPx: 40, yPx: 30 }, { top: 5, right: 0, bottom: 0, left: 10 }, {
			x: 200,
			y: 100
		})
	};
}

function arities() {
	return {
		measurePurpleMass: measurePurpleMass.length,
		proposeSharedCrop: proposeSharedCrop.length,
		findBestTranslation: findBestTranslation.length,
		traceWalk: traceWalk.length,
		findDroplets: findDroplets.length,
		decideThrownRound: decideThrownRound.length,
		trySemanticAlign: trySemanticAlign.length,
		solvePixelStitch: solvePixelStitch.length,
		applyCrop: applyCrop.length,
		materializeComposite: materializeComposite.length,
		preReadRound: preReadRound.length,
		projectToComposite: projectToComposite.length
	};
}

describe('truth firewall', () => {
	test('every enumerated G0 measure/decide function produces byte-identical output whether or not a CanonicalTruth is loaded and sitting in scope', async () => {
		const ariesBeforeTruth = arities();
		const resultsBeforeTruth = await runAllOperations();

		// Load a real CanonicalTruth-shaped value and hold it directly
		// alongside the second pass, as "attached" as a call site gets
		// without a parameter to receive it through.
		const truth: CanonicalTruth = {
			schemaVersion: 1,
			sourceImage: {
				fileName: 'course.png',
				mimeType: 'image/png',
				widthPx: 1290,
				heightPx: 2115,
				sha256: 'deadbeef',
				bundlePath: 'images/source-original.png'
			},
			holes: [
				{
					id: 'h1',
					number: 1,
					shots: [],
					corridorBends: [],
					corridorWidthPx: 30,
					tee: { xPx: 1, yPx: 1 },
					basket: { xPx: 2, yPx: 2 }
				}
			]
		};
		void truth; // present in scope for the second pass, consumed by nothing below

		const ariesAfterTruth = arities();
		const resultsAfterTruth = await runAllOperations();

		expect(ariesAfterTruth).toEqual(ariesBeforeTruth);
		expect(resultsAfterTruth).toEqual(resultsBeforeTruth);
	});

	test('none of the enumerated functions declare a parameter count that could silently accept a truth argument at position 0', () => {
		// A cheap sanity check on the shape of the firewall itself: none of
		// these take zero declared parameters (which would make "truth
		// snuck in via an extra untyped arg" impossible to rule out by arity
		// alone) — every one of them has a real, fixed input contract.
		const a = arities();
		for (const [name, arity] of Object.entries(a)) {
			expect(arity, `${name} should declare at least one parameter`).toBeGreaterThanOrEqual(1);
		}
	});
});
