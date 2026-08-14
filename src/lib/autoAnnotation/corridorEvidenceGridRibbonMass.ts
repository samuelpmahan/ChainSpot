/**
 * Builds a per-hole `CorridorEvidenceGrid` (see `corridorEvidenceGrid.ts`)
 * from this branch's ribbon-mass research substrate
 * (`ribbonMass.ts`/`segmentRibbonMass`), plus the two follow-on findings
 * documented in `scripts/cv-probes/`:
 *
 * - `occluder-bridge-spike.ts` (v2): a UI glyph occluding a few pixels can
 *   punch a stroke-scale hole in an otherwise continuous ribbon. The
 *   validated repair grows a bounded wavefront (few px, never more than
 *   `maxBridgeGapPx`) through a predicted occluder band, and does NOT use a
 *   global union-find — that was v1, and v1 was falsified (see that file's
 *   module doc: it collapsed to permissive long-distance merging and its
 *   apparent recall win was contaminated by transitive kept-promotion of an
 *   unrelated island). `bridgeGapsWithinRingBand` below re-applies the same
 *   local, bounded mechanism, scoped even tighter than the spike: every
 *   wavefront source here is already restricted to THIS hole's own
 *   `kept` label set (see `isolateToHole` below), so a bad bridge cannot
 *   pull in a foreign component at all — the isolation step upstream makes
 *   v1's exact failure mode structurally impossible here, not just
 *   unlikely.
 * - `ring-arc-spike.ts`: split-hole gaps cluster near a small number of
 *   basket-centered radii — the C1/C2 rings UDisc renders around EVERY
 *   basket, including a hole's own — and ownership does not exempt a ring
 *   from tearing its own hole's corridor (14/15 measured split gaps were
 *   the hole's OWN ring, not a neighbor's). `discoverBasketRingRadiiPx`
 *   below re-derives those radii from real pixels (never hardcoded — the
 *   two committed fixtures already disagree by ~4x: [20,44,62,88]px vs
 *   [12,68]px, matching the capture-zoom variance both spikes call out),
 *   and `buildModernCorridorEvidence` uses them for two things: damping
 *   ring-band evidence down (so a ring doesn't read as strongly as the true
 *   ribbon to a downstream path search) and scoping where local bridging is
 *   even allowed to run (only inside a predicted occluder band, never on
 *   open terrain).
 *
 * This module produces evidence ONLY. It does not search for, fit, or score
 * a bend — that is the sibling capsule-region-scoring engine's job, and it
 * is deliberately not implemented, imported, or anticipated here beyond the
 * shared `CorridorEvidenceGrid` output contract.
 */
import type { SourcePoint } from '../domain/annotatedRound';
import type { CorridorEvidenceGrid } from './corridorEvidenceGrid';
import { DEFAULT_RIBBON_MASS_PARAMS, placeSeeds } from './ribbonMass';
import type { RibbonMassRaster, RibbonMassSeed, RibbonMassSegmentation } from './ribbonMass';

/**
 * The slice of `RibbonMassSegmentation` this module actually reads — mirrors
 * `RibbonMassSegmentationForBends` in `corridorBendDetectionRibbonMass.ts`
 * (same rationale: lets tests build a segmentation by hand instead of
 * running the full LANCZOS/box-mean/opening pipeline). `evidence` is
 * `RibbonMassSegmentation`'s own field but made non-optional here (via
 * intersection, not `Pick`, since `Pick` would carry the `?` through) — that
 * graded signal is this module's whole point, and `segmentRibbonMass`
 * always populates it; only a hand-reassembled segmentation that skipped it
 * (e.g. `ribbonMassShadow.ts`'s worker-reply roundtrip, which never sends it
 * over the wire) would fail to satisfy this narrower type, and none of
 * those flow into this module.
 */
export type RibbonMassSegmentationForEvidence = Pick<
	RibbonMassSegmentation,
	'labels' | 'widthEv' | 'heightEv' | 'scale' | 'textureKeptLabels'
> & { readonly evidence: Float32Array };

