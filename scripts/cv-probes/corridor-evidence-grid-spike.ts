/**
 * Visual validation for `buildModernCorridorEvidence`
 * (`src/lib/autoAnnotation/corridorEvidenceGridRibbonMass.ts`) — renders the
 * per-hole `CorridorEvidenceGrid` as a heatmap over the real source crop for
 * a handful of Dash's Track holes (`GoldenTeeSet.chainspot.zip`, the same
 * fixture as `IMG_5641_GROUND_TRUTH`), so the evidence signal can be
 * confirmed by eye instead of trusted from numbers alone:
 *
 * - hole 13 (`straight`, per `corridorBendGroundTruth.ts`'s category map) —
 *   does a clean corridor read as high, unbroken evidence?
 * - hole 14 (`dogleg`) — does the evidence trace the actual bend, not just
 *   the straight tee-basket chord?
 * - hole 11 (`straight`, but its basket sits only ~47px from hole 12's tee —
 *   the closest tee/badge proximity of any hole on this course, and close
 *   to this course's own discovered ring radii) — does hole 12's geometry
 *   leak into hole 11's isolated evidence, and does hole 11's own C1/C2 ring
 *   get handled sensibly rather than swallowing the isolated region?
 *
 * This is a measurement/visualization probe only — no production code
 * imports it, and it introduces no new detection behavior; it exercises the
 * real, already-written evidence builder against real course imagery.
 *
 * Usage:
 *   npx tsx scripts/cv-probes/corridor-evidence-grid-spike.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import {
	buildModernCorridorEvidence,
	discoverBasketRingRadiiPx
} from '../../src/lib/autoAnnotation/corridorEvidenceGridRibbonMass';
import { DEFAULT_RIBBON_MASS_PARAMS, segmentRibbonMass } from '../../src/lib/autoAnnotation/ribbonMass';
import { FIXTURE_COURSES, loadFixtureRaster } from './ribbonMassFixtures';

interface TargetHole {
	readonly holeNumber: number;
	readonly label: string;
	/** Other hole numbers whose tee/badge/basket to draw for a leakage sanity check. */
	readonly watchNeighbors: readonly number[];
}

const TARGET_HOLES: readonly TargetHole[] = [
	{ holeNumber: 13, label: 'straight', watchNeighbors: [12, 14] },
	{ holeNumber: 14, label: 'dogleg', watchNeighbors: [13, 15] },
	{ holeNumber: 11, label: 'basket-near-neighbor-tee (leakage risk)', watchNeighbors: [10, 12] }
];

const outDir = join(process.cwd(), 'scripts/cv-probes/corridor-evidence-grid-results-ts');
mkdirSync(outDir, { recursive: true });

function blend(png: PNG, x: number, y: number, r: number, g: number, b: number, alpha: number): void {
	const xi = Math.round(x);
	const yi = Math.round(y);
	if (xi < 0 || xi >= png.width || yi < 0 || yi >= png.height) return;
	const p = (yi * png.width + xi) * 4;
	png.data[p] = Math.round(png.data[p] * (1 - alpha) + r * alpha);
	png.data[p + 1] = Math.round(png.data[p + 1] * (1 - alpha) + g * alpha);
	png.data[p + 2] = Math.round(png.data[p + 2] * (1 - alpha) + b * alpha);
}

function drawRing(png: PNG, cx: number, cy: number, radiusPx: number, r: number, g: number, b: number): void {
	const steps = Math.max(60, Math.round(radiusPx * 2));
	for (let i = 0; i < steps; i += 1) {
		const angle = (2 * Math.PI * i) / steps;
		blend(png, cx + radiusPx * Math.cos(angle), cy + radiusPx * Math.sin(angle), r, g, b, 0.9);
	}
}

