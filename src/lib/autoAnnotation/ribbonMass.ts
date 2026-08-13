/**
 * Whole-course ribbon-mass segmentation and seed/component ownership — the
 * TypeScript port of the Phase-1/Phase-2 research probes
 * (`scripts/cv-probes/ribbon_mass_segmentation.py` /
 * `ribbon_mass_topology.py` on the `claude/grayt-ribbon-mass-ihcxiq` branch;
 * findings: `ribbon-mass-phase1-findings.md`, `ribbon-mass-topology-findings.md`).
 *
 * This module is a pure computation over a decoded raster: no DOM, no
 * worker, no persistence, no direct mutation of authoritative geometry. Most
 * consumers feed the instrumented attribution shadow path
 * (`ribbonMassShadowRun.ts`). Production basket ownership also reuses the raw
 * segmentation + seed placement for one deliberately narrow decision:
 * exclusive components may lock an already-detected basket to the only hole
 * whose badge touches that component. This module still never outputs a tee
 * and never arbitrates shared components.
 *
 * Faithfulness notes, relative to the Python probe:
 * - The evidence map is the same machinery as the research ray-walk stage:
 *   LANCZOS 1/3 downscale → LAB lightness → subtract a 41px box mean →
 *   clip(ΔL/10, 0, 1) → badge boxes pre-filled to 1.0 → 7×7 grey opening →
 *   threshold at 0.2 → 8-connected components.
 * - `recommendedMask = seed-connectivity OR texture` exactly as
 *   `build_masks`'s `recommended_mask`. Width/shape masks are research
 *   comparison arms, not part of the recommended candidate, and are not
 *   ported.
 * - Basket/pin *marker* detection (`find_basket_marker_centers`,
 *   `measure_marker_radius_px`) is visualization/reporting-only in the
 *   probe — it gates no mask — so it is deliberately not ported. Marker
 *   exclusion stays unresolved on purpose (see the probe's long comment):
 *   it is an ownership question Phase 2 hasn't solved.
 * - Float pipelines differ slightly from PIL/scipy (PIL rounds to uint8
 *   between resize passes; we keep floats), so masks are expected to match
 *   closely, not bit-exactly. `scripts/cv-probes/compare-ribbon-mass-port.ts`
 *   measures the actual agreement against the committed fixture numbers.
 */

export interface RibbonMassParams {
	/** Evidence-map downscale factor (`Stage1Params.scale`). */
	readonly scale: number;
	/** Box-mean window subtracted from LAB L, evidence-map px (`box_mean_window`). */
	readonly boxMeanWindow: number;
	/** Saturating divisor for the graded ray evidence (`ray_evidence_dl`). */
	readonly rayEvidenceDl: number;
	/** Grey-opening kernel size, evidence-map px (`open_size`). */
	readonly openSize: number;
	/** Binary threshold on the opened evidence (`evidence_thresh`). */
	readonly evidenceThresh: number;
	/** Component area floor (evidence-map px) for per-component records (`min_component_px`). */
	readonly minComponentPx: number;
	/** Per-component LAB L standard-deviation floor for the texture signal (`texture_lstd_min`). */
	readonly textureLstdMin: number;
	/** How far (source px) a seed may sit from the nearest component and still touch it (`seed_radius_px`). */
	readonly seedRadiusPx: number;
	/** Badge mask-box half extents, source px (`badge_half_w`/`badge_half_h`). */
	readonly badgeHalfWidthPx: number;
	readonly badgeHalfHeightPx: number;
}

/** Mirrors the research probe's defaults exactly (`RibbonMassParams` + the `Stage1Params` fields it reads). */
export const DEFAULT_RIBBON_MASS_PARAMS: RibbonMassParams = {
	scale: 3,
	boxMeanWindow: 41,
	rayEvidenceDl: 10,
	openSize: 7,
	evidenceThresh: 0.2,
	minComponentPx: 25,
	textureLstdMin: 12,
	seedRadiusPx: 40,
	badgeHalfWidthPx: 40,
	badgeHalfHeightPx: 30
};

