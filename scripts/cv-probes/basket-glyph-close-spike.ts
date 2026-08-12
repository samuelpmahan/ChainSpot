/**
 * Dash-only basket-glyph occluder spike.
 *
 * Goal: test the highest-priority failure class from ribbon-mass-handoff-2:
 * basket UI glyphs sever otherwise-continuous ribbon mass (B4/B7/B9/B11,
 * plus maybe B10). This intentionally isolates basket-glyph repair from
 * ring repair so a win cannot be credited to the already-known annulus path.
 *
 * Important constraints:
 * - Reuse the production basket-icon geometry in deriveBasketIconMasksPx.
 *   Do NOT use the older ~96px "marker radius" here; that describes the
 *   larger marker/ring footprint, not the basket icon core that actually
 *   occludes the ribbon.
 * - uiScalePx comes from the committed production detector cache for this
 *   exact fixture, not a hand-tuned number.
 * - Repair is the same local multi-source BFS idea as occluder-bridge-spike
 *   v2: growth only through non-evidence pixels inside the predicted glyph
 *   footprint, max 18 source px. No global union-find.
 * - Every accepted repair is rendered as a red dot. Render before trusting
 *   the metrics.
 *
 * Targeted Dash acceptance cases from ribbon-mass-handoff-2:
 *   H4  basket end broken by B4
 *   H6  tee side broken by B7
 *   H9  basket end broken by B9
 *   H10 likely same family as H9
 *   H12 foreign glyph B11 breaks the corridor
 *
 * Usage:
 *   npx tsx scripts/cv-probes/basket-glyph-close-spike.ts [--render]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import {
	DEFAULT_RIBBON_MASS_PARAMS,
	nearestKeptDistancePx,
	placeSeeds,
	segmentRibbonMass,
	topologyBuckets
} from '../../src/lib/autoAnnotation/ribbonMass';
import type { RibbonMassSeed, RibbonMassSegmentation } from '../../src/lib/autoAnnotation/ribbonMass';
import { deriveBasketIconMasksPx } from '../../src/lib/autoAnnotation/teePadDetection';
import { GOLDEN_BADGES, GOLDEN_TRUTH, loadFixtureRaster } from './ribbonMassFixtures';

const GOLDEN_ZIP = 'resources/GoldenTeeSet.chainspot.zip';
const GOLDEN_DETECTOR_CACHE =
	'scripts/cv-probes/hole-path-results/tuning/badge-cache/GoldenTeeSet-f7eb83c2ed515e94.json';
const MAX_CLOSE_PX = 18;
const GAP_THRESHOLDS_PX = [6, 9, 12, 15, 18] as const;
const TARGET_HOLES = new Set([4, 6, 9, 10, 12]);

interface GlyphBand {
	readonly holeNumber: number;
	readonly xPx: number;
	readonly yPx: number;
	readonly radiusPx: number;
}

interface LocalConnection {
	readonly a: number;
	readonly b: number;
	readonly gapPx: number;
	readonly xPx: number;
	readonly yPx: number;
	readonly glyphHoles: readonly number[];
}

function loadUiScalePx(): number {
	const parsed = JSON.parse(readFileSync(join(process.cwd(), GOLDEN_DETECTOR_CACHE), 'utf8')) as {
		uiScalePx?: unknown;
	};
	if (typeof parsed.uiScalePx !== 'number' || !Number.isFinite(parsed.uiScalePx) || parsed.uiScalePx <= 0) {
		throw new Error(`Detector cache ${GOLDEN_DETECTOR_CACHE} has no valid uiScalePx.`);
	}
	return parsed.uiScalePx;
}

function buildGlyphBands(
	baskets: readonly { holeNumber: number; xPx: number; yPx: number }[],
	uiScalePx: number
): GlyphBand[] {
	// Fixture truth supplies basket centers only. score=1 is deliberate: this
	// spike is testing occluder geometry, not basket-detection confidence.
	const masks = deriveBasketIconMasksPx(
		baskets.map((basket) => ({ xPx: basket.xPx, yPx: basket.yPx, score: 1 })),
		uiScalePx
	);
	if (masks.length !== baskets.length) {
		throw new Error(`Expected ${baskets.length} basket-icon masks, got ${masks.length}.`);
	}
	return masks.map((mask, index) => ({
		holeNumber: baskets[index].holeNumber,
		xPx: mask.xPx,
		yPx: mask.yPx,
		radiusPx: mask.radiusPx
	}));
}

function buildBandMask(segmentation: RibbonMassSegmentation, bands: readonly GlyphBand[]): Uint8Array {
	const { widthEv, heightEv, scale } = segmentation;
	const band = new Uint8Array(widthEv * heightEv);
	for (const glyph of bands) {
		const cx = glyph.xPx / scale;
		const cy = glyph.yPx / scale;
		const radius = glyph.radiusPx / scale;
		const x0 = Math.max(0, Math.floor(cx - radius));
		const x1 = Math.min(widthEv - 1, Math.ceil(cx + radius));
		const y0 = Math.max(0, Math.floor(cy - radius));
		const y1 = Math.min(heightEv - 1, Math.ceil(cy + radius));
		const r2 = radius * radius;
		for (let y = y0; y <= y1; y += 1) {
			for (let x = x0; x <= x1; x += 1) {
				const dx = x - cx;
				const dy = y - cy;
				if (dx * dx + dy * dy <= r2) band[y * widthEv + x] = 1;
			}
		}
	}
	return band;
}

function glyphsAt(xPx: number, yPx: number, bands: readonly GlyphBand[]): number[] {
	return bands
		.filter((band) => Math.hypot(xPx - band.xPx, yPx - band.yPx) <= band.radiusPx)
		.map((band) => band.holeNumber)
		.sort((a, b) => a - b);
}

/**
 * Local multi-source closing copied from the v2 annulus spike, but the only
 * traversable background is the production-derived basket-glyph footprint.
 */
