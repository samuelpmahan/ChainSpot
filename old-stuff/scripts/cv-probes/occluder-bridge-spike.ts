/**
 * Occluder-repair spike, v2: strictly LOCAL, stroke-scale annulus closing.
 *
 * HISTORY, kept on purpose: v1 of this spike "bridged" component pairs
 * whose closest-approach chord (up to 90px!) straddled a discovered ring
 * radius, applied a global union-find, and reported tee recall 14/18 ->
 * 18/18 on both fixtures. Rendering the actual bridge chords falsified
 * it: the rule reduced to permissive long-distance component merging, and
 * the recall number was contaminated by global transitive kept-promotion
 * (a bad bridge pulling a formerly-unkept island near a tee into one
 * giant kept group). Revised claim from v1: ring locations are strongly
 * implicated in the remaining splits, but a chord-straddle bridge rule is
 * INVALID as a repair mechanism. This file is the re-test.
 *
 * v2 mechanism — the hypothesis stated so it can fail: "the rendered ring
 * glyph punched a tiny, stroke-width hole in an otherwise continuous
 * ribbon." If that is true, ribbon fragments must reconnect by growing a
 * FEW pixels through the predicted annulus band and nowhere else:
 *
 * - Occluder bands: |dist(px, basket) - r| <= BAND_HALF_WIDTH_PX for each
 *   per-course radius r DISCOVERED from the median radial brightness
 *   profile (never hardcoded; the fixtures differ ~25% in capture zoom).
 *   Extracted global lines would get an equivalent band; the evidence-
 *   ridge Hough currently finds zero on these fixtures (powerlines
 *   suppress evidence rather than emit it — needs a dark-line extractor,
 *   still open).
 * - Repair: multi-source BFS wavefronts grow from every component
 *   simultaneously, stepping ONLY through non-evidence pixels inside a
 *   band, to a max total gap of MAX_CLOSE_PX (18px source — stroke scale,
 *   not radius scale). Where two different components' wavefronts meet,
 *   that pair is connected at that gap length. Locality, annulus
 *   intersection, and same-crossing-point all hold by construction — a
 *   chord across open terrain is impossible.
 * - No global union-find anywhere. Per-hole evaluation only: is the
 *   badge's component connected to the basket's component through
 *   accepted connections at threshold t; how close does the component set
 *   REACHABLE FROM THE BADGE get to the truth tee. A repair chained
 *   through a foreign corridor shows up as path length, not silent
 *   success.
 * - The accepted-gap HISTOGRAM is a primary output: the hypothesis
 *   predicts a sharp cluster of tiny gaps. If success were to need
 *   40-90px, the mechanism claim is dead (that was v1's failure).
 *
 * Local tangent agreement between the two fragments is deliberately NOT
 * required yet — at <=18px total gap it should rarely matter; add it only
 * if false connections show up in the render (--render draws every
 * accepted meeting point).
 *
 * Measurement probe only; nothing wired into production or the shadow
 * path (explicitly deferred until this local mechanism survives).
 *
 * Usage:
 *   npx tsx scripts/cv-probes/occluder-bridge-spike.ts [--render]
 */
import { writeFileSync } from 'node:fs';
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
import { FIXTURE_COURSES, loadFixtureRaster } from './ribbonMassFixtures';

/** Half-width of an occluder band, source px — ring stroke + opening erosion, NOT radius scale. */
const BAND_HALF_WIDTH_PX = 12;
/** Max total gap a repair may close, source px. Stroke scale; v1's 90px cap is exactly what got falsified. */
const MAX_CLOSE_PX = 18;
/** Gap thresholds reported cumulatively (source px). */
const GAP_THRESHOLDS_PX = [6, 9, 12, 15, 18] as const;

const LINE_MIN_SPAN_PX = 260;
const LINE_MIN_FILL = 0.25;
const THIN_HALF_WIDTH_EV = 2;

// ---------------------------------------------------------------------------
// Ring-radius discovery (unchanged from v1): median radial brightness
// profile around all baskets, per course.
// ---------------------------------------------------------------------------

function grayscale(raster: { data: Uint8Array; widthPx: number; heightPx: number }): Float32Array {
	const out = new Float32Array(raster.widthPx * raster.heightPx);
	for (let i = 0; i < out.length; i += 1) {
		const p = i * 4;
		out[i] = (raster.data[p] + raster.data[p + 1] + raster.data[p + 2]) / 3;
	}
	return out;
}