export interface RibbonMassRaster {
	/** RGBA or RGB bytes, row-major. */
	readonly data: Uint8Array | Uint8ClampedArray;
	readonly widthPx: number;
	readonly heightPx: number;
	/** Bytes per pixel: 4 (canvas RGBA) or 3 (packed RGB). */
	readonly channels: 3 | 4;
}

/**
 * Directly measurable per-component facts, logged as facts — deliberately no
 * semantic "road"/"confuser"/"tee-marker-graphic" classification (none
 * exists; LAB texture is a statistic, not a classifier).
 */
export interface RibbonMassComponentRecord {
	readonly label: number;
	/** Evidence-map-scale pixel area. */
	readonly areaPx: number;
	/** Major/minor axis ratio from central moments (research comparison stat). */
	readonly elongation: number;
	/** Intra-component LAB L standard deviation. */
	readonly lStd: number;
	readonly centroidSrcPx: { readonly xPx: number; readonly yPx: number };
	readonly admittedByTexture: boolean;
}

export interface RibbonMassSegmentation {
	/** Evidence-map dimensions (source dims integer-divided by `params.scale`). */
	readonly widthEv: number;
	readonly heightEv: number;
	readonly scale: number;
	/** Connected-component labels, row-major, 0 = background. */
	readonly labels: Int32Array;
	/** Records for components with `areaPx >= minComponentPx`, in label order. */
	readonly components: readonly RibbonMassComponentRecord[];
	/** Labels of texture-admitted components (`lStd >= textureLstdMin`, area floor applied). */
	readonly textureKeptLabels: ReadonlySet<number>;
}

export type RibbonMassSeedKind = 'badge' | 'basket';

export interface RibbonMassSeed {
	readonly seedId: string;
	readonly kind: RibbonMassSeedKind;
	/** Null for a seed with no hole identity (it still grows the mask, it just owns nothing). */
	readonly holeNumber: number | null;
	readonly xPx: number;
	readonly yPx: number;
}

export interface RibbonMassSeedPlacement {
	readonly seedId: string;
	readonly kind: RibbonMassSeedKind;
	readonly holeNumber: number | null;
	/** Component the seed touches (direct hit or nearest within `seedRadiusPx`), or null. */
	readonly componentLabel: number | null;
}

export type RibbonMassTopologyBucket =
	| 'exclusiveSameComponent'
	| 'sharedSameComponent'
	| 'split'
	| 'noSeedHit';

export interface RibbonMassHoleTopology {
	readonly holeNumber: number;
	readonly bucket: RibbonMassTopologyBucket;
	readonly badgeComponentLabel: number | null;
	readonly basketComponentLabel: number | null;
}

export interface RibbonMassTopology {
	readonly perHole: readonly RibbonMassHoleTopology[];
	readonly counts: Readonly<Record<RibbonMassTopologyBucket, number>>;
	/** Components touched by more than one hole's seeds — the arbitration backlog, reported, not solved. */
	readonly sharedConflictComponents: readonly {
		readonly label: number;
		readonly holeNumbers: readonly number[];
	}[];
}

// ---------------------------------------------------------------------------
// Lanczos-3 downscale (PIL-compatible separable resampling; float precision,
// so values may differ from PIL's fixed-point path by <1/255 per channel).
// ---------------------------------------------------------------------------

function lanczos3(x: number): number {
	if (x <= -3 || x >= 3) return 0;
	if (x === 0) return 1;
	const pix = Math.PI * x;
	return (3 * Math.sin(pix) * Math.sin(pix / 3)) / (pix * pix);
}

interface ResampleTaps {
	readonly starts: Int32Array;
	readonly counts: Int32Array;
	readonly weights: Float64Array;
	readonly maxTaps: number;
}

function precomputeTaps(inSize: number, outSize: number): ResampleTaps {
	const ratio = inSize / outSize;
	const filterScale = Math.max(ratio, 1);
	const support = 3 * filterScale;
	const maxTaps = Math.ceil(support) * 2 + 1;
	const starts = new Int32Array(outSize);
	const counts = new Int32Array(outSize);
	const weights = new Float64Array(outSize * maxTaps);
	for (let out = 0; out < outSize; out += 1) {
		const center = (out + 0.5) * ratio;
		const min = Math.max(0, Math.floor(center - support));
		const max = Math.min(inSize, Math.ceil(center + support));
		let total = 0;
		for (let i = min; i < max; i += 1) {
			const w = lanczos3((i + 0.5 - center) / filterScale);
			weights[out * maxTaps + (i - min)] = w;
			total += w;
		}
		if (total !== 0) {
			for (let i = 0; i < max - min; i += 1) weights[out * maxTaps + i] /= total;
		}
		starts[out] = min;
		counts[out] = max - min;
	}
	return { starts, counts, weights, maxTaps };
}

