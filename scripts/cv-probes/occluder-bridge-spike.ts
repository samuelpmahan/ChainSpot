/**
 * Occluder-bridge spike: can corridor splits be repaired by bridging ONLY
 * across predicted occluder geometry — ring arcs around baskets and
 * image-global straight lines (powerlines) — with no generic gap-jumping?
 *
 * Two occluder primitives, one bridging mechanism:
 *
 * RINGS — `ring-arc-spike.ts` established that split gaps overwhelmingly
 * straddle per-course radii around the hole's own (or a foreign) basket:
 * the C1/C2 putting-circle glyphs plus the basket-marker glyph. Radii are
 * DISCOVERED per course from the image itself (median radial brightness
 * profile around all baskets), never hardcoded — the two fixtures have a
 * known ~25% capture-zoom difference.
 *
 * LINES — powerlines are dual-role confusers observed live (2026-08): the
 * ribbon mass FOLLOWS them on one hole while they CUT another hole's
 * corridor, and one line may cut only one corridor — so lines must be
 * extracted globally from the evidence map (long + straight + thin), not
 * inferred from gap collinearity across holes (tried conceptually,
 * refuted: on the live course no two gaps share a line). Extraction cue is
 * length + straightness + thinness; the known precision risk is a long
 * straight cart path or fairway edge (straightness alone already killed
 * the elongation signal once — roads).
 *
 * BRIDGE RULE — two components merge iff their closest-approach gap is
 * short (<= maxBridgePx) AND the gap lies ON a predicted occluder: the
 * gap's distance interval to a basket straddles a discovered ring radius,
 * or the gap midpoint sits on an extracted line with the endpoints
 * straddling it. Measurement probe only: nothing here is wired into
 * production, and the numbers reported include the failure cases (new
 * false shared-components) alongside the wins.
 *
 * Usage:
 *   npx tsx scripts/cv-probes/occluder-bridge-spike.ts
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import {
	DEFAULT_RIBBON_MASS_PARAMS,
	nearestKeptDistancePx,
	placeSeeds,
	recommendedKeptLabels,
	segmentRibbonMass,
	topologyBuckets
} from '../../src/lib/autoAnnotation/ribbonMass';
import type {
	RibbonMassSeed,
	RibbonMassSeedPlacement,
	RibbonMassSegmentation
} from '../../src/lib/autoAnnotation/ribbonMass';
import { FIXTURE_COURSES, loadFixtureRaster } from './ribbonMassFixtures';

const RING_HALF_WIDTH_PX = 12; // straddle tolerance around a discovered radius, source px
const MAX_BRIDGE_PX = 90; // widest observed ring tear was ~78px; caps how far any bridge reaches
const LINE_DIST_PX = 12; // how close a gap midpoint must sit to an extracted line
const LINE_MIN_SPAN_PX = 260; // extracted lines must be far longer than any fairway-scale feature
const LINE_MIN_FILL = 0.25; // fraction of the span that has supporting thin evidence (dashes/vegetation gaps)
const THIN_HALF_WIDTH_EV = 2; // "thin" = local half-width <= 2 evidence px (~6 source px)

// ---------------------------------------------------------------------------
// Ring-radius discovery: median radial brightness profile around baskets.
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
		// Remove this basket's terrain-brightness baseline so the median
		// across baskets compares ring signal, not ground color.
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
	// Peaks: local maxima over a +-4-bin window with absolute prominence.
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
// Line extraction: Hough over THIN evidence pixels.
// ---------------------------------------------------------------------------

interface ExtractedLine {
	/** Normal form: x*cos(theta) + y*sin(theta) = rho, in SOURCE px. */
	readonly thetaRad: number;
	readonly rhoPx: number;
	readonly spanPx: number;
	readonly fill: number;
	readonly supportPx: number;
}