function discoverRingRadii(
	gray: Float32Array,
	widthPx: number,
	heightPx: number,
	baskets: readonly { xPx: number; yPx: number }[]
): { radii: number[]; profile: { r: number; value: number }[] } {
	const R_MIN = 10;
	const R_MAX = 140;
	const R_STEP = 2;
	const N_ANGLES = 144;
	const angles = Array.from({ length: N_ANGLES }, (_, i) => (2 * Math.PI * i) / N_ANGLES);
	const perBasket: number[][] = [];
	for (const basket of baskets) {
		const profile: number[] = [];
		for (let r = R_MIN; r <= R_MAX; r += R_STEP) {
			let sum = 0;
			let n = 0;
			for (const angle of angles) {
				const x = Math.round(basket.xPx + r * Math.cos(angle));
				const y = Math.round(basket.yPx + r * Math.sin(angle));
				if (x < 0 || x >= widthPx || y < 0 || y >= heightPx) continue;
				sum += gray[y * widthPx + x];
				n += 1;
			}
			profile.push(n > 0 ? sum / n : 0);
		}
		const sorted = [...profile].sort((a, b) => a - b);
		const baseline = sorted[Math.floor(sorted.length / 2)];
		perBasket.push(profile.map((value) => value - baseline));
	}
	const nBins = perBasket[0]?.length ?? 0;
	const profile: { r: number; value: number }[] = [];
	for (let bin = 0; bin < nBins; bin += 1) {
		const values = perBasket.map((p) => p[bin]).sort((a, b) => a - b);
		profile.push({ r: R_MIN + bin * R_STEP, value: values[Math.floor(values.length / 2)] });
	}
	const radii: number[] = [];
	for (let bin = 0; bin < nBins; bin += 1) {
		const v = profile[bin].value;
		if (v < 2) continue;
		let isMax = true;
		for (let k = Math.max(0, bin - 4); k <= Math.min(nBins - 1, bin + 4); k += 1) {
			if (profile[k].value > v) isMax = false;
		}
		if (isMax && !radii.some((r) => Math.abs(r - profile[bin].r) < 16)) radii.push(profile[bin].r);
	}
	return { radii: radii.sort((a, b) => a - b), profile };
}

// ---------------------------------------------------------------------------
// Line extraction (unchanged from v1; still finds zero on these fixtures —
// see module doc). Kept so a future dark-line extractor slots into the
// same band machinery.
// ---------------------------------------------------------------------------

interface ExtractedLine {
	readonly thetaRad: number;
	readonly rhoPx: number;
	readonly spanPx: number;
	readonly fill: number;
	readonly supportPx: number;
}

function extractLines(segmentation: RibbonMassSegmentation): ExtractedLine[] {
	const { labels, widthEv, heightEv, scale } = segmentation;
	const thin: { x: number; y: number }[] = [];
	const isEvidence = (x: number, y: number) =>
		x >= 0 && x < widthEv && y >= 0 && y < heightEv && labels[y * widthEv + x] !== 0;
	for (let y = 0; y < heightEv; y += 1) {
		for (let x = 0; x < widthEv; x += 1) {
			if (labels[y * widthEv + x] === 0) continue;
			const thinH = !isEvidence(x - THIN_HALF_WIDTH_EV, y) && !isEvidence(x + THIN_HALF_WIDTH_EV, y);
			const thinV = !isEvidence(x, y - THIN_HALF_WIDTH_EV) && !isEvidence(x, y + THIN_HALF_WIDTH_EV);
			if (thinH || thinV) thin.push({ x, y });
		}
	}
	const N_THETA = 180;
	const rhoStep = 2;
	const maxRho = Math.ceil(Math.hypot(widthEv, heightEv));
	const nRho = Math.ceil((2 * maxRho) / rhoStep);
	const acc = new Uint32Array(N_THETA * nRho);
	const cos = Array.from({ length: N_THETA }, (_, t) => Math.cos((Math.PI * t) / N_THETA));
	const sin = Array.from({ length: N_THETA }, (_, t) => Math.sin((Math.PI * t) / N_THETA));
	for (const point of thin) {
		for (let t = 0; t < N_THETA; t += 1) {
			const rho = point.x * cos[t] + point.y * sin[t];
			acc[t * nRho + Math.round((rho + maxRho) / rhoStep)] += 1;
		}
	}
	const lines: ExtractedLine[] = [];
	const used: { t: number; bin: number }[] = [];
	const MIN_VOTES = 40;
	for (let pass = 0; pass < 8; pass += 1) {
		let best = -1;
		let bestT = 0;
		let bestBin = 0;
		for (let t = 0; t < N_THETA; t += 1) {
			for (let bin = 0; bin < nRho; bin += 1) {
				if (acc[t * nRho + bin] <= best) continue;
				if (used.some((u) => Math.abs(u.t - t) < 6 && Math.abs(u.bin - bin) < 6)) continue;
				best = acc[t * nRho + bin];
				bestT = t;
				bestBin = bin;
			}
		}
		if (best < MIN_VOTES) break;
		used.push({ t: bestT, bin: bestBin });
		const theta = (Math.PI * bestT) / N_THETA;
		const rho = bestBin * rhoStep - maxRho;
		const dir = { x: -Math.sin(theta), y: Math.cos(theta) };
		const support = thin.filter((p) => Math.abs(p.x * Math.cos(theta) + p.y * Math.sin(theta) - rho) <= 2);
		if (support.length < MIN_VOTES) continue;
		const ts = support.map((p) => p.x * dir.x + p.y * dir.y).sort((a, b) => a - b);
		const spanEv = ts[ts.length - 1] - ts[0];
		const occupied = new Set(ts.map((t) => Math.round(t / 4)));
		const fill = occupied.size / Math.max(1, Math.ceil(spanEv / 4));
		const spanPx = spanEv * scale;
		if (spanPx < LINE_MIN_SPAN_PX || fill < LINE_MIN_FILL) continue;
		lines.push({
			thetaRad: theta,
			rhoPx: rho * scale,
			spanPx: Math.round(spanPx),
			fill: Math.round(fill * 100) / 100,
			supportPx: support.length
		});
	}
	return lines;
}