/**
 * Downscale to (outW, outH), returning per-channel float RGB in 0..1.
 * Two-pass separable Lanczos-3, matching PIL's `resize(..., LANCZOS)`
 * geometry (`(out + 0.5) * ratio` centers, normalized clamped-support taps).
 */
function resizeLanczosRgb(
	raster: RibbonMassRaster,
	outW: number,
	outH: number
): { r: Float32Array; g: Float32Array; b: Float32Array } {
	const { data, widthPx: inW, heightPx: inH, channels } = raster;
	const hTaps = precomputeTaps(inW, outW);
	const vTaps = precomputeTaps(inH, outH);

	// Horizontal pass: (inH, outW) per channel.
	const midSize = inH * outW;
	const midR = new Float32Array(midSize);
	const midG = new Float32Array(midSize);
	const midB = new Float32Array(midSize);
	for (let y = 0; y < inH; y += 1) {
		const rowBase = y * inW * channels;
		for (let x = 0; x < outW; x += 1) {
			const start = hTaps.starts[x];
			const count = hTaps.counts[x];
			const wBase = x * hTaps.maxTaps;
			let r = 0;
			let g = 0;
			let b = 0;
			for (let k = 0; k < count; k += 1) {
				const w = hTaps.weights[wBase + k];
				const p = rowBase + (start + k) * channels;
				r += w * data[p];
				g += w * data[p + 1];
				b += w * data[p + 2];
			}
			const out = y * outW + x;
			midR[out] = r;
			midG[out] = g;
			midB[out] = b;
		}
	}

	// Vertical pass: (outH, outW) per channel, scaled to 0..1 and clamped
	// (PIL clamps to the uint8 range after each pass).
	const outSize = outH * outW;
	const r = new Float32Array(outSize);
	const g = new Float32Array(outSize);
	const b = new Float32Array(outSize);
	for (let y = 0; y < outH; y += 1) {
		const start = vTaps.starts[y];
		const count = vTaps.counts[y];
		const wBase = y * vTaps.maxTaps;
		for (let x = 0; x < outW; x += 1) {
			let sr = 0;
			let sg = 0;
			let sb = 0;
			for (let k = 0; k < count; k += 1) {
				const w = vTaps.weights[wBase + k];
				const p = (start + k) * outW + x;
				sr += w * midR[p];
				sg += w * midG[p];
				sb += w * midB[p];
			}
			const out = y * outW + x;
			r[out] = Math.min(255, Math.max(0, sr)) / 255;
			g[out] = Math.min(255, Math.max(0, sg)) / 255;
			b[out] = Math.min(255, Math.max(0, sb)) / 255;
		}
	}
	return { r, g, b };
}

// ---------------------------------------------------------------------------
// sRGB → LAB lightness (skimage rgb2lab, D65 / 2°).
// ---------------------------------------------------------------------------