function glyphClose(
	segmentation: RibbonMassSegmentation,
	band: Uint8Array,
	bands: readonly GlyphBand[]
): LocalConnection[] {
	const { labels, widthEv, heightEv, scale } = segmentation;
	const maxSteps = Math.ceil(MAX_CLOSE_PX / scale);
	const owner = new Int32Array(labels.length);
	const dist = new Int32Array(labels.length).fill(-1);
	let frontier: number[] = [];
	const best = new Map<string, LocalConnection>();

	const considerMeeting = (labelA: number, labelB: number, gapSteps: number, x: number, y: number) => {
		if (labelA === labelB) return;
		const gapPx = gapSteps * scale;
		if (gapPx > MAX_CLOSE_PX) return;
		const key = labelA < labelB ? `${labelA}:${labelB}` : `${labelB}:${labelA}`;
		const xPx = x * scale;
		const yPx = y * scale;
		const candidate: LocalConnection = {
			a: Math.min(labelA, labelB),
			b: Math.max(labelA, labelB),
			gapPx,
			xPx,
			yPx,
			glyphHoles: glyphsAt(xPx, yPx, bands)
		};
		const existing = best.get(key);
		if (!existing || candidate.gapPx < existing.gapPx) best.set(key, candidate);
	};

	// Seed every non-evidence glyph-band pixel adjacent to evidence.
	for (let y = 0; y < heightEv; y += 1) {
		for (let x = 0; x < widthEv; x += 1) {
			const i = y * widthEv + x;
			if (labels[i] !== 0 || band[i] === 0) continue;
			for (let dy = -1; dy <= 1; dy += 1) {
				for (let dx = -1; dx <= 1; dx += 1) {
					if (dx === 0 && dy === 0) continue;
					const nx = x + dx;
					const ny = y + dy;
					if (nx < 0 || nx >= widthEv || ny < 0 || ny >= heightEv) continue;
					const neighborLabel = labels[ny * widthEv + nx];
					if (neighborLabel === 0) continue;
					if (dist[i] === -1) {
						dist[i] = 1;
						owner[i] = neighborLabel;
						frontier.push(i);
					} else if (owner[i] !== neighborLabel) {
						considerMeeting(owner[i], neighborLabel, dist[i], x, y);
					}
				}
			}
		}
	}

	for (let step = 2; step <= maxSteps && frontier.length > 0; step += 1) {
		const next: number[] = [];
		for (const i of frontier) {
			const x = i % widthEv;
			const y = (i - x) / widthEv;
			for (let dy = -1; dy <= 1; dy += 1) {
				for (let dx = -1; dx <= 1; dx += 1) {
					if (dx === 0 && dy === 0) continue;
					const nx = x + dx;
					const ny = y + dy;
					if (nx < 0 || nx >= widthEv || ny < 0 || ny >= heightEv) continue;
					const j = ny * widthEv + nx;
					if (labels[j] !== 0 || band[j] === 0) continue;
					if (dist[j] === -1) {
						dist[j] = step;
						owner[j] = owner[i];
						next.push(j);
					} else if (owner[j] !== owner[i]) {
						considerMeeting(owner[i], owner[j], dist[i] + dist[j], x, y);
					}
				}
			}
		}
		frontier = next;
	}
	return [...best.values()].sort((a, b) => a.gapPx - b.gapPx);
}