// ---------------------------------------------------------------------------
// Band mask + stroke-scale closing
// ---------------------------------------------------------------------------

function buildBandMask(
	segmentation: RibbonMassSegmentation,
	baskets: readonly { xPx: number; yPx: number }[],
	radii: readonly number[],
	lines: readonly ExtractedLine[]
): Uint8Array {
	const { widthEv, heightEv, scale } = segmentation;
	const band = new Uint8Array(widthEv * heightEv);
	for (const basket of baskets) {
		for (const r of radii) {
			const rEvMin = (r - BAND_HALF_WIDTH_PX) / scale;
			const rEvMax = (r + BAND_HALF_WIDTH_PX) / scale;
			const bx = basket.xPx / scale;
			const by = basket.yPx / scale;
			const x0 = Math.max(0, Math.floor(bx - rEvMax));
			const x1 = Math.min(widthEv - 1, Math.ceil(bx + rEvMax));
			const y0 = Math.max(0, Math.floor(by - rEvMax));
			const y1 = Math.min(heightEv - 1, Math.ceil(by + rEvMax));
			for (let y = y0; y <= y1; y += 1) {
				for (let x = x0; x <= x1; x += 1) {
					const d = Math.hypot(x - bx, y - by);
					if (d >= rEvMin && d <= rEvMax) band[y * widthEv + x] = 1;
				}
			}
		}
	}
	for (const line of lines) {
		const cosT = Math.cos(line.thetaRad);
		const sinT = Math.sin(line.thetaRad);
		for (let y = 0; y < heightEv; y += 1) {
			for (let x = 0; x < widthEv; x += 1) {
				if (Math.abs((x * cosT + y * sinT) * scale - line.rhoPx) <= BAND_HALF_WIDTH_PX)
					band[y * widthEv + x] = 1;
			}
		}
	}
	return band;
}

interface LocalConnection {
	readonly a: number;
	readonly b: number;
	/** Total closed gap, source px (BFS steps of both wavefronts). */
	readonly gapPx: number;
	/** Meeting point, source px — where the two wavefronts touched. */
	readonly xPx: number;
	readonly yPx: number;
}

/**
 * Multi-source BFS: every component's wavefront grows simultaneously
 * through NON-evidence pixels INSIDE the band, up to MAX_CLOSE_PX total.
 * Where two different labels' fronts become adjacent, record the pair at
 * gap = dA + dB + 1 steps. Growth cannot leave the band, so every
 * connection is a genuine through-the-occluder repair by construction.
 */