function srgbToLinear(c: number): number {
	return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function labLightness(r: Float32Array, g: Float32Array, b: Float32Array): Float32Array {
	const n = r.length;
	const out = new Float32Array(n);
	const eps = 216 / 24389; // (6/29)^3
	const kappa = 24389 / 27;
	for (let i = 0; i < n; i += 1) {
		const rl = srgbToLinear(r[i]);
		const gl = srgbToLinear(g[i]);
		const bl = srgbToLinear(b[i]);
		// Y row of skimage's sRGB→XYZ matrix; Yn = 1.
		const y = 0.21267285140562253 * rl + 0.715152155287818 * gl + 0.07217499330655958 * bl;
		out[i] = y > eps ? 116 * Math.cbrt(y) - 16 : kappa * y;
	}
	return out;
}

// ---------------------------------------------------------------------------
// Reflect-padded separable filters (scipy default boundary mode 'reflect',
// i.e. the edge pixel is repeated: d c b a | a b c d | d c b a).
// ---------------------------------------------------------------------------

function reflectIndex(i: number, n: number): number {
	if (n === 1) return 0;
	let idx = i;
	while (idx < 0 || idx >= n) {
		if (idx < 0) idx = -1 - idx;
		else idx = 2 * n - 1 - idx;
	}
	return idx;
}

type LinePass = (line: Float32Array, out: Float32Array, n: number) => void;

/** Apply a 1-D pass along rows then columns of a (h, w) plane. */
function separable(plane: Float32Array, w: number, h: number, pass: LinePass): Float32Array {
	const afterRows = new Float32Array(plane.length);
	const lineIn = new Float32Array(Math.max(w, h));
	const lineOut = new Float32Array(Math.max(w, h));
	for (let y = 0; y < h; y += 1) {
		for (let x = 0; x < w; x += 1) lineIn[x] = plane[y * w + x];
		pass(lineIn, lineOut, w);
		for (let x = 0; x < w; x += 1) afterRows[y * w + x] = lineOut[x];
	}
	const out = new Float32Array(plane.length);
	for (let x = 0; x < w; x += 1) {
		for (let y = 0; y < h; y += 1) lineIn[y] = afterRows[y * w + x];
		pass(lineIn, lineOut, h);
		for (let y = 0; y < h; y += 1) out[y * w + x] = lineOut[y];
	}
	return out;
}

function boxMeanPass(size: number): LinePass {
	const left = Math.floor(size / 2);
	return (line, out, n) => {
		for (let i = 0; i < n; i += 1) {
			let sum = 0;
			for (let k = 0; k < size; k += 1) sum += line[reflectIndex(i - left + k, n)];
			out[i] = sum / size;
		}
	};
}

function extremumPass(size: number, sign: 1 | -1): LinePass {
	const left = Math.floor(size / 2);
	return (line, out, n) => {
		for (let i = 0; i < n; i += 1) {
			let best = sign * Infinity;
			for (let k = 0; k < size; k += 1) {
				const v = line[reflectIndex(i - left + k, n)];
				if (sign === 1 ? v < best : v > best) best = v;
			}
			out[i] = best;
		}
	};
}

/** scipy `uniform_filter(plane, size)` with reflect boundaries. */
export function boxMeanReflect(plane: Float32Array, w: number, h: number, size: number): Float32Array {
	return separable(plane, w, h, boxMeanPass(size));
}

/** scipy `grey_opening(plane, size=(size, size))`: erosion then dilation, reflect boundaries. */
export function greyOpeningReflect(
	plane: Float32Array,
	w: number,
	h: number,
	size: number
): Float32Array {
	const eroded = separable(plane, w, h, extremumPass(size, 1));
	return separable(eroded, w, h, extremumPass(size, -1));
}

// ---------------------------------------------------------------------------
// 8-connected component labeling (matches skimage `label`'s default
// connectivity for 2-D; label order follows raster-scan first encounter).
// ---------------------------------------------------------------------------

export function labelComponents(binary: Uint8Array, w: number, h: number): Int32Array {
	const labels = new Int32Array(binary.length);
	const stack: number[] = [];
	let next = 0;
	for (let i = 0; i < binary.length; i += 1) {
		if (binary[i] === 0 || labels[i] !== 0) continue;
		next += 1;
		labels[i] = next;
		stack.push(i);
		while (stack.length > 0) {
			const p = stack.pop() as number;
			const px = p % w;
			const py = (p - px) / w;
			for (let dy = -1; dy <= 1; dy += 1) {
				const ny = py + dy;
				if (ny < 0 || ny >= h) continue;
				for (let dx = -1; dx <= 1; dx += 1) {
					if (dx === 0 && dy === 0) continue;
					const nx = px + dx;
					if (nx < 0 || nx >= w) continue;
					const q = ny * w + nx;
					if (binary[q] !== 0 && labels[q] === 0) {
						labels[q] = next;
						stack.push(q);
					}
				}
			}
		}
	}
	return labels;
}

// ---------------------------------------------------------------------------
// Segmentation (the port of `build_masks`, minus the width/shape comparison
// arms and marker measurement — see the module doc comment).
// ---------------------------------------------------------------------------

export interface RibbonMassBadgeBox {
	readonly xPx: number;
	readonly yPx: number;
}

export function segmentRibbonMass(
	raster: RibbonMassRaster,
	badges: readonly RibbonMassBadgeBox[],
	params: RibbonMassParams = DEFAULT_RIBBON_MASS_PARAMS
): RibbonMassSegmentation {
	const w = Math.floor(raster.widthPx / params.scale);
	const h = Math.floor(raster.heightPx / params.scale);
	const { r, g, b } = resizeLanczosRgb(raster, w, h);
	const lightness = labLightness(r, g, b);

	// ΔL evidence: lightness minus its box mean, clipped through the graded divisor.
	const mean = boxMeanReflect(lightness, w, h, params.boxMeanWindow);
	const ev = new Float32Array(lightness.length);
	for (let i = 0; i < ev.length; i += 1) {
		ev[i] = Math.min(1, Math.max(0, (lightness[i] - mean[i]) / params.rayEvidenceDl));
	}

	// Badge boxes pre-filled to 1.0 before opening: the badge sits ON the
	// ribbon, so the fill lets the bright ribbon underneath win the erosion
	// instead of the glyph noise (same rationale as `opened_evidence`).
	for (const badge of badges) {
		const x0 = Math.max(0, Math.trunc((badge.xPx - params.badgeHalfWidthPx) / params.scale));
		const x1 = Math.min(w, Math.trunc((badge.xPx + params.badgeHalfWidthPx) / params.scale) + 1);
		const y0 = Math.max(0, Math.trunc((badge.yPx - params.badgeHalfHeightPx) / params.scale));
		const y1 = Math.min(h, Math.trunc((badge.yPx + params.badgeHalfHeightPx) / params.scale) + 1);
		for (let y = y0; y < y1; y += 1) {
			for (let x = x0; x < x1; x += 1) ev[y * w + x] = 1;
		}
	}

	const opened = greyOpeningReflect(ev, w, h, params.openSize);
	const binary = new Uint8Array(opened.length);
	for (let i = 0; i < binary.length; i += 1) binary[i] = opened[i] >= params.evidenceThresh ? 1 : 0;
	const labels = labelComponents(binary, w, h);

	// Per-component stats in one pass: area, centroid, second moments
	// (elongation), LAB L mean/variance (texture).
	let maxLabel = 0;
	for (let i = 0; i < labels.length; i += 1) if (labels[i] > maxLabel) maxLabel = labels[i];
	const area = new Float64Array(maxLabel + 1);
	const sumX = new Float64Array(maxLabel + 1);
	const sumY = new Float64Array(maxLabel + 1);
	const sumXX = new Float64Array(maxLabel + 1);
	const sumYY = new Float64Array(maxLabel + 1);
	const sumXY = new Float64Array(maxLabel + 1);
	const sumL = new Float64Array(maxLabel + 1);
	const sumLL = new Float64Array(maxLabel + 1);
	for (let y = 0; y < h; y += 1) {
		for (let x = 0; x < w; x += 1) {
			const lbl = labels[y * w + x];
			if (lbl === 0) continue;
			const lVal = lightness[y * w + x];
			area[lbl] += 1;
			sumX[lbl] += x;
			sumY[lbl] += y;
			sumXX[lbl] += x * x;
			sumYY[lbl] += y * y;
			sumXY[lbl] += x * y;
			sumL[lbl] += lVal;
			sumLL[lbl] += lVal * lVal;
		}
	}

	const components: RibbonMassComponentRecord[] = [];
	const textureKeptLabels = new Set<number>();
	for (let lbl = 1; lbl <= maxLabel; lbl += 1) {
		const a = area[lbl];
		if (a < params.minComponentPx) continue;
		const cx = sumX[lbl] / a;
		const cy = sumY[lbl] / a;
		// Central second moments per pixel; eigenvalues give skimage's
		// axis_major/minor_length = 4·√λ, so elongation = √(λ₊/λ₋).
		const mu20 = sumXX[lbl] / a - cx * cx;
		const mu02 = sumYY[lbl] / a - cy * cy;
		const mu11 = sumXY[lbl] / a - cx * cy;
		const half = (mu20 + mu02) / 2;
		const det = Math.sqrt(((mu20 - mu02) / 2) ** 2 + mu11 ** 2);
		const major = 4 * Math.sqrt(Math.max(0, half + det));
		const minor = Math.max(4 * Math.sqrt(Math.max(0, half - det)), 1e-6);
		const meanL = sumL[lbl] / a;
		const lStd = Math.sqrt(Math.max(0, sumLL[lbl] / a - meanL * meanL));
		const admittedByTexture = lStd >= params.textureLstdMin;
		if (admittedByTexture) textureKeptLabels.add(lbl);
		components.push({
			label: lbl,
			areaPx: a,
			elongation: major / minor,
			lStd,
			centroidSrcPx: { xPx: cx * params.scale, yPx: cy * params.scale },
			admittedByTexture
		});
	}

	return { widthEv: w, heightEv: h, scale: params.scale, labels, components, textureKeptLabels };
}

// ---------------------------------------------------------------------------
// Seed placement and ownership (ports of `nearest_component_label`,
// `seed_component_labels`, `seed_component_owners`, `topology_buckets`).
// ---------------------------------------------------------------------------

/**
 * Component label at a source-px coordinate: direct hit when the point lands
 * on evidence, else the nearest labeled pixel within `searchRadiusPx`
 * (source px), else null. Nearest ties resolve to the first minimum in
 * row-major order, matching the probe's `np.nonzero`/`argmin` behavior.
 */
export function nearestComponentLabel(
	labels: Int32Array,
	widthEv: number,
	heightEv: number,
	scale: number,
	xSrcPx: number,
	ySrcPx: number,
	searchRadiusPx: number
): number | null {
	const xi = Math.trunc(xSrcPx / scale);
	const yi = Math.trunc(ySrcPx / scale);
	if (xi < 0 || xi >= widthEv || yi < 0 || yi >= heightEv) return null;
	const direct = labels[yi * widthEv + xi];
	if (direct !== 0) return direct;
	if (searchRadiusPx <= 0) return null;
	const r = Math.max(1, Math.round(searchRadiusPx / scale));
	const y0 = Math.max(0, yi - r);
	const y1 = Math.min(heightEv, yi + r + 1);
	const x0 = Math.max(0, xi - r);
	const x1 = Math.min(widthEv, xi + r + 1);
	let best = -1;
	let bestD2 = Infinity;
	for (let y = y0; y < y1; y += 1) {
		for (let x = x0; x < x1; x += 1) {
			const lbl = labels[y * widthEv + x];
			if (lbl === 0) continue;
			const d2 = (x - xi) ** 2 + (y - yi) ** 2;
			if (d2 < bestD2) {
				bestD2 = d2;
				best = lbl;
			}
		}
	}
	return best === -1 ? null : best;
}

export function placeSeeds(
	segmentation: Pick<RibbonMassSegmentation, 'labels' | 'widthEv' | 'heightEv' | 'scale'>,
	seeds: readonly RibbonMassSeed[],
	seedRadiusPx: number
): RibbonMassSeedPlacement[] {
	return seeds.map((seed) => ({
		seedId: seed.seedId,
		kind: seed.kind,
		holeNumber: seed.holeNumber,
		componentLabel: nearestComponentLabel(
			segmentation.labels,
			segmentation.widthEv,
			segmentation.heightEv,
			segmentation.scale,
			seed.xPx,
			seed.yPx,
			seedRadiusPx
		)
	}));
}

/**
 * The corrected four-way taxonomy from `topology_buckets` — four buckets,
 * NOT three: `exclusiveSameComponent` (badge and own basket share a
 * component nothing else touches — the only bucket with an unambiguous
 * component owner, which still says nothing about where the tee is) is
 * deliberately distinct from `sharedSameComponent` (connectivity without
 * ownership; needs arbitration). An earlier research draft conflated them;
 * that bug is fixed and must not be reintroduced here.
 */
export function topologyBuckets(
	placements: readonly RibbonMassSeedPlacement[],
	holeNumbers: readonly number[]
): RibbonMassTopology {
	const badgeLabel = new Map<number, number>();
	const basketLabel = new Map<number, number>();
	const holesByComponent = new Map<number, Set<number>>();
	for (const placement of placements) {
		if (placement.componentLabel === null || placement.holeNumber === null) continue;
		const byKind = placement.kind === 'badge' ? badgeLabel : basketLabel;
		byKind.set(placement.holeNumber, placement.componentLabel);
		let holeSet = holesByComponent.get(placement.componentLabel);
		if (!holeSet) {
			holeSet = new Set<number>();
			holesByComponent.set(placement.componentLabel, holeSet);
		}
		holeSet.add(placement.holeNumber);
	}
	const sharedConflictLabels = new Set<number>();
	for (const [label, holeSet] of holesByComponent) {
		if (holeSet.size > 1) sharedConflictLabels.add(label);
	}

	const perHole: RibbonMassHoleTopology[] = [];
	const counts: Record<RibbonMassTopologyBucket, number> = {
		exclusiveSameComponent: 0,
		sharedSameComponent: 0,
		split: 0,
		noSeedHit: 0
	};
	for (const holeNumber of holeNumbers) {
		const badge = badgeLabel.get(holeNumber) ?? null;
		const basket = basketLabel.get(holeNumber) ?? null;
		let bucket: RibbonMassTopologyBucket;
		if (badge === null || basket === null) bucket = 'noSeedHit';
		else if (badge !== basket) bucket = 'split';
		else if (sharedConflictLabels.has(badge)) bucket = 'sharedSameComponent';
		else bucket = 'exclusiveSameComponent';
		counts[bucket] += 1;
		perHole.push({ holeNumber, bucket, badgeComponentLabel: badge, basketComponentLabel: basket });
	}

	return {
		perHole,
		counts,
		sharedConflictComponents: [...sharedConflictLabels]
			.sort((a, b) => a - b)
			.map((label) => ({
				label,
				holeNumbers: [...(holesByComponent.get(label) ?? [])].sort((a, b) => a - b)
			}))
	};
}

/**
 * Labels of the recommended candidate mask for a given seed set:
 * seed-connectivity OR texture (`recommended_mask = seed_mask | texture_mask`).
 * Union, not intersection — intersection was tried in the research phase and
 * measurably hurt basket recall.
 */
export function recommendedKeptLabels(
	segmentation: Pick<RibbonMassSegmentation, 'textureKeptLabels'>,
	placements: readonly RibbonMassSeedPlacement[]
): Set<number> {
	const kept = new Set<number>(segmentation.textureKeptLabels);
	for (const placement of placements) {
		if (placement.componentLabel !== null) kept.add(placement.componentLabel);
	}
	return kept;
}

/** Total evidence-map-px area of a kept-label set. */
export function keptAreaPx(labels: Int32Array, kept: ReadonlySet<number>): number {
	let total = 0;
	for (let i = 0; i < labels.length; i += 1) if (kept.has(labels[i])) total += 1;
	return total;
}

/**
 * Nearest distance (source px) from a source coordinate to any pixel whose
 * label is in `kept` — the endpoint-coverage metric from the research
 * probes' `nearest_dist_src`, restricted to a kept-label set. Infinity when
 * the kept mask is empty.
 */
export function nearestKeptDistancePx(
	labels: Int32Array,
	widthEv: number,
	heightEv: number,
	scale: number,
	kept: ReadonlySet<number>,
	xSrcPx: number,
	ySrcPx: number
): number {
	const xi = Math.min(Math.max(Math.round(xSrcPx / scale), 0), widthEv - 1);
	const yi = Math.min(Math.max(Math.round(ySrcPx / scale), 0), heightEv - 1);
	let bestD2 = Infinity;
	for (let y = 0; y < heightEv; y += 1) {
		const dy = y - yi;
		if (dy * dy >= bestD2) continue;
		for (let x = 0; x < widthEv; x += 1) {
			const lbl = labels[y * widthEv + x];
			if (lbl === 0 || !kept.has(lbl)) continue;
			const dx = x - xi;
			const d2 = dx * dx + dy * dy;
			if (d2 < bestD2) bestD2 = d2;
		}
	}
	return bestD2 === Infinity ? Infinity : Math.sqrt(bestD2) * scale;
}