function extractLines(segmentation: RibbonMassSegmentation): ExtractedLine[] {
	const { labels, widthEv, heightEv, scale } = segmentation;
	// Thin evidence pixels: on evidence, but with a non-evidence pixel within
	// THIN_HALF_WIDTH_EV — a cheap local-width test (full EDT not needed).
	const thin: { x: number; y: number }[] = [];
	const isEvidence = (x: number, y: number) =>
		x >= 0 && x < widthEv && y >= 0 && y < heightEv && labels[y * widthEv + x] !== 0;
	for (let y = 0; y < heightEv; y += 1) {
		for (let x = 0; x < widthEv; x += 1) {
			if (labels[y * widthEv + x] === 0) continue;
			let nearEdge = false;
			for (let d = 1; d <= THIN_HALF_WIDTH_EV && !nearEdge; d += 1) {
				if (!isEvidence(x - d, y) || !isEvidence(x + d, y) || !isEvidence(x, y - d) || !isEvidence(x, y + d))
					nearEdge = true;
			}
			// Thin = edges on BOTH sides of at least one axis within the bound.
			const thinH = !isEvidence(x - THIN_HALF_WIDTH_EV, y) && !isEvidence(x + THIN_HALF_WIDTH_EV, y);
			const thinV = !isEvidence(x, y - THIN_HALF_WIDTH_EV) && !isEvidence(x, y + THIN_HALF_WIDTH_EV);
			if (thinH || thinV) thin.push({ x, y });
		}
	}

	const N_THETA = 180;
	const rhoStep = 2; // evidence px
	const maxRho = Math.ceil(Math.hypot(widthEv, heightEv));
	const nRho = Math.ceil((2 * maxRho) / rhoStep);
	const acc = new Uint32Array(N_THETA * nRho);
	const cos = Array.from({ length: N_THETA }, (_, t) => Math.cos((Math.PI * t) / N_THETA));
	const sin = Array.from({ length: N_THETA }, (_, t) => Math.sin((Math.PI * t) / N_THETA));
	for (const point of thin) {
		for (let t = 0; t < N_THETA; t += 1) {
			const rho = point.x * cos[t] + point.y * sin[t];
			const bin = Math.round((rho + maxRho) / rhoStep);
			acc[t * nRho + bin] += 1;
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
		// Gather supporting thin pixels within 2 evidence px of the line and
		// measure span + fill along it.
		const theta = (Math.PI * bestT) / N_THETA;
		const rho = bestBin * rhoStep - maxRho;
		const dir = { x: -Math.sin(theta), y: Math.cos(theta) };
		const support = thin.filter(
			(p) => Math.abs(p.x * Math.cos(theta) + p.y * Math.sin(theta) - rho) <= 2
		);
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
// Bridging
// ---------------------------------------------------------------------------

class UnionFind {
	readonly parent = new Map<number, number>();
	find(a: number): number {
		let root = a;
		while (this.parent.get(root) !== undefined && this.parent.get(root) !== root)
			root = this.parent.get(root) as number;
		return root;
	}
	union(a: number, b: number): void {
		const ra = this.find(a);
		const rb = this.find(b);
		if (ra !== rb) this.parent.set(ra, rb);
	}
}

interface ComponentGeom {
	readonly label: number;
	readonly minX: number;
	readonly maxX: number;
	readonly minY: number;
	readonly maxY: number;
	readonly pixels: number[];
}

function componentGeometry(segmentation: RibbonMassSegmentation): Map<number, ComponentGeom> {
	const { labels, widthEv } = segmentation;
	const geoms = new Map<number, { minX: number; maxX: number; minY: number; maxY: number; pixels: number[] }>();
	for (let i = 0; i < labels.length; i += 1) {
		const label = labels[i];
		if (label === 0) continue;
		const x = i % widthEv;
		const y = (i - x) / widthEv;
		let geom = geoms.get(label);
		if (!geom) {
			geom = { minX: x, maxX: x, minY: y, maxY: y, pixels: [] };
			geoms.set(label, geom);
		}
		geom.minX = Math.min(geom.minX, x);
		geom.maxX = Math.max(geom.maxX, x);
		geom.minY = Math.min(geom.minY, y);
		geom.maxY = Math.max(geom.maxY, y);
		geom.pixels.push(i);
	}
	return new Map([...geoms.entries()].map(([label, g]) => [label, { label, ...g }]));
}

/** Closest pixel pair between two components (subsampled — same approach as ring-arc-spike). */
function closestPair(
	a: ComponentGeom,
	b: ComponentGeom,
	widthEv: number
): { ax: number; ay: number; bx: number; by: number; distEv: number } {
	const step = (arr: number[]) => Math.max(1, Math.floor(arr.length / 3000));
	const sa = step(a.pixels);
	const sb = step(b.pixels);
	let best = { ax: 0, ay: 0, bx: 0, by: 0, distEv: Infinity };
	for (let i = 0; i < a.pixels.length; i += sa) {
		const pa = a.pixels[i];
		const ax = pa % widthEv;
		const ay = (pa - ax) / widthEv;
		for (let j = 0; j < b.pixels.length; j += sb) {
			const pb = b.pixels[j];
			const bx = pb % widthEv;
			const by = (pb - bx) / widthEv;
			const d = Math.hypot(ax - bx, ay - by);
			if (d < best.distEv) best = { ax, ay, bx, by, distEv: d };
		}
	}
	return best;
}

function bboxDistToPoint(g: ComponentGeom, xEv: number, yEv: number): number {
	const dx = Math.max(g.minX - xEv, 0, xEv - g.maxX);
	const dy = Math.max(g.minY - yEv, 0, yEv - g.maxY);
	return Math.hypot(dx, dy);
}

interface BridgeRecord {
	readonly a: number;
	readonly b: number;
	readonly cause: string;
	readonly gapPx: number;
	/** Gap segment endpoints, source px — the exact span the bridge crosses. */
	readonly aXPx: number;
	readonly aYPx: number;
	readonly bXPx: number;
	readonly bYPx: number;
}

/**
 * Two ring-tear tests, both reported (no winner declared at N=2):
 * - 'straddle': endpoints on opposite sides of the radius. Loose — repairs
 *   the most (closed tee recall to 18/18 on both courses) but reduces to
 *   "both components near the basket" for small radii and over-merges.
 * - 'midpoint': additionally requires the gap midpoint ON the ring. Tight —
 *   keeps more exclusivity, repairs less.
 */
type RingRule = 'straddle' | 'midpoint';

function bridge(
	segmentation: RibbonMassSegmentation,
	baskets: readonly { holeNumber: number; xPx: number; yPx: number }[],
	radii: readonly number[],
	lines: readonly ExtractedLine[],
	ringRule: RingRule
): { uf: UnionFind; bridges: BridgeRecord[] } {
	const { widthEv, scale } = segmentation;
	const geoms = componentGeometry(segmentation);
	const uf = new UnionFind();
	const bridges: BridgeRecord[] = [];
	const pairTested = new Set<string>();

	const tryBridge = (
		a: ComponentGeom,
		b: ComponentGeom,
		test: (pair: ReturnType<typeof closestPair>) => string | null
	) => {
		const key = a.label < b.label ? `${a.label}:${b.label}` : `${b.label}:${a.label}`;
		const pair = closestPair(a, b, widthEv);
		if (pair.distEv * scale > MAX_BRIDGE_PX || pair.distEv === 0) return;
		const cause = test(pair);
		if (cause === null) return;
		if (uf.find(a.label) === uf.find(b.label)) return;
		if (pairTested.has(`${key}|${cause}`)) return;
		pairTested.add(`${key}|${cause}`);
		uf.union(a.label, b.label);
		bridges.push({
			a: a.label,
			b: b.label,
			cause,
			gapPx: Math.round(pair.distEv * scale * 10) / 10,
			aXPx: pair.ax * scale,
			aYPx: pair.ay * scale,
			bXPx: pair.bx * scale,
			bYPx: pair.by * scale
		});
	};

	// Ring bridges: candidate components approach the ring band of some basket.
	for (const basket of baskets) {
		const bxEv = basket.xPx / scale;
		const byEv = basket.yPx / scale;
		for (const r of radii) {
			const rEv = r / scale;
			const near = [...geoms.values()].filter((g) => {
				const d = bboxDistToPoint(g, bxEv, byEv);
				return d <= rEv + (RING_HALF_WIDTH_PX + MAX_BRIDGE_PX) / scale;
			});
			for (let i = 0; i < near.length; i += 1) {
				for (let j = i + 1; j < near.length; j += 1) {
					tryBridge(near[i], near[j], (pair) => {
						const dA = Math.hypot(pair.ax - bxEv, pair.ay - byEv) * scale;
						const dB = Math.hypot(pair.bx - bxEv, pair.by - byEv) * scale;
						const nearD = Math.min(dA, dB);
						const farD = Math.max(dA, dB);
						const straddles = nearD <= r + RING_HALF_WIDTH_PX && farD >= r - RING_HALF_WIDTH_PX;
						const midOnRing = Math.abs((dA + dB) / 2 - r) <= RING_HALF_WIDTH_PX;
						const passes = ringRule === 'straddle' ? straddles : straddles && midOnRing;
						return passes ? `ring r=${r} basket H${basket.holeNumber}` : null;
					});
				}
			}
		}
	}

	// Line bridges: gap midpoint on the line, endpoints straddling it.
	for (const [index, line] of lines.entries()) {
		const cosT = Math.cos(line.thetaRad);
		const sinT = Math.sin(line.thetaRad);
		const signedDist = (xEv: number, yEv: number) => (xEv * cosT + yEv * sinT) * scale - line.rhoPx;
		const near = [...geoms.values()].filter((g) => {
			const corners = [
				[g.minX, g.minY],
				[g.minX, g.maxY],
				[g.maxX, g.minY],
				[g.maxX, g.maxY]
			].map(([x, y]) => signedDist(x, y));
			return Math.min(...corners.map(Math.abs)) <= MAX_BRIDGE_PX || Math.min(...corners) * Math.max(...corners) < 0;
		});
		for (let i = 0; i < near.length; i += 1) {
			for (let j = i + 1; j < near.length; j += 1) {
				tryBridge(near[i], near[j], (pair) => {
					const dA = signedDist(pair.ax, pair.ay);
					const dB = signedDist(pair.bx, pair.by);
					const midOnLine = Math.abs((dA + dB) / 2) <= LINE_DIST_PX;
					const straddles = dA * dB <= 0 || Math.min(Math.abs(dA), Math.abs(dB)) <= LINE_DIST_PX;
					return midOnLine && straddles ? `line #${index} (${Math.round((line.thetaRad * 180) / Math.PI)}deg)` : null;
				});
			}
		}
	}

	return { uf, bridges };
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

function mappedPlacements(placements: readonly RibbonMassSeedPlacement[], uf: UnionFind) {
	return placements.map((p) => ({
		...p,
		componentLabel: p.componentLabel === null ? null : uf.find(p.componentLabel)
	}));
}

// ---------------------------------------------------------------------------
// Rendering (--render): the bridged result drawn on the source image —
// kept mask green, discovered rings dotted, bridges as thick red spans.
// ---------------------------------------------------------------------------

function renderBridges(
	raster: { data: Uint8Array; widthPx: number; heightPx: number },
	segmentation: RibbonMassSegmentation,
	kept: ReadonlySet<number>,
	baskets: readonly { xPx: number; yPx: number }[],
	radii: readonly number[],
	bridges: readonly BridgeRecord[],
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
	const disc = (x: number, y: number, radius: number, r: number, g: number, b: number, alpha: number) => {
		for (let dy = -radius; dy <= radius; dy += 1)
			for (let dx = -radius; dx <= radius; dx += 1)
				if (dx * dx + dy * dy <= radius * radius) blend(x + dx, y + dy, r, g, b, alpha);
	};

	// Kept mask, green tint.
	const { labels, widthEv, heightEv, scale } = segmentation;
	for (let y = 0; y < heightEv; y += 1) {
		for (let x = 0; x < widthEv; x += 1) {
			if (!kept.has(labels[y * widthEv + x])) continue;
			for (let sy = 0; sy < scale; sy += 1)
				for (let sx = 0; sx < scale; sx += 1) blend(x * scale + sx, y * scale + sy, 60, 230, 90, 0.35);
		}
	}
	// Discovered rings, dotted white.
	for (const basket of baskets) {
		for (const radius of radii) {
			for (let step = 0; step < 240; step += 1) {
				if (step % 4 >= 2) continue;
				const angle = (2 * Math.PI * step) / 240;
				blend(basket.xPx + radius * Math.cos(angle), basket.yPx + radius * Math.sin(angle), 255, 255, 255, 0.8);
			}
		}
	}
	// Bridges: thick red spans across the exact gap segment.
	for (const bridgeRecord of bridges) {
		const steps = Math.max(2, Math.ceil(bridgeRecord.gapPx));
		for (let step = 0; step <= steps; step += 1) {
			const t = step / steps;
			disc(
				bridgeRecord.aXPx + (bridgeRecord.bXPx - bridgeRecord.aXPx) * t,
				bridgeRecord.aYPx + (bridgeRecord.bYPx - bridgeRecord.aYPx) * t,
				2,
				255,
				40,
				40,
				0.9
			);
		}
	}
	// Truth tees, blue rings — the endpoints bridging is supposed to reach.
	for (const tee of truthTees) {
		for (let step = 0; step < 90; step += 1) {
			const angle = (2 * Math.PI * step) / 90;
			disc(tee.xPx + 9 * Math.cos(angle), tee.yPx + 9 * Math.sin(angle), 1, 40, 140, 255, 0.95);
		}
	}

	writeFileSync(outPath, PNG.sync.write(png));
	console.log(`  wrote ${outPath}`);
}

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
	const { radii, profile } = discoverRingRadii(gray, raster.widthPx, raster.heightPx, baskets);
	const strongest = [...profile].sort((a, b) => b.value - a.value).slice(0, 5);
	console.log(
		`ring radii discovered: [${radii.join(', ')}]px  (strongest profile points: ${strongest
			.map((p) => `${p.r}px:+${p.value.toFixed(1)}`)
			.join(' ')})`
	);

	const lines = extractLines(segmentation);
	console.log(`lines extracted: ${lines.length}`);
	for (const [index, line] of lines.entries()) {
		console.log(
			`  line #${index}: theta=${Math.round((line.thetaRad * 180) / Math.PI)}deg rho=${Math.round(line.rhoPx)}px span=${line.spanPx}px fill=${line.fill} support=${line.supportPx}px`
		);
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
	const holeNumbers = course.truth.map(([n]) => n);
	const before = topologyBuckets(placements, holeNumbers);

	const format = (c: typeof before.counts) =>
		`${c.exclusiveSameComponent} exclusive / ${c.sharedSameComponent} shared / ${c.split} split / ${c.noSeedHit} no-seed`;
	const keptBefore = recommendedKeptLabels(segmentation, placements);
	const recall = (kept: ReadonlySet<number>) => {
		let tee = 0;
		let basket = 0;
		for (const [, tx, ty, bx, by] of course.truth) {
			if (
				nearestKeptDistancePx(segmentation.labels, segmentation.widthEv, segmentation.heightEv, segmentation.scale, kept, tx, ty) <= 30
			)
				tee += 1;
			if (
				nearestKeptDistancePx(segmentation.labels, segmentation.widthEv, segmentation.heightEv, segmentation.scale, kept, bx, by) <= 30
			)
				basket += 1;
		}
		return { tee, basket };
	};
	const rb = recall(keptBefore);

	for (const ringRule of ['straddle', 'midpoint'] as const) {
		const { uf, bridges } = bridge(segmentation, baskets, radii, lines, ringRule);
		const after = topologyBuckets(mappedPlacements(placements, uf), holeNumbers);
		console.log(`\n--- ring rule: ${ringRule} (${bridges.length} bridges) ---`);
		for (const b of bridges) console.log(`  ${b.a} <-> ${b.b}  gap=${b.gapPx}px  via ${b.cause}`);

		// IMPORTANT framing: the "after" buckets treat bridged groups as single
		// components, which conflates two different questions. Bridging repairs
		// CONNECTIVITY (can the corridor be traversed badge->basket, does the
		// mask reach the tee); OWNERSHIP arbitration should keep operating on
		// the raw component graph, where the before-numbers are unchanged by
		// construction. Read "exclusive -> shared" transitions below as merge
		// pressure on the bridged graph, not as lost raw-graph exclusivity.
		console.log(`  bridged-graph buckets: ${format(before.counts)}  ->  ${format(after.counts)}`);
		for (const holeAfter of after.perHole) {
			const holeBefore = before.perHole.find((h) => h.holeNumber === holeAfter.holeNumber);
			if (holeBefore && holeBefore.bucket !== holeAfter.bucket)
				console.log(`    hole ${holeAfter.holeNumber}: ${holeBefore.bucket} -> ${holeAfter.bucket}`);
		}
		const connected = after.perHole.filter(
			(h) => h.badgeComponentLabel !== null && h.badgeComponentLabel === h.basketComponentLabel
		).length;
		console.log(`  badge<->basket bridged connectivity: ${connected}/18`);
		const keptAfter = new Set<number>();
		for (const geom of componentGeometry(segmentation).values()) {
			const root = uf.find(geom.label);
			if ([...keptBefore].some((k) => uf.find(k) === root)) keptAfter.add(geom.label);
		}
		const ra = recall(keptAfter);
		console.log(
			`  tee within 30px: ${rb.tee}/18 -> ${ra.tee}/18   basket within 30px: ${rb.basket}/18 -> ${ra.basket}/18`
		);

		if (process.argv.includes('--render') && ringRule === 'straddle') {
			renderBridges(
				raster,
				segmentation,
				keptAfter,
				baskets,
				radii,
				bridges,
				course.truth.map(([, tx, ty]) => ({ xPx: tx, yPx: ty })),
				join(process.cwd(), `scripts/cv-probes/ribbon-mass-results-ts/${course.name}-ring-bridge.png`)
			);
		}
	}
}