function reachable(start: number, connections: readonly LocalConnection[], thresholdPx: number): Set<number> {
	const adjacency = new Map<number, number[]>();
	for (const connection of connections) {
		if (connection.gapPx > thresholdPx) continue;
		adjacency.set(connection.a, [...(adjacency.get(connection.a) ?? []), connection.b]);
		adjacency.set(connection.b, [...(adjacency.get(connection.b) ?? []), connection.a]);
	}
	const seen = new Set<number>([start]);
	const stack = [start];
	while (stack.length > 0) {
		const label = stack.pop() as number;
		for (const next of adjacency.get(label) ?? []) {
			if (seen.has(next)) continue;
			seen.add(next);
			stack.push(next);
		}
	}
	return seen;
}

function render(
	raster: { data: Uint8Array; widthPx: number; heightPx: number },
	segmentation: RibbonMassSegmentation,
	kept: ReadonlySet<number>,
	bands: readonly GlyphBand[],
	connections: readonly LocalConnection[],
	outPath: string
): void {
	const { widthPx, heightPx } = raster;
	const png = new PNG({ width: widthPx, height: heightPx });
	raster.data.forEach((value, index) => {
		png.data[index] = value;
	});
	const blend = (x: number, y: number, r: number, g: number, b: number, alpha: number) => {
		const xi = Math.round(x);
		const yi = Math.round(y);
		if (xi < 0 || xi >= widthPx || yi < 0 || yi >= heightPx) return;
		const p = (yi * widthPx + xi) * 4;
		png.data[p] = Math.round(png.data[p] * (1 - alpha) + r * alpha);
		png.data[p + 1] = Math.round(png.data[p + 1] * (1 - alpha) + g * alpha);
		png.data[p + 2] = Math.round(png.data[p + 2] * (1 - alpha) + b * alpha);
	};
	const disc = (x: number, y: number, radius: number, r: number, g: number, b: number, alpha: number) => {
		for (let dy = -radius; dy <= radius; dy += 1) {
			for (let dx = -radius; dx <= radius; dx += 1) {
				if (dx * dx + dy * dy <= radius * radius) blend(x + dx, y + dy, r, g, b, alpha);
			}
		}
	};
	const { labels, widthEv, heightEv, scale } = segmentation;
	for (let y = 0; y < heightEv; y += 1) {
		for (let x = 0; x < widthEv; x += 1) {
			if (!kept.has(labels[y * widthEv + x])) continue;
			for (let sy = 0; sy < scale; sy += 1) {
				for (let sx = 0; sx < scale; sx += 1) blend(x * scale + sx, y * scale + sy, 60, 230, 90, 0.35);
			}
		}
	}
	// Predicted basket-icon footprints, faint cyan outlines.
	for (const band of bands) {
		for (let step = 0; step < 180; step += 1) {
			const angle = (step / 180) * Math.PI * 2;
			blend(band.xPx + band.radiusPx * Math.cos(angle), band.yPx + band.radiusPx * Math.sin(angle), 60, 220, 255, 0.75);
		}
	}
	// Every accepted local connection, no hiding behind aggregate metrics.
	for (const connection of connections) {
		const radius = Math.max(3, Math.round(connection.gapPx / 3));
		disc(connection.xPx, connection.yPx, radius, 255, 40, 40, 0.9);
	}
	writeFileSync(outPath, PNG.sync.write(png));
	console.log(`wrote ${outPath}`);
}

const raster = loadFixtureRaster(join(process.cwd(), GOLDEN_ZIP));
const segmentation = segmentRibbonMass(
	raster,
	GOLDEN_BADGES.map(([, xPx, yPx]) => ({ xPx, yPx })),
	DEFAULT_RIBBON_MASS_PARAMS
);
const baskets = GOLDEN_TRUTH.map(([holeNumber, , , xPx, yPx]) => ({ holeNumber, xPx, yPx }));
const uiScalePx = loadUiScalePx();
const glyphBands = buildGlyphBands(baskets, uiScalePx);
const bandMask = buildBandMask(segmentation, glyphBands);
const connections = glyphClose(segmentation, bandMask, glyphBands);

