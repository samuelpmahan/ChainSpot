import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import jpeg from 'jpeg-js';
import { strFromU8, unzipSync } from 'fflate';
import { PNG } from 'pngjs';
import { loadCv } from '../../src/lib/stitch/cvMatch';
import { detectDashedPathChains } from '../../src/lib/autoAnnotation/teePadDetection';
import type { TeePadCv, TeePadRaster } from '../../src/lib/autoAnnotation/teePadDetection';
import { asUiScalePx } from '../../src/lib/autoAnnotation/cvCalibration';

/**
 * THROWAWAY investigation probe -- not wired into any test suite or CLI.
 * Checks the "Goal 2" hypothesis from docs/deferred-detection-experiments.md's
 * "Dashed walking/cart-path detector" entry: does a detected path chain's
 * terminus sit near an unresolved hole's true tee, in a way that would help
 * locate/orient it? Prints raw numbers for both ground-truth fixtures.
 */

interface DecodedRaster {
	rgba: Uint8Array;
	widthPx: number;
	heightPx: number;
}

interface TruthHole {
	number: number;
	tee?: { xPx: number; yPx: number };
	basket?: { xPx: number; yPx: number };
}

function decodeRaster(bytes: Uint8Array, fileName: string): DecodedRaster {
	const extension = extname(fileName).toLowerCase();
	if (extension === '.png') {
		const decoded = PNG.sync.read(Buffer.from(bytes));
		return { rgba: new Uint8Array(decoded.data), widthPx: decoded.width, heightPx: decoded.height };
	}
	if (extension === '.jpg' || extension === '.jpeg') {
		const decoded = jpeg.decode(Buffer.from(bytes), { useTArray: true });
		return { rgba: new Uint8Array(decoded.data), widthPx: decoded.width, heightPx: decoded.height };
	}
	throw new Error(`Unsupported image format '${extension}'`);
}

function loadBundle(inputPath: string): { raster: DecodedRaster; truth: TruthHole[] } {
	const bytes = new Uint8Array(readFileSync(inputPath));
	const entries = unzipSync(bytes);
	const jsonBytes = entries['project.json'];
	if (!jsonBytes) throw new Error('missing project.json');
	const document = JSON.parse(strFromU8(jsonBytes)) as {
		images?: { role?: unknown; fileName?: unknown; bundlePath?: unknown }[];
		holes?: { number?: unknown; tee?: { xPx?: unknown; yPx?: unknown }; basket?: { xPx?: unknown; yPx?: unknown } }[];
	};
	const sourceManifest = (document.images ?? []).find((image) => image.role === 'source-overview');
	const sourceEntry = sourceManifest?.bundlePath as string;
	const sourceBytes = entries[sourceEntry];
	const raster = decodeRaster(sourceBytes, (sourceManifest?.fileName as string) ?? sourceEntry);
	const truth: TruthHole[] = (document.holes ?? [])
		.map((hole) => ({
			number: typeof hole.number === 'number' ? hole.number : NaN,
			tee: typeof hole.tee?.xPx === 'number' && typeof hole.tee?.yPx === 'number' ? { xPx: hole.tee.xPx, yPx: hole.tee.yPx } : undefined,
			basket: typeof hole.basket?.xPx === 'number' && typeof hole.basket?.yPx === 'number' ? { xPx: hole.basket.xPx, yPx: hole.basket.yPx } : undefined
		}))
		.filter((hole) => Number.isInteger(hole.number))
		.sort((a, b) => a.number - b.number);
	return { raster, truth };
}