for (const course of FIXTURE_COURSES) {
	if (course.name !== 'GoldenTeeSet') continue; // Dash's Track — the course IMG_5641_GROUND_TRUTH describes.

	const raster = loadFixtureRaster(join(process.cwd(), course.zip));
	const segmentation = segmentRibbonMass(
		raster,
		course.badges.map(([, xPx, yPx]) => ({ xPx, yPx })),
		DEFAULT_RIBBON_MASS_PARAMS
	);
	if (!segmentation.evidence) throw new Error('segmentRibbonMass did not populate evidence');
	const withEvidence = { ...segmentation, evidence: segmentation.evidence };

	const baskets = course.truth.map(([, , , bx, by]) => ({ xPx: bx, yPx: by }));
	const ringRadiiPx = discoverBasketRingRadiiPx(raster, baskets);
	console.log(`\n================ ${course.name}: discovered ring radii = [${ringRadiiPx.join(', ')}]px ================`);

	for (const target of TARGET_HOLES) {
		const truthRow = course.truth.find(([n]) => n === target.holeNumber);
		if (!truthRow) continue;
		const [, teeX, teeY, basketX, basketY] = truthRow;
		const badgeRow = course.badges.find(([n]) => n === target.holeNumber);
		const tee = { xPx: teeX, yPx: teeY };
		const basket = { xPx: basketX, yPx: basketY };
		const badge = badgeRow ? { xPx: badgeRow[1], yPx: badgeRow[2] } : undefined;

		const grid = buildModernCorridorEvidence(withEvidence, tee, basket, badge, ringRadiiPx);
		if (!grid) {
			console.log(`hole ${target.holeNumber} [${target.label}]: buildModernCorridorEvidence returned null`);
			continue;
		}

		let sum = 0;
		let max = 0;
		let above05 = 0;
		for (const v of grid.evidence) {
			sum += v;
			if (v > max) max = v;
			if (v >= 0.5) above05 += 1;
		}
		const mean = sum / grid.evidence.length;
		console.log(
			`hole ${String(target.holeNumber).padStart(2)} [${target.label}]: grid ${grid.widthPx}x${grid.heightPx}` +
				` mean=${mean.toFixed(3)} max=${max.toFixed(3)} cells>=0.5: ${above05}/${grid.evidence.length}` +
				` (${((100 * above05) / grid.evidence.length).toFixed(1)}%)`
		);

		// Render: source crop as background, evidence as a red-hot heatmap overlay.
		const png = new PNG({ width: grid.widthPx * grid.scale, height: grid.heightPx * grid.scale });
		for (let y = 0; y < png.height; y += 1) {
			const srcY = Math.min(raster.heightPx - 1, grid.originYPx + y);
			for (let x = 0; x < png.width; x += 1) {
				const srcX = Math.min(raster.widthPx - 1, grid.originXPx + x);
				const sp = (srcY * raster.widthPx + srcX) * 4;
				const dp = (y * png.width + x) * 4;
				png.data[dp] = raster.data[sp];
				png.data[dp + 1] = raster.data[sp + 1];
				png.data[dp + 2] = raster.data[sp + 2];
				png.data[dp + 3] = 255;
			}
		}
		for (let gy = 0; gy < grid.heightPx; gy += 1) {
			for (let gx = 0; gx < grid.widthPx; gx += 1) {
				const v = grid.evidence[gy * grid.widthPx + gx];
				if (v <= 0.02) continue;
				for (let sy = 0; sy < grid.scale; sy += 1) {
					for (let sx = 0; sx < grid.scale; sx += 1) {
						blend(png, gx * grid.scale + sx, gy * grid.scale + sy, 255, 40, 40, Math.min(0.85, v));
					}
				}
			}
		}

		const toLocal = (p: { xPx: number; yPx: number }) => ({
			x: p.xPx - grid.originXPx,
			y: p.yPx - grid.originYPx
		});
		const teeLocal = toLocal(tee);
		const basketLocal = toLocal(basket);
		drawRing(png, teeLocal.x, teeLocal.y, 9, 40, 140, 255); // this hole's tee: blue
		drawRing(png, basketLocal.x, basketLocal.y, 9, 40, 255, 120); // this hole's basket: green
		if (badge) {
			const badgeLocal = toLocal(badge);
			drawRing(png, badgeLocal.x, badgeLocal.y, 6, 255, 220, 40); // this hole's badge: yellow
		}
		for (const r of ringRadiiPx) drawRing(png, basketLocal.x, basketLocal.y, r, 255, 255, 255); // discovered ring radii: white

		for (const neighborNumber of target.watchNeighbors) {
			const neighborTruth = course.truth.find(([n]) => n === neighborNumber);
			const neighborBadge = course.badges.find(([n]) => n === neighborNumber);
			if (neighborTruth) {
				const [, ntx, nty, nbx, nby] = neighborTruth;
				const neighborTeeLocal = toLocal({ xPx: ntx, yPx: nty });
				const neighborBasketLocal = toLocal({ xPx: nbx, yPx: nby });
				drawRing(png, neighborTeeLocal.x, neighborTeeLocal.y, 7, 255, 120, 255); // neighbor tee: magenta
				drawRing(png, neighborBasketLocal.x, neighborBasketLocal.y, 7, 255, 120, 255); // neighbor basket: magenta
			}
			if (neighborBadge) {
				const neighborBadgeLocal = toLocal({ xPx: neighborBadge[1], yPx: neighborBadge[2] });
				drawRing(png, neighborBadgeLocal.x, neighborBadgeLocal.y, 5, 255, 120, 255); // neighbor badge: magenta
			}
		}

		const outPath = join(outDir, `hole-${String(target.holeNumber).padStart(2, '0')}-${target.label.replace(/[^a-z0-9]+/gi, '-')}.png`);
		writeFileSync(outPath, PNG.sync.write(png));
		console.log(`  wrote ${outPath}`);
	}
}
