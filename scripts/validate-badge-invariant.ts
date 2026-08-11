// Validates the badge-ray invariant (see docs/tee-overfit-harness.md) against
// a labeled truth set, using computer-fitted pad axes (rotation-swept
// template NCC via sweepPadOrientation) rather than truth-derived axes.
//
// Usage: npm run validate:badge-invariant [-- <input-bundle>] [--baskets <bundle>] [--ui-scale <n>]
//   Defaults: input resources/GoldenTeeSet.chainspot.zip, baskets resources/GoldenBasketSet.chainspot.zip, ui-scale 1.77

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { loadInput } from './detect-tees';
import { loadCv } from '../src/lib/stitch/cvMatch';
import {
	SWEEP_UNMEASURABLE_SCORE,
	badgeRayInvariantHolds,
	detectBadgeAnchors,
	fittedPadFromSweep,
	sweepPadOrientation
} from './overfit-tees';
import type { TeePadCv, TeePadRaster } from '../src/lib/autoAnnotation/teePadDetection';

const DEFAULT_INPUT = 'resources/GoldenTeeSet.chainspot.zip';
const DEFAULT_BASKETS = 'resources/GoldenBasketSet.chainspot.zip';
const DEFAULT_UI = 1.77;

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
			if (!value) throw new Error('--ui-scale must be a finite number.');
			const parsed = Number(value);
			if (!Number.isFinite(parsed)) throw new Error('--ui-scale must be a finite number.');
			uiScalePx = parsed;
			index += 1;
		}
	}
	return { inputPath, basketsPath, uiScalePx };
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const input = loadInput(args.inputPath);
	const truth = input.truth ?? [];
	const cv = (await loadCv()) as unknown as TeePadCv;
	const raster: TeePadRaster = { rgba: input.rgba, widthPx: input.widthPx, heightPx: input.heightPx, sourceScale: 1 };
	const badges = detectBadgeAnchors(cv, input, 'static/resources/chainspot_cv_templates');

	let passCount = 0;
	let failCount = 0;
	let unmeasurableCount = 0;
	console.log('tee | sweep axis | score | badge bearing | delta | along | across | result');
	for (const hole of truth) {
		const badge = badges.find((entry) => entry.number === hole.number);
		if (!badge) continue;
		const sweep = sweepPadOrientation(raster, hole.xPx, hole.yPx, args.uiScalePx);
		if (!sweep) {
			unmeasurableCount += 1;
			console.log(`tee ${hole.number}: SWEEP FAILED (no valid window)`);
			continue;
		}
		if (sweep.score < SWEEP_UNMEASURABLE_SCORE) {
			unmeasurableCount += 1;
			console.log(`tee ${hole.number}: axis ${sweep.axisDeg.toFixed(1)} | score ${sweep.score.toFixed(3)} | UNMEASURABLE (score below ${SWEEP_UNMEASURABLE_SCORE})`);
			continue;
		}
		const pad = fittedPadFromSweep(sweep, args.uiScalePx);
		const toX = badge.xPx - pad.xPx;
		const toY = badge.yPx - pad.yPx;
		const bearingDeg = (Math.atan2(toY, toX) * 180) / Math.PI;
		let delta = Math.abs(((sweep.axisDeg - bearingDeg) % 180) + 180) % 180;
		if (delta > 90) delta = 180 - delta;
		const sign = toX * pad.ux + toY * pad.uy < 0 ? -1 : 1;
		const along = (toX * pad.ux + toY * pad.uy) * sign;
		const across = Math.abs(-toX * pad.uy + toY * pad.ux);
		const passes = badgeRayInvariantHolds(pad, badge);
		if (passes) passCount += 1;
		else failCount += 1;
		console.log(
			`tee ${hole.number}: axis ${sweep.axisDeg.toFixed(1)} | score ${sweep.score.toFixed(3)} | bearing ${bearingDeg.toFixed(1)} | delta ${delta.toFixed(1)} | along ${along.toFixed(1)} | across ${across.toFixed(1)} | ${passes ? 'PASS' : 'FAIL'}`
		);
	}
	console.log(
		`\nsummary: PASS ${passCount}, FAIL ${failCount}, UNMEASURABLE ${unmeasurableCount} (of ${truth.length} truth tees)`
	);
}

const scriptPath = fileURLToPath(import.meta.url);
if (resolve(process.argv[1] ?? '') === resolve(scriptPath)) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