// ---------------------------------------------------------------------------
// Ring-radius discovery — a per-COURSE computation (needs every basket
// position for a stable profile), ported from
// `scripts/cv-probes/occluder-bridge-spike.ts`'s `discoverRingRadii`. Call
// once per course and reuse the result across every hole's
// `buildModernCorridorEvidence` call, the same way `segmentRibbonMass`
// itself is computed once per course and reused per hole.
// ---------------------------------------------------------------------------

export interface RingRadiusDiscoveryParams {
	readonly rMinPx: number;
	readonly rMaxPx: number;
	readonly rStepPx: number;
	readonly angleSamples: number;
	/** Minimum baseline-relative brightness bump (0-255 scale) for a local max to count as a ring. */
	readonly minBumpValue: number;
	/** Local maxima closer than this (px) to an already-accepted radius are merged into it. */
	readonly minRadiusSeparationPx: number;
	/** Local-maximum search half-window, in radius-profile BINS (matches the spike's fixed +/-4-bin window). */
	readonly peakHalfWindowBins: number;
}

/** Verbatim numeric defaults from `occluder-bridge-spike.ts`'s `discoverRingRadii` (R_MIN/R_MAX/R_STEP/N_ANGLES and its peak-finding constants). */
export const DEFAULT_RING_RADIUS_DISCOVERY_PARAMS: RingRadiusDiscoveryParams = {
	rMinPx: 10,
	rMaxPx: 140,
	rStepPx: 2,
	angleSamples: 144,
	minBumpValue: 2,
	minRadiusSeparationPx: 16,
	peakHalfWindowBins: 4
};

function courseGrayscale(raster: RibbonMassRaster): Float32Array {
	const { data, widthPx, heightPx, channels } = raster;
	const out = new Float32Array(widthPx * heightPx);
	for (let i = 0, p = 0; i < out.length; i += 1, p += channels) {
		out[i] = (data[p] + data[p + 1] + data[p + 2]) / 3;
	}
	return out;
}

/**
 * Per-course C1/C2 ring-radius discovery: median radial brightness profile
 * around basket positions (baseline-subtracted per basket first, so courses
 * with different average terrain brightness aren't compared on a raw
 * scale), then local-maximum peak-finding on the cross-basket median — the
 * same mechanism `ring-arc-spike.ts` relied on to show split-hole gaps
 * cluster at these radii. Deliberately measured, never assumed: this
 * branch's own two fixtures already disagree by roughly 4x ([20,44,62,88]px
 * vs [12,68]px), matching both spikes' "capture zoom varies per course"
 * warning. Works with a single basket (the median of one value is just that
 * value) but is noisier that way — prefer passing every basket on the
 * course when available.
 */