function annulusClose(segmentation: RibbonMassSegmentation, band: Uint8Array): LocalConnection[] {
	const { labels, widthEv, heightEv, scale } = segmentation;
	const maxSteps = Math.ceil(MAX_CLOSE_PX / scale);
	const owner = new Int32Array(labels.length); // claiming component per band pixel
	const dist = new Int32Array(labels.length).fill(-1);
	let frontier: number[] = [];
	// Seed: non-evidence band pixels 8-adjacent to evidence claim that label at dist 1.
	const best = new Map<string, LocalConnection>();
	const considerMeeting = (labelA: number, labelB: number, gapSteps: number, x: number, y: number) => {
		if (labelA === labelB) return;
		const key = labelA < labelB ? `${labelA}:${labelB}` : `${labelB}:${labelA}`;
		const gapPx = gapSteps * scale;
		if (gapPx > MAX_CLOSE_PX) return;
		const existing = best.get(key);
		if (!existing || gapPx < existing.gapPx) {
			best.set(key, {
				a: Math.min(labelA, labelB),
				b: Math.max(labelA, labelB),
				gapPx,
				xPx: x * scale,
				yPx: y * scale
			});
		}
	};
	for (let y = 0; y < heightEv; y += 1) {
		for (let x = 0; x < widthEv; x += 1) {
			const i = y * widthEv + x;
			if (labels[i] !== 0 || band[i] === 0) continue;
			for (let dy = -1; dy <= 1; dy += 1) {
				for (let dx = -1; dx <= 1; dx += 1) {
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
						// A band pixel adjacent to two different components:
						// the tiniest possible tear (1 step).
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

/** Component set reachable from `start` using connections with gap <= thresholdPx. No union-find; per-query BFS. */
function reachable(start: number, connections: readonly LocalConnection[], thresholdPx: number): Set<number> {
	const adjacency = new Map<number, number[]>();
	for (const c of connections) {
		if (c.gapPx > thresholdPx) continue;
		adjacency.set(c.a, [...(adjacency.get(c.a) ?? []), c.b]);
		adjacency.set(c.b, [...(adjacency.get(c.b) ?? []), c.a]);
	}
	const seen = new Set<number>([start]);
	const stack = [start];
	while (stack.length > 0) {
		const label = stack.pop() as number;
		for (const next of adjacency.get(label) ?? []) {
			if (!seen.has(next)) {
				seen.add(next);
				stack.push(next);
			}
		}
	}
	return seen;
}

// ---------------------------------------------------------------------------
// Render (--render): kept mask green, bands faint white, accepted meeting
// points as red dots sized by gap — every repair the algorithm actually used.
// ---------------------------------------------------------------------------

function render(
	raster: { data: Uint8Array; widthPx: number; heightPx: number },
	segmentation: RibbonMassSegmentation,
	kept: ReadonlySet<number>,
	band: Uint8Array,
	connections: readonly LocalConnection[],
	truthTees: readonly { xPx: number; yPx: number }[],
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
	const { labels, widthEv, heightEv, scale } = segmentation;
	for (let y = 0; y < heightEv; y += 1) {
		for (let x = 0; x < widthEv; x += 1) {
			const i = y * widthEv + x;
			const isKept = kept.has(labels[i]);
			const isBand = band[i] === 1 && labels[i] === 0;
			if (!isKept && !isBand) continue;
			for (let sy = 0; sy < scale; sy += 1) {
				for (let sx = 0; sx < scale; sx += 1) {
					if (isKept) blend(x * scale + sx, y * scale + sy, 60, 230, 90, 0.35);
					else blend(x * scale + sx, y * scale + sy, 255, 255, 255, 0.18);
				}
			}
		}
	}
	for (const c of connections) {
		const radius = Math.max(3, Math.round(c.gapPx / 3));
		for (let dy = -radius; dy <= radius; dy += 1)
			for (let dx = -radius; dx <= radius; dx += 1)
				if (dx * dx + dy * dy <= radius * radius) blend(c.xPx + dx, c.yPx + dy, 255, 40, 40, 0.85);
	}
	for (const tee of truthTees) {
		for (let step = 0; step < 120; step += 1) {
			const angle = (2 * Math.PI * step) / 120;
			blend(tee.xPx + 9 * Math.cos(angle), tee.yPx + 9 * Math.sin(angle), 40, 140, 255, 0.95);
			blend(tee.xPx + 10 * Math.cos(angle), tee.yPx + 10 * Math.sin(angle), 40, 140, 255, 0.95);
		}
	}
	writeFileSync(outPath, PNG.sync.write(png));
	console.log(`  wrote ${outPath}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

for (const course of FIXTURE_COURSES) {
	console.log(`\n================ ${course.name} ================`);
	const raster = loadFixtureRaster(join(process.cwd(), course.zip));
	const segmentation = segmentRibbonMass(
		raster,
		course.badges.map(([, xPx, yPx]) => ({ xPx, yPx })),
		DEFAULT_RIBBON_MASS_PARAMS
	);
	const baskets = course.truth.map(([n, , , bx, by]) => ({ holeNumber: n, xPx: bx, yPx: by }));

	const gray = grayscale(raster);
	const { radii } = discoverRingRadii(gray, raster.widthPx, raster.heightPx, baskets);
	console.log(`ring radii discovered: [${radii.join(', ')}]px`);
	const lines = extractLines(segmentation);
	console.log(`lines extracted: ${lines.length}${lines.length === 0 ? ' (known limitation — see module doc)' : ''}`);

	const band = buildBandMask(segmentation, baskets, radii, lines);
	const connections = annulusClose(segmentation, band);

	// PRIMARY OUTPUT: accepted-gap histogram. The mechanism predicts a
	// sharp cluster of tiny gaps.
	console.log(`\naccepted local connections: ${connections.length} (max total gap ${MAX_CLOSE_PX}px)`);
	const bins = new Map<number, number>();
	for (const c of connections) {
		const bin = Math.floor(c.gapPx / 3) * 3;
		bins.set(bin, (bins.get(bin) ?? 0) + 1);
	}
	for (const [bin, count] of [...bins.entries()].sort((a, b) => a[0] - b[0])) {
		console.log(`  gap ${String(bin).padStart(2)}-${String(bin + 3).padStart(2)}px: ${'#'.repeat(count)} (${count})`);
	}

	const seeds: RibbonMassSeed[] = [
		...course.badges.map(([n, xPx, yPx]) => ({
			seedId: `badge-${n}`,
			kind: 'badge' as const,
			holeNumber: n,
			xPx,
			yPx
		})),
		...baskets.map((b) => ({
			seedId: `basket-${b.holeNumber}`,
			kind: 'basket' as const,
			holeNumber: b.holeNumber,
			xPx: b.xPx,
			yPx: b.yPx
		}))
	];
	const placements = placeSeeds(segmentation, seeds, DEFAULT_RIBBON_MASS_PARAMS.seedRadiusPx);
	const topology = topologyBuckets(placements, course.truth.map(([n]) => n));

	// Per-hole, per-threshold: badge<->basket connectivity through local
	// repairs, and tee reach from the badge's own reachable set only.
	console.log(`\nper-hole repair (thresholds ${GAP_THRESHOLDS_PX.join('/')}px):`);
	let repairedAtMax = 0;
	let teeReachedAtMax = 0;
	for (const hole of topology.perHole) {
		const badgeLabel = hole.badgeComponentLabel;
		const basketLabel = hole.basketComponentLabel;
		const [, tx, ty] = course.truth.find(([n]) => n === hole.holeNumber) as (typeof course.truth)[number];
		let connectedAt: number | null = null;
		for (const t of GAP_THRESHOLDS_PX) {
			if (badgeLabel !== null && basketLabel !== null && reachable(badgeLabel, connections, t).has(basketLabel)) {
				connectedAt = t;
				break;
			}
		}
		const alreadySame = badgeLabel !== null && badgeLabel === basketLabel;
		const reachSet = badgeLabel === null ? new Set<number>() : reachable(badgeLabel, connections, MAX_CLOSE_PX);
		const teeDist =
			reachSet.size === 0
				? Infinity
				: nearestKeptDistancePx(
						segmentation.labels,
						segmentation.widthEv,
						segmentation.heightEv,
						segmentation.scale,
						reachSet,
						tx,
						ty
					);
		if (alreadySame || connectedAt !== null) repairedAtMax += 1;
		if (teeDist <= 30) teeReachedAtMax += 1;
		const status = alreadySame
			? 'already same component'
			: connectedAt !== null
				? `repaired at <=${connectedAt}px`
				: hole.bucket === 'noSeedHit'
					? 'no seed hit'
					: 'NOT repaired';
		console.log(
			`  hole ${String(hole.holeNumber).padStart(2)} [${hole.bucket}]: ${status}; tee dist via badge-reachable set: ${Number.isFinite(teeDist) ? `${teeDist.toFixed(1)}px` : 'inf'}`
		);
	}
	console.log(
		`\nbadge<->basket connected (incl. already-same): ${repairedAtMax}/18   tee within 30px of badge-reachable set: ${teeReachedAtMax}/18`
	);

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
			band,
			connections,
			course.truth.map(([, tx, ty]) => ({ xPx: tx, yPx: ty })),
			join(process.cwd(), `scripts/cv-probes/ribbon-mass-results-ts/${course.name}-annulus-close.png`)
		);
	}
}