async function main(): Promise<void> {
	const [inputPath, uiScaleArg, mapTopArg, mapBottomArg] = process.argv.slice(2);
	const uiScalePx = asUiScalePx(Number(uiScaleArg));
	const mapBoundsPx = mapTopArg !== undefined && mapBottomArg !== undefined ? { topPx: Number(mapTopArg), bottomPx: Number(mapBottomArg) } : undefined;

	const { raster, truth } = loadBundle(inputPath);
	const cv = (await loadCv()) as unknown as TeePadCv;
	const teePadRaster: TeePadRaster = { rgba: raster.rgba, widthPx: raster.widthPx, heightPx: raster.heightPx, sourceScale: 1 };
	const chains = detectDashedPathChains(cv, teePadRaster, { uiScalePx, mapBoundsPx });

	console.log(`\n=== ${inputPath} ===`);
	console.log(`chains found: ${chains.length} (median length ${[...chains].map((c) => c.dashes.length).sort((a, b) => a - b)[Math.floor(chains.length / 2)] ?? 0} dashes)`);

	interface Terminus {
		chainIndex: number;
		xPx: number;
		yPx: number;
		/** Direction pointing outward past the terminus, away from the rest of the chain. */
		outwardDeg: number;
	}
	const termini: Terminus[] = [];
	chains.forEach((chain, chainIndex) => {
		if (chain.dashes.length < 2) return;
		const radians = (chain.orientationDeg * Math.PI) / 180;
		const ux = Math.cos(radians);
		const uy = Math.sin(radians);
		const sorted = [...chain.dashes].sort((a, b) => a.xPx * ux + a.yPx * uy - (b.xPx * ux + b.yPx * uy));
		const first = sorted[0];
		const second = sorted[1];
		const last = sorted[sorted.length - 1];
		const secondLast = sorted[sorted.length - 2];
		const outwardStartDeg = (Math.atan2(first.yPx - second.yPx, first.xPx - second.xPx) * 180) / Math.PI;
		const outwardEndDeg = (Math.atan2(last.yPx - secondLast.yPx, last.xPx - secondLast.xPx) * 180) / Math.PI;
		termini.push({ chainIndex, xPx: first.xPx, yPx: first.yPx, outwardDeg: outwardStartDeg });
		termini.push({ chainIndex, xPx: last.xPx, yPx: last.yPx, outwardDeg: outwardEndDeg });
	});
	console.log(`termini: ${termini.length}`);

	function nearestTerminusDistance(xPx: number, yPx: number): { terminus: Terminus; distancePx: number } | undefined {
		let best: { terminus: Terminus; distancePx: number } | undefined;
		for (const terminus of termini) {
			const distancePx = Math.hypot(terminus.xPx - xPx, terminus.yPx - yPx);
			if (!best || distancePx < best.distancePx) best = { terminus, distancePx };
		}
		return best;
	}

	console.log(`\nhole | truth tee | nearest terminus | dist(px) | angleDelta(deg, outward-vs-toward-tee)`);
	const teeDistances: number[] = [];
	for (const hole of truth) {
		if (!hole.tee) continue;
		const best = nearestTerminusDistance(hole.tee.xPx, hole.tee.yPx);
		if (!best) {
			console.log(`  hole ${hole.number}: no termini at all`);
			continue;
		}
		teeDistances.push(best.distancePx);
		const bearingToTeeDeg = (Math.atan2(hole.tee.yPx - best.terminus.yPx, hole.tee.xPx - best.terminus.xPx) * 180) / Math.PI;
		let angleDelta = Math.abs(bearingToTeeDeg - best.terminus.outwardDeg) % 360;
		if (angleDelta > 180) angleDelta = 360 - angleDelta;
		console.log(
			`  hole ${hole.number}: tee=(${hole.tee.xPx.toFixed(0)},${hole.tee.yPx.toFixed(0)}) ` +
				`nearestTerminus=(${best.terminus.xPx.toFixed(0)},${best.terminus.yPx.toFixed(0)}) ` +
				`dist=${best.distancePx.toFixed(1)}px angleDelta=${angleDelta.toFixed(1)}deg`
		);
	}

	// Control: is "some terminus is nearby" actually informative, or does the
	// sheer volume of detected chains mean almost ANY point in the map area
	// has a terminus within similar distance purely by chance? Sample random
	// points across the map bounds and compare the same nearest-terminus
	// distance distribution.
	const bounds = mapBoundsPx ?? { topPx: 0, bottomPx: raster.heightPx };
	const controlCount = 200;
	const controlDistances: number[] = [];
	let seed = 42;
	function rand(): number {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		return seed / 0x7fffffff;
	}
	for (let i = 0; i < controlCount; i += 1) {
		const x = rand() * raster.widthPx;
		const y = bounds.topPx + rand() * (bounds.bottomPx - bounds.topPx);
		const best = nearestTerminusDistance(x, y);
		if (best) controlDistances.push(best.distancePx);
	}
	function stats(values: number[]): string {
		const sorted = [...values].sort((a, b) => a - b);
		const mean = values.reduce((s, v) => s + v, 0) / values.length;
		const median = sorted[Math.floor(sorted.length / 2)];
		return `n=${values.length} mean=${mean.toFixed(1)}px median=${median.toFixed(1)}px min=${sorted[0]?.toFixed(1)} max=${sorted[sorted.length - 1]?.toFixed(1)}`;
	}
	console.log(`\ntruth-tee nearest-terminus distances: ${stats(teeDistances)}`);
	console.log(`random-control-point nearest-terminus distances: ${stats(controlDistances)}`);

	// The SPECIFIC routing hypothesis: a single chain's two termini should
	// land near hole N's basket at one end and hole (N+1)'s tee at the other
	// -- not just "some terminus is near this tee" (which the control above
	// shows is weak/noisy on its own), but a chain that actually connects the
	// two consecutive-hole truth points.
	const byNumber = new Map(truth.map((hole) => [hole.number, hole] as const));
	for (const NEAR_RADIUS_PX of [25, 40, 60, 80]) {
		let routingHits = 0;
		let routingChecked = 0;
		const details: string[] = [];
		for (const hole of truth) {
			const next = byNumber.get(hole.number + 1);
			if (!hole.basket || !next?.tee) continue;
			routingChecked += 1;
			let bestMatch: { chain: (typeof chains)[number]; basketDist: number; teeDist: number } | undefined;
			for (const chain of chains) {
				if (chain.dashes.length < 2) continue;
				let basketDist = Infinity;
				let teeDist = Infinity;
				for (const dash of chain.dashes) {
					basketDist = Math.min(basketDist, Math.hypot(dash.xPx - hole.basket!.xPx, dash.yPx - hole.basket!.yPx));
					teeDist = Math.min(teeDist, Math.hypot(dash.xPx - next.tee!.xPx, dash.yPx - next.tee!.yPx));
				}
				if (basketDist <= NEAR_RADIUS_PX && teeDist <= NEAR_RADIUS_PX) {
					if (!bestMatch || basketDist + teeDist < bestMatch.basketDist + bestMatch.teeDist) bestMatch = { chain, basketDist, teeDist };
				}
			}
			if (bestMatch) {
				routingHits += 1;
				details.push(`hole ${hole.number}->${next.number}: MATCHED (${bestMatch.chain.dashes.length} dashes, basketDist=${bestMatch.basketDist.toFixed(1)}px teeDist=${bestMatch.teeDist.toFixed(1)}px)`);
			}
		}
		console.log(`\nrouting hit rate @ ${NEAR_RADIUS_PX}px: ${routingHits}/${routingChecked}`);
		details.forEach((line) => console.log(`  ${line}`));
	}

	// Control for the routing check: is "basket_i and tee_j both near some
	// chain" specific to consecutive holes (i, i+1), or does it happen just
	// as often for unrelated (basket_i, tee_j) pairs, given how many chains
	// this detector fires? Test every non-consecutive ordered pair.
	function chainConnects(aX: number, aY: number, bX: number, bY: number, radiusPx: number): boolean {
		for (const chain of chains) {
			if (chain.dashes.length < 2) continue;
			let aDist = Infinity;
			let bDist = Infinity;
			for (const dash of chain.dashes) {
				aDist = Math.min(aDist, Math.hypot(dash.xPx - aX, dash.yPx - aY));
				bDist = Math.min(bDist, Math.hypot(dash.xPx - bX, dash.yPx - bY));
			}
			if (aDist <= radiusPx && bDist <= radiusPx) return true;
		}
		return false;
	}
	for (const radiusPx of [25, 40, 60, 80]) {
		let unrelatedChecked = 0;
		let unrelatedHits = 0;
		for (const a of truth) {
			if (!a.basket) continue;
			for (const b of truth) {
				if (!b.tee || b.number === a.number + 1) continue;
				unrelatedChecked += 1;
				if (chainConnects(a.basket.xPx, a.basket.yPx, b.tee.xPx, b.tee.yPx, radiusPx)) unrelatedHits += 1;
			}
		}
		console.log(`\nunrelated (non-consecutive) basket->tee pair hit rate @ ${radiusPx}px: ${unrelatedHits}/${unrelatedChecked} (${((100 * unrelatedHits) / unrelatedChecked).toFixed(2)}%)`);
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