export function discoverBasketRingRadiiPx(
	raster: RibbonMassRaster,
	basketsSrcPx: readonly SourcePoint[],
	params: RingRadiusDiscoveryParams = DEFAULT_RING_RADIUS_DISCOVERY_PARAMS
): number[] {
	if (basketsSrcPx.length === 0) return [];
	const gray = courseGrayscale(raster);
	const { widthPx, heightPx } = raster;
	const angles = Array.from({ length: params.angleSamples }, (_, i) => (2 * Math.PI * i) / params.angleSamples);
	const nBins = Math.floor((params.rMaxPx - params.rMinPx) / params.rStepPx) + 1;

	const perBasket: number[][] = [];
	for (const basket of basketsSrcPx) {
		const profile: number[] = [];
		for (let bin = 0; bin < nBins; bin += 1) {
			const r = params.rMinPx + bin * params.rStepPx;
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

	const medianProfile: number[] = [];
	for (let bin = 0; bin < nBins; bin += 1) {
		const values = perBasket.map((p) => p[bin]).sort((a, b) => a - b);
		medianProfile.push(values[Math.floor(values.length / 2)]);
	}

	const radii: number[] = [];
	for (let bin = 0; bin < nBins; bin += 1) {
		const v = medianProfile[bin];
		if (v < params.minBumpValue) continue;
		let isMax = true;
		for (
			let k = Math.max(0, bin - params.peakHalfWindowBins);
			k <= Math.min(nBins - 1, bin + params.peakHalfWindowBins);
			k += 1
		) {
			if (medianProfile[k] > v) isMax = false;
		}
		const rPx = params.rMinPx + bin * params.rStepPx;
		if (isMax && !radii.some((r) => Math.abs(r - rPx) < params.minRadiusSeparationPx)) radii.push(rPx);
	}
	return radii.sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Per-hole evidence grid
// ---------------------------------------------------------------------------

export interface CorridorEvidenceGridParams {
	/** Source px radius `placeSeeds` may search for a nearby component when tee/badge/basket doesn't land directly on one. */
	readonly seedRadiusPx: number;
	readonly marginFraction: number;
	readonly minMarginPx: number;
	readonly maxMarginPx: number;
	/** Half-width of a ring-radius annulus, source px — matches `occluder-bridge-spike.ts`'s validated `BAND_HALF_WIDTH_PX` (stroke + opening erosion scale, NOT radius scale). */
	readonly ringBandHalfWidthPx: number;
	/** Evidence inside a ring band is multiplied by this (kept AND sub-threshold cells alike) so a C1/C2 ring never reads as strongly as clean ribbon evidence. */
	readonly ringDampingFactor: number;
	/** Max total gap a local bridge repair may close, source px — matches `occluder-bridge-spike.ts`'s validated `MAX_CLOSE_PX` (stroke scale; a v1-style 40-90px cap is exactly what got falsified). */
	readonly maxBridgeGapPx: number;
	/** Evidence value written into a successfully bridged gap span (a floor via `Math.max`, never overwriting a stronger nearby value). Deliberately below a confident ribbon read (>= `evidenceThresh`), signaling "locally repaired, moderate confidence" rather than a hard connectivity claim. */
	readonly bridgeEvidenceFloor: number;
}

/** Numeric values mirror `DEFAULT_RIBBON_MASS_CORRIDOR_BEND_PARAMS`'s window-sizing constants (so a window this module crops matches the one `corridorBendDetectionRibbonMass.ts` crops) plus the validated occluder-bridge-spike v2 constants. */
export const DEFAULT_CORRIDOR_EVIDENCE_GRID_PARAMS: CorridorEvidenceGridParams = {
	seedRadiusPx: DEFAULT_RIBBON_MASS_PARAMS.seedRadiusPx,
	marginFraction: 0.4,
	minMarginPx: 40,
	maxMarginPx: 260,
	ringBandHalfWidthPx: 12,
	ringDampingFactor: 0.35,
	maxBridgeGapPx: 18,
	bridgeEvidenceFloor: 0.5
};

/**
 * Plants `teeSrcPx` and (if given) `badgeSrcPx` as `'badge'`-kind seeds and
 * `basketSrcPx` as a `'basket'`-kind seed — the same seed vocabulary
 * `corridorBendDetectionRibbonMass.ts`'s `keptLabelsForHole` and
 * `ribbonMassShadowRun.ts` plant from real tee/badge/basket detections
 * (`holeNumber` is arbitrary since only one hole is ever being asked
 * about) — and returns the SEED-CONNECTED label set for this hole only.
 *
 * Deliberately NOT `recommendedKeptLabels` (seed-connectivity UNION
 * whole-course texture admission), even though that is the pattern
 * `corridorBendDetectionRibbonMass.ts` uses and this module started from:
 * rendering real holes (`corridor-evidence-grid-spike.ts`) surfaced that
 * `textureKeptLabels` is, by `ribbonMass.ts`'s own doc comment, "whole-course,
 * anchor-independent" — and empirically, EVERY badge box on Dash's Track
 * passes that admission test (high local LAB-L contrast from the black
 * badge glyph against its white digit/surrounding terrain), so the union
 * pulls in all 18 badges' components for every single hole, not just this
 * hole's own. That is a fine, even desirable, whole-course recall net for
 * `ribbonMassShadowRun`'s instrumentation purposes; it directly breaks this
 * module's isolation contract (rendered as solid, undamped, full-alpha
 * neighbor badge boxes bleeding into a hole's own evidence window). Kept
 * here to ONLY what this hole's own seeds actually touch.
 */
function keptLabelsForHole(
	segmentation: RibbonMassSegmentationForEvidence,
	teeSrcPx: SourcePoint,
	basketSrcPx: SourcePoint,
	badgeSrcPx: SourcePoint | undefined,
	seedRadiusPx: number
): Set<number> {
	const seeds: RibbonMassSeed[] = [
		{ seedId: 'tee', kind: 'badge', holeNumber: 0, xPx: teeSrcPx.xPx, yPx: teeSrcPx.yPx },
		{ seedId: 'basket', kind: 'basket', holeNumber: 0, xPx: basketSrcPx.xPx, yPx: basketSrcPx.yPx },
		...(badgeSrcPx
			? [{ seedId: 'badge', kind: 'badge' as const, holeNumber: 0, xPx: badgeSrcPx.xPx, yPx: badgeSrcPx.yPx }]
			: [])
	];
	const placements = placeSeeds(segmentation, seeds, seedRadiusPx);
	const kept = new Set<number>();
	for (const placement of placements) {
		if (placement.componentLabel !== null) kept.add(placement.componentLabel);
	}
	return kept;
}

interface CropWindow {
	readonly x0: number;
	readonly y0: number;
	readonly width: number;
	readonly height: number;
}

/** Evidence-map-cell crop bounds covering tee/basket/badge with margin — same margin geometry `cropRibbonMassOpenWindow` uses, extended to include the badge point (if given) in the bounding box. */
function computeCropWindow(
	segmentation: Pick<RibbonMassSegmentationForEvidence, 'widthEv' | 'heightEv' | 'scale'>,
	teeSrcPx: SourcePoint,
	basketSrcPx: SourcePoint,
	badgeSrcPx: SourcePoint | undefined,
	params: CorridorEvidenceGridParams
): CropWindow | null {
	const { widthEv, heightEv, scale } = segmentation;
	const points = [teeSrcPx, basketSrcPx, ...(badgeSrcPx ? [badgeSrcPx] : [])];
	const distance = Math.hypot(basketSrcPx.xPx - teeSrcPx.xPx, basketSrcPx.yPx - teeSrcPx.yPx);
	const margin = Math.min(params.maxMarginPx, Math.max(params.minMarginPx, distance * params.marginFraction));
	const x0Src = Math.min(...points.map((p) => p.xPx)) - margin;
	const y0Src = Math.min(...points.map((p) => p.yPx)) - margin;
	const x1Src = Math.max(...points.map((p) => p.xPx)) + margin;
	const y1Src = Math.max(...points.map((p) => p.yPx)) + margin;

	const x0 = Math.max(0, Math.floor(x0Src / scale));
	const y0 = Math.max(0, Math.floor(y0Src / scale));
	const x1 = Math.min(widthEv, Math.ceil(x1Src / scale));
	const y1 = Math.min(heightEv, Math.ceil(y1Src / scale));
	const width = x1 - x0;
	const height = y1 - y0;
	if (width < 2 || height < 2) return null;
	return { x0, y0, width, height };
}

/**
 * Crops `segmentation.evidence` to `window` and isolates it to THIS hole:
 * a cell whose label is a DIFFERENT, confidently-thresholded component (a
 * neighbor hole's ribbon, an un-owned C1/C2 ring blob nothing here seeded —
 * the actual leakage this step exists to stop) is zeroed. A cell with no
 * label at all keeps its real graded sub-threshold value rather than being
 * forced to 0 — it was never confidently attributed to anything, so
 * flattening it would just re-binarize this module's whole reason for
 * existing (a continuous evidence signal, not another mask). `gridLabel`
 * (returned alongside) carries ONLY kept labels — the set allowed to seed
 * local bridge repair below, so a bridge source can never be a foreign
 * component.
 */
function isolateToHole(
	segmentation: RibbonMassSegmentationForEvidence,
	kept: ReadonlySet<number>,
	window: CropWindow
): { grid: Float32Array; gridLabel: Int32Array } {
	const { labels, widthEv, evidence } = segmentation;
	const { x0, y0, width, height } = window;
	const grid = new Float32Array(width * height);
	const gridLabel = new Int32Array(width * height);
	for (let y = 0; y < height; y += 1) {
		const rowBase = (y0 + y) * widthEv;
		for (let x = 0; x < width; x += 1) {
			const srcIdx = rowBase + x0 + x;
			const label = labels[srcIdx];
			const dstIdx = y * width + x;
			if (label !== 0 && !kept.has(label)) continue; // leaked-in foreign component: stays 0
			grid[dstIdx] = evidence[srcIdx];
			if (label !== 0) gridLabel[dstIdx] = label;
		}
	}
	return { grid, gridLabel };
}

/** True where a (local-window) cell sits within `ringBandHalfWidthPx` of any discovered ring radius around `basketLocal`. */
function buildRingBandMask(
	width: number,
	height: number,
	scale: number,
	basketLocalX: number,
	basketLocalY: number,
	ringRadiiPx: readonly number[],
	ringBandHalfWidthPx: number
): Uint8Array {
	const band = new Uint8Array(width * height);
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const dPx = Math.hypot(x - basketLocalX, y - basketLocalY) * scale;
			for (const r of ringRadiiPx) {
				if (Math.abs(dPx - r) <= ringBandHalfWidthPx) {
					band[y * width + x] = 1;
					break;
				}
			}
		}
	}
	return band;
}

/**
 * Local, bounded-gap repair through this hole's own predicted occluder band
 * — `occluder-bridge-spike.ts`'s validated v2 mechanism (multi-source
 * wavefront growth through non-evidence pixels, inside the band only, up to
 * `maxBridgeGapPx` total), re-scoped two ways beyond that spike: (1) every
 * wavefront source is already restricted to `gridLabel`'s kept-only values
 * (see `isolateToHole`), so there is no possibility of the v1 failure mode
 * (a bad bridge pulling in a foreign, un-owned island via transitive
 * merging) — the isolation step upstream makes that structurally
 * impossible here, not merely unlikely; and (2) a successful meeting is
 * recorded as GRADED evidence (a small disc around the actual meeting
 * point, floored at `bridgeEvidenceFloor` via `Math.max`, never a full
 * hole-punch to 1.0), matching this module's soft-evidence contract instead
 * of the spike's binary connectivity claim. No global union-find; nothing
 * outside the band ever grows; a meeting can only ever be between two of
 * THIS hole's own kept components.
 */
function bridgeGapsWithinBand(
	grid: Float32Array,
	gridLabel: Int32Array,
	width: number,
	height: number,
	scale: number,
	band: Uint8Array,
	params: CorridorEvidenceGridParams
): void {
	const n = width * height;
	const isGapCell = (idx: number) => gridLabel[idx] === 0 && band[idx] === 1;
	const owner = new Int32Array(n);
	const dist = new Int32Array(n).fill(-1);
	let frontier: number[] = [];
	const meetings: { x: number; y: number; gapPx: number }[] = [];

	const considerMeeting = (x: number, y: number, ownerA: number, ownerB: number, gapSteps: number) => {
		if (ownerA === ownerB) return;
		meetings.push({ x, y, gapPx: gapSteps * scale });
	};

	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const i = y * width + x;
			if (!isGapCell(i)) continue;
			for (let dy = -1; dy <= 1; dy += 1) {
				for (let dx = -1; dx <= 1; dx += 1) {
					if (dx === 0 && dy === 0) continue;
					const nx = x + dx;
					const ny = y + dy;
					if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
					const neighborLabel = gridLabel[ny * width + nx];
					if (neighborLabel === 0) continue;
					if (dist[i] === -1) {
						dist[i] = 1;
						owner[i] = neighborLabel;
						frontier.push(i);
					} else if (owner[i] !== neighborLabel) {
						considerMeeting(x, y, owner[i], neighborLabel, dist[i]);
					}
				}
			}
		}
	}

	const maxSteps = Math.max(1, Math.ceil(params.maxBridgeGapPx / scale));
	for (let step = 2; step <= maxSteps && frontier.length > 0; step += 1) {
		const next: number[] = [];
		for (const i of frontier) {
			const x = i % width;
			const y = (i - x) / width;
			for (let dy = -1; dy <= 1; dy += 1) {
				for (let dx = -1; dx <= 1; dx += 1) {
					if (dx === 0 && dy === 0) continue;
					const nx = x + dx;
					const ny = y + dy;
					if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
					const j = ny * width + nx;
					if (!isGapCell(j)) continue;
					if (dist[j] === -1) {
						dist[j] = step;
						owner[j] = owner[i];
						next.push(j);
					} else if (owner[j] !== owner[i]) {
						considerMeeting(nx, ny, owner[i], owner[j], dist[i] + dist[j]);
					}
				}
			}
		}
		frontier = next;
	}

	for (const meeting of meetings) {
		if (meeting.gapPx > params.maxBridgeGapPx) continue;
		const radiusEv = Math.max(1, meeting.gapPx / scale / 2);
		const x0 = Math.max(0, Math.floor(meeting.x - radiusEv));
		const x1 = Math.min(width - 1, Math.ceil(meeting.x + radiusEv));
		const y0 = Math.max(0, Math.floor(meeting.y - radiusEv));
		const y1 = Math.min(height - 1, Math.ceil(meeting.y + radiusEv));
		for (let y = y0; y <= y1; y += 1) {
			for (let x = x0; x <= x1; x += 1) {
				const dx = x - meeting.x;
				const dy = y - meeting.y;
				if (dx * dx + dy * dy > radiusEv * radiusEv) continue;
				const idx = y * width + x;
				grid[idx] = Math.max(grid[idx], params.bridgeEvidenceFloor);
			}
		}
	}
}

