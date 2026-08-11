// Validates the badge-ray invariant (see docs/tee-overfit-harness.md) against
// a labeled truth set, using computer-fitted pad axes (RANSAC dominant rim
// line via fitPadAt) rather than truth-derived axes.
//
// Usage: npm run validate:badge-invariant [-- <input-bundle>] [--baskets <bundle>] [--ui-scale <n>]
//   Defaults: input resources/GoldenTeeSet.chainspot.zip, baskets resources/GoldenBasketSet.chainspot.zip, ui-scale 1.77

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { loadInput } from './detect-tees';
import { loadCv } from '../src/lib/stitch/cvMatch';
import {
	badgeRayInvariantHolds,
	buildDashStructures,
	detectBadgeAnchors,
	fitPadAt,
	loadBasketTruth
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
			if (!value) throw new Error('--ui-scale requires a value.');
			const parsed = Number(value);
			if (!Number.isFinite(parsed)) throw new Error('--ui-scale must be a finite number.');
			uiScalePx = parsed;
			index += 1;
		}
	}
	return { inputPath, basketsPath, uiScalePx };
}

function segmentPointDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
	const vx = bx - ax;
	const vy = by - ay;
	const lengthSquared = vx * vx + vy * vy;
	const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / lengthSquared));
	return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const fitHalf = 10 * args.uiScalePx;
	const input = loadInput(args.inputPath);
	const truth = input.truth ?? [];
	const cv = (await loadCv()) as unknown as TeePadCv;
	const raster: TeePadRaster = { rgba: input.rgba, widthPx: input.widthPx, heightPx: input.heightPx, sourceScale: 1 };
	const baskets = loadBasketTruth(args.basketsPath);
	const structures = buildDashStructures(raster, baskets, truth);
	const badges = detectBadgeAnchors(cv, input, 'static/resources/chainspot_cv_templates');

	let ownPass = 0;
	let fitFailures = 0;
	const crossPasses: number[] = [];
	console.log('tee | fitted axis | badge bearing | delta | along | across | own badge | other badges passing | basket in corridor (min dist)');
	for (const hole of truth) {
		const pad = fitPadAt(raster, hole.xPx, hole.yPx, fitHalf, structures);
		const badge = badges.find((entry) => entry.number === hole.number);
		if (!badge) continue;
		if (!pad) {
			fitFailures += 1;
			console.log(`tee ${hole.number}: RIM FIT FAILED (too few clean rim pixels)`);
			continue;
		}
		const axisDeg = (Math.atan2(pad.uy, pad.ux) * 180) / Math.PI;
		const toX = badge.xPx - pad.xPx;
		const toY = badge.yPx - pad.yPx;
		const bearingDeg = (Math.atan2(toY, toX) * 180) / Math.PI;
		let delta = Math.abs(((axisDeg - bearingDeg) % 180) + 180) % 180;
		if (delta > 90) delta = 180 - delta;
		const sign = toX * pad.ux + toY * pad.uy < 0 ? -1 : 1;
		const along = (toX * pad.ux + toY * pad.uy) * sign;
		const across = Math.abs(-toX * pad.uy + toY * pad.ux);
		const own = badgeRayInvariantHolds(pad, badge);
		if (own) ownPass += 1;
		const others = badges.filter((entry) => entry.number !== hole.number && badgeRayInvariantHolds(pad, entry));
		crossPasses.push(others.length);
		// Basket interference: nearest basket (point and glyph capsule top) to
		// the center-ray segment from the pad front edge to the badge.
		const frontX = pad.xPx + pad.ux * sign * pad.halfMajorPx;
		const frontY = pad.yPx + pad.uy * sign * pad.halfMajorPx;
		let minBasket = Number.POSITIVE_INFINITY;
		for (const basket of baskets) {
			for (const dy of [0, -25, -50]) {
				minBasket = Math.min(
					minBasket,
					segmentPointDistance(basket.xPx, basket.yPx + dy, frontX, frontY, badge.xPx, badge.yPx)
				);
			}
		}
		console.log(
			`tee ${hole.number}: axis ${axisDeg.toFixed(1)} | bearing ${bearingDeg.toFixed(1)} | delta ${delta.toFixed(1)} | along ${along.toFixed(1)} | across ${across.toFixed(1)} | ${own ? 'PASS' : 'FAIL'} | ${others.map((entry) => entry.number).join(',') || 'none'} | ${minBasket.toFixed(0)}px`
		);
	}
	console.log(
		`\nsummary: own-badge pass ${ownPass}/${truth.length - fitFailures} fitted (${fitFailures} fit failures); cross-badge passes per pad: mean ${(crossPasses.reduce((a, b) => a + b, 0) / Math.max(1, crossPasses.length)).toFixed(2)}, max ${Math.max(...crossPasses, 0)}`
	);
}

const scriptPath = fileURLToPath(import.meta.url);
if (resolve(process.argv[1] ?? '') === resolve(scriptPath)) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
