// Validates the badge-ray invariant (see docs/tee-overfit-harness.md) against
// a labeled truth set. Pad orientation is measured independently with a
// rotation-swept synthetic-pad NCC, not inferred from tee/badge truth.
//
// Usage: npm run validate:badge-invariant [-- <input-bundle>] [--baskets <bundle>] [--ui-scale <n>]
//   Defaults: input resources/GoldenTeeSet.chainspot.zip, baskets resources/GoldenBasketSet.chainspot.zip, ui-scale 1.77

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { loadInput } from './detect-tees';
import { loadCv } from '../src/lib/stitch/cvMatch';
import {
	badgeRayInvariantHolds,
	detectBadgeAnchors,
	loadBasketTruth,
	sweepPadOrientation
} from './overfit-tees';
import type { TeePadCv, TeePadRaster } from '../src/lib/autoAnnotation/teePadDetection';

const DEFAULT_INPUT = 'resources/GoldenTeeSet.chainspot.zip';
const DEFAULT_BASKETS = 'resources/GoldenBasketSet.chainspot.zip';
const DEFAULT_UI = 1.77;
const UNMEASURABLE_SCORE = 0.3;

interface CliArgs {
	readonly inputPath: string;
	readonly basketsPath: string;
	readonly uiScalePx: number;
}

function parseArgs(argv: readonly string[]): CliArgs {
	let inputPath = DEFAULT_INPUT;
	let basketsPath = DEFAULT_BASKETS;
	let uiScalePx = DEFAULT_UI;
	const positional = argv.find((value) => !value.startsWith('--'));
	if (positional) inputPath = positional;
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === '--baskets') {
			const value = argv[index + 1];
			if (!value) throw new Error('--baskets requires a value.');
			basketsPath = value;
			index += 1;
		} else if (argument === '--ui-scale') {
			const value = argv[index + 1];
			if (!value) throw new Error('--ui-scale requires a value.');
			const parsed = Number(value);
			if (!Number.isFinite(parsed)) throw new Error('--ui-scale must be a finite number.');
			uiScalePx = parsed;
			index += 1;
		}
	}
	return { inputPath, basketsPath, uiScalePx };
}

function axisDeltaDeg(axisDeg: number, bearingDeg: number): number {
	let delta = Math.abs(((axisDeg - bearingDeg) % 180) + 180) % 180;
	if (delta > 90) delta = 180 - delta;
	return delta;
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const input = loadInput(args.inputPath);
	const truth = input.truth ?? [];
	const cv = (await loadCv()) as unknown as TeePadCv;
	const raster: TeePadRaster = { rgba: input.rgba, widthPx: input.widthPx, heightPx: input.heightPx, sourceScale: 1 };
	const baskets = loadBasketTruth(args.basketsPath);
	const badges = detectBadgeAnchors(cv, input, 'static/resources/chainspot_cv_templates');

	let pass = 0;
	let fail = 0;
	let unmeasurable = 0;
	console.log('tee | sweep axis | score | badge bearing | delta | across | result | basket bearing | basket delta');
	for (const hole of truth) {
		const badge = badges.find((entry) => entry.number === hole.number);
		if (!badge) {
			fail += 1;
			console.log(`tee ${hole.number}: badge missing | FAIL`);
			continue;
		}
		const sweep = sweepPadOrientation(raster, hole.xPx, hole.yPx, args.uiScalePx);
		if (!sweep || sweep.score < UNMEASURABLE_SCORE) {
			unmeasurable += 1;
			console.log(`tee ${hole.number}: ${sweep ? `axis ${sweep.axisDeg.toFixed(1)} | score ${sweep.score.toFixed(3)}` : 'no sweep result'} | UNMEASURABLE`);
			continue;
		}
		const radians = (sweep.axisDeg * Math.PI) / 180;
		const pad = {
			xPx: sweep.xPx,
			yPx: sweep.yPx,
			ux: Math.cos(radians),
			uy: Math.sin(radians),
			halfMajorPx: 6.5 * args.uiScalePx,
			halfMinorPx: 4 * args.uiScalePx,
			evidenceCount: 0,
			orientationScore: sweep.score
		};
		const toBadgeX = badge.xPx - pad.xPx;
		const toBadgeY = badge.yPx - pad.yPx;
		const badgeBearingDeg = (Math.atan2(toBadgeY, toBadgeX) * 180) / Math.PI;
		const delta = axisDeltaDeg(sweep.axisDeg, badgeBearingDeg);
		const across = Math.abs(-toBadgeX * pad.uy + toBadgeY * pad.ux);
		const own = badgeRayInvariantHolds(pad, badge);
		if (own) pass += 1;
		else fail += 1;

		const basket = baskets.find((entry) => entry.number === hole.number);
		const basketBearingDeg = basket ? (Math.atan2(basket.yPx - pad.yPx, basket.xPx - pad.xPx) * 180) / Math.PI : Number.NaN;
		const basketDelta = basket ? axisDeltaDeg(sweep.axisDeg, basketBearingDeg) : Number.NaN;
		console.log(
			`tee ${hole.number}: axis ${sweep.axisDeg.toFixed(1)} | score ${sweep.score.toFixed(3)} | bearing ${badgeBearingDeg.toFixed(1)} | delta ${delta.toFixed(1)} | across ${across.toFixed(1)} | ${own ? 'PASS' : 'FAIL'} | basket ${Number.isFinite(basketBearingDeg) ? basketBearingDeg.toFixed(1) : 'n/a'} | basketDelta ${Number.isFinite(basketDelta) ? basketDelta.toFixed(1) : 'n/a'}`
		);
	}
	console.log(`\nsummary: PASS ${pass}/${truth.length}; FAIL ${fail}; UNMEASURABLE ${unmeasurable}; measurable ${pass + fail}/${truth.length}`);
}

const scriptPath = fileURLToPath(import.meta.url);
if (resolve(process.argv[1] ?? '') === resolve(scriptPath)) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