console.log(`Dash / GoldenTeeSet basket-glyph close`);
console.log(`uiScalePx from production detector cache: ${uiScalePx.toFixed(4)}`);
console.log(
	`glyph geometry from deriveBasketIconMasksPx: offset centers/radius already production-measured; local close cap=${MAX_CLOSE_PX}px`
);
console.log(`accepted glyph-local connections: ${connections.length}`);

const bins = new Map<number, number>();
for (const connection of connections) {
	const bin = Math.floor(connection.gapPx / 3) * 3;
	bins.set(bin, (bins.get(bin) ?? 0) + 1);
}
for (const [bin, count] of [...bins.entries()].sort((a, b) => a[0] - b[0])) {
	console.log(`  gap ${bin}-${bin + 3}px: ${'#'.repeat(count)} (${count})`);
}
for (const connection of connections) {
	console.log(
		`  C${connection.a}<->C${connection.b} gap=${connection.gapPx.toFixed(1)}px via ${connection.glyphHoles.map((n) => `B${n}`).join(',') || 'glyph band'}`
	);
}

const seeds: RibbonMassSeed[] = [
	...GOLDEN_BADGES.map(([holeNumber, xPx, yPx]) => ({
		seedId: `badge-${holeNumber}`,
		kind: 'badge' as const,
		holeNumber,
		xPx,
		yPx
	})),
	...baskets.map((basket) => ({
		seedId: `basket-${basket.holeNumber}`,
		kind: 'basket' as const,
		holeNumber: basket.holeNumber,
		xPx: basket.xPx,
		yPx: basket.yPx
	}))
];
const placements = placeSeeds(segmentation, seeds, DEFAULT_RIBBON_MASS_PARAMS.seedRadiusPx);
const topology = topologyBuckets(placements, GOLDEN_TRUTH.map(([n]) => n));

console.log(`\nTargeted Dash holes (raw -> glyph-only local close):`);
for (const hole of topology.perHole) {
	if (!TARGET_HOLES.has(hole.holeNumber)) continue;
	const badgeLabel = hole.badgeComponentLabel;
	const basketLabel = hole.basketComponentLabel;
	const [, tx, ty] = GOLDEN_TRUTH.find(([n]) => n === hole.holeNumber) as (typeof GOLDEN_TRUTH)[number];
	const rawReach = badgeLabel === null ? new Set<number>() : new Set<number>([badgeLabel]);
	const closedReach = badgeLabel === null ? new Set<number>() : reachable(badgeLabel, connections, MAX_CLOSE_PX);
	const rawTeeDist =
		rawReach.size === 0
			? Infinity
			: nearestKeptDistancePx(segmentation.labels, segmentation.widthEv, segmentation.heightEv, segmentation.scale, rawReach, tx, ty);
	const closedTeeDist =
		closedReach.size === 0
			? Infinity
			: nearestKeptDistancePx(
					segmentation.labels,
					segmentation.widthEv,
					segmentation.heightEv,
					segmentation.scale,
					closedReach,
					tx,
					ty
				);
	let connectedAt: number | null = null;
	for (const threshold of GAP_THRESHOLDS_PX) {
		if (badgeLabel !== null && basketLabel !== null && reachable(badgeLabel, connections, threshold).has(basketLabel)) {
			connectedAt = threshold;
			break;
		}
	}
	console.log(
		`  H${hole.holeNumber}: badge<->basket ${badgeLabel !== null && badgeLabel === basketLabel ? 'already-connected' : connectedAt === null ? 'still-split' : `repairs<=${connectedAt}px`}; tee dist ${Number.isFinite(rawTeeDist) ? rawTeeDist.toFixed(1) : 'inf'} -> ${Number.isFinite(closedTeeDist) ? closedTeeDist.toFixed(1) : 'inf'}px`
	);
}

if (process.argv.includes('--render')) {
	const kept = new Set<number>();
	for (const placement of placements) {
		if (placement.componentLabel !== null) kept.add(placement.componentLabel);
	}
	for (const label of segmentation.textureKeptLabels) kept.add(label);
	render(
		raster,
		segmentation,
		kept,
		glyphBands,
		connections,
		join(process.cwd(), 'scripts/cv-probes/ribbon-mass-results-ts/GoldenTeeSet-basket-glyph-close.png')
	);
}