/**
 * Builds a `CorridorEvidenceGrid` for one hole from an already-computed
 * whole-course `segmentation` (`segmentRibbonMass`, once per course — this
 * function never re-runs it, same cost split `corridorBendDetectionRibbonMass.ts`
 * documents). `ringRadiiPx` should be `discoverBasketRingRadiiPx`'s output
 * for this course (or `[]` to skip ring damping/bridging entirely — safe,
 * just more conservative). Returns null when the tee/basket/badge geometry
 * produces a degenerate crop window (mirrors `cropRibbonMassOpenWindow`'s
 * own guard).
 */
export function buildModernCorridorEvidence(
	segmentation: RibbonMassSegmentationForEvidence,
	teeSrcPx: SourcePoint,
	basketSrcPx: SourcePoint,
	badgeSrcPx: SourcePoint | undefined,
	ringRadiiPx: readonly number[] = [],
	params: CorridorEvidenceGridParams = DEFAULT_CORRIDOR_EVIDENCE_GRID_PARAMS
): CorridorEvidenceGrid | null {
	const window = computeCropWindow(segmentation, teeSrcPx, basketSrcPx, badgeSrcPx, params);
	if (!window) return null;

	const kept = keptLabelsForHole(segmentation, teeSrcPx, basketSrcPx, badgeSrcPx, params.seedRadiusPx);
	const { grid, gridLabel } = isolateToHole(segmentation, kept, window);

	if (ringRadiiPx.length > 0) {
		const { x0, y0, width, height } = window;
		const { scale } = segmentation;
		const basketLocalX = basketSrcPx.xPx / scale - x0;
		const basketLocalY = basketSrcPx.yPx / scale - y0;
		const band = buildRingBandMask(
			width,
			height,
			scale,
			basketLocalX,
			basketLocalY,
			ringRadiiPx,
			params.ringBandHalfWidthPx
		);
		for (let i = 0; i < grid.length; i += 1) {
			if (band[i] === 1) grid[i] *= params.ringDampingFactor;
		}
		bridgeGapsWithinBand(grid, gridLabel, width, height, scale, band, params);
	}

	return {
		widthPx: window.width,
		heightPx: window.height,
		originXPx: window.x0 * segmentation.scale,
		originYPx: window.y0 * segmentation.scale,
		scale: segmentation.scale,
		evidence: grid
	};
}
