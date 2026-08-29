/**
 * Pure math for the G4 teeBorderCornerFit deviation: recover a tee whose pad
 * is buried under a basket glyph from the one wall remnant that pokes out
 * past the glyph's black border.
 *
 * Owner directives (2026-08-29, verbatim intent):
 *  - "Make recovery search for ANY white component connected to the baskets
 *    black border for tee recovery candidates."
 *  - "the crumbs arent part of it. that 21 px CORNER should work."
 *
 * Manually validated on Heritage T6 before this module was written: the 21px
 * corner remnant (3x7 @ [733,891], glued to the basket glyph's black border)
 * anchors the course-median pad (17x12, from 14 visible pads) to center
 * (738.5, 899.0) -- 1.0px from the truth annotation -- with zero bare
 * contradictions; orientation disambiguated by the hole-6 badge bearing
 * (6.9deg vertical vs 83.1deg horizontal).
 *
 * Model, in the order the receipt prints it:
 *  1. Pad size is COURSE-MEASURED: lower medians of this course's own visible
 *     pads (majorPx/minorPx), wall thickness = median area / perimeter.
 *     Too few pads => loud fallback, no fitting (footgun law: never invent a
 *     size).
 *  2. Discovery is the owner's border-adjacency rule: an unowned bright
 *     component with a pixel 8-adjacent to basket ink near a basket's bbox.
 *     The basket glyph's own WHITE FILL is bright too and is NEVER a
 *     candidate and NEVER pad evidence -- treating it as evidence is exactly
 *     the trap the manual run caught (a 27x23 "pad" fit happily inside the
 *     glyph's own white interior).
 *  3. The fit has ZERO angular freedom and ZERO center freedom beyond an
 *     integer slide: the remnant IS part of the pad's wall band, so the pad
 *     rectangle is anchored to the remnant's bbox faces and slid along the
 *     wall. Every outline pixel is classified: evidence (bright, not glyph
 *     fill), occluded (ink or glyph fill -- the NAMED occluder), transition
 *     (anti-alias halo), or BARE (contradiction). A placement with any hard
 *     contradiction is never accepted; a candidate with no contradiction-free
 *     placement is a NAMED abstention, never a guess.
 *  4. Orientation ties (everything east of a corner can be under the glyph)
 *     are broken by the compass rule: the pad's long axis should aim at a
 *     badge (S2 -- the tee is the compass).
 */

export interface BorderFitMasks {
	readonly width: number;
	readonly height: number;
	/** bright/dark mask bytes, mask-local frame (1 = set). */
	readonly bright: Uint8Array;
	readonly dark: Uint8Array;
	/** Connected-component labels over `bright` (0 = unlabeled). */
	readonly brightLabels: Int32Array;
}

export interface BorderFitComponent {
	readonly label: number;
	readonly cx: number;
	readonly cy: number;
	readonly area: number;
	readonly bboxX: number;
	readonly bboxY: number;
	readonly bboxW: number;
	readonly bboxH: number;
	/** PCA major-axis orientation, radians. */
	readonly angle: number;
}

export interface BorderFitBasket {
	readonly detId: string;
	/** Full semantic footprint incl. the dark shell, mask-local frame. */
	readonly bboxLocal: readonly [number, number, number, number];
	/** Tight white-body bounds, mask-local frame. */
	readonly whiteBboxLocal: readonly [number, number, number, number];
	readonly centerXLocalPx: number;
	readonly centerYLocalPx: number;
}

export interface BorderFitBadge {
	readonly detId: string;
	readonly label: string | null;
	readonly cxLocalPx: number;
	readonly cyLocalPx: number;
}

export interface BorderFitVisiblePad {
	readonly teeId: string;
	readonly componentLabel: number;
	readonly majorPx: number;
	readonly minorPx: number;
	readonly areaPx: number;
}

export interface BorderFitKnobs {
	readonly minimumPadSampleSize: number;
	readonly borderMarginPx: number;
	readonly haloPx: number;
	readonly candidateAreaCapFactor: number;
	readonly evidenceFloorFactor: number;
	readonly axisOrthogonalToleranceDeg: number;
}

export interface BorderFitPadDims {
	readonly longPx: number;
	readonly shortPx: number;
	readonly wallPx: number;
	readonly sampleSize: number;
	readonly minimumPadSampleSize: number;
	readonly isFallback: boolean;
	readonly provenance: string;
}

export interface BorderFitPlacement {
	readonly x0: number;
	readonly y0: number;
	readonly w: number;
	readonly h: number;
	readonly centerXPx: number;
	readonly centerYPx: number;
	/** Long-axis orientation of this placement: PI/2 when h >= w, else 0. */
	readonly axisRad: number;
	readonly outlinePx: number;
	readonly evidencePx: number;
	readonly occludedPx: number;
	readonly transitionPx: number;
	readonly barePx: number;
	readonly candidateOnOutlinePx: number;
	readonly candidateWallAdjacentPx: number;
	readonly candidateOffOutlinePx: number;
	/** barePx + candidateOffOutlinePx: any nonzero value forbids acceptance. */
	readonly hardContradictions: number;
	/** First few bare outline pixels, mask-local "(x,y)" strings, for receipts. */
	readonly bareSample: readonly string[];
}

export interface BorderCornerClaim {
	/** The basket whose black border anchored discovery (an OCCLUDER id --
	 * not necessarily the claimed hole's own basket). */
	readonly anchorBasketIds: readonly string[];
	readonly componentLabel: number;
	readonly componentArea: number;
	readonly componentBbox: readonly [number, number, number, number];
	readonly placement: BorderFitPlacement;
	readonly teeXPx: number;
	readonly teeYPx: number;
	readonly angleRad: number;
	readonly aimBadgeId: string;
	readonly aimBadgeLabel: string | null;
	readonly aimErrorDeg: number;
	readonly aimRunnerUpBadgeId: string | null;
	readonly aimRunnerUpGapDeg: number | null;
	/** A quantized axis cannot separate bearings closer than
	 * atan(1px / padLongPx); an aim whose runner-up gap sits under that bound
	 * is carried as UNRESOLVED -- the tee stands, the badge identity does
	 * not. Composition (e.g. a sibling lane recovering the runner-up's own
	 * tee) is what collapses it. */
	readonly aimResolved: boolean;
	readonly aimResolutionBoundDeg: number;
}

export interface BorderCornerAbstention {
	readonly anchorBasketIds: readonly string[];
	readonly componentLabel: number | null;
	readonly reason:
		| 'course-pad-dims-unknown'
		| 'non-orthogonal-axis'
		| 'no-contradiction-free-placement'
		| 'orientation-unresolved'
		| 'no-eligible-aim-badge'
		| 'badge-contested'
		| 'lost-evidence-dominance';
	readonly detail: string;
}

export interface BorderExcludedCandidate {
	readonly anchorBasketIds: readonly string[];
	readonly componentLabel: number;
	readonly reason:
		| 'basket-glyph-fill'
		| 'owned-by-visible-tee'
		| 'exceeds-course-pad-area-cap'
		| 'below-course-evidence-floor';
	readonly detail: string;
}

export interface BorderCornerFitResult {
	readonly padDims: BorderFitPadDims;
	readonly basketsScanned: number;
	readonly candidatesConsidered: number;
	readonly claims: readonly BorderCornerClaim[];
	readonly abstentions: readonly BorderCornerAbstention[];
	readonly excluded: readonly BorderExcludedCandidate[];
	/** Glyph-fill component label per basket detId (null = unresolved). */
	readonly glyphFillLabels: readonly (readonly [string, number | null])[];
	/** Which badges claims were allowed to aim at, and why the rest were not. */
	readonly aimEligibility: {
		readonly badgesOnBoard: number;
		readonly coveredBadgeIds: readonly string[];
		readonly eligibleBadgeIds: readonly string[];
	};
}

const DEG = 180 / Math.PI;

/** Deterministic lower median. */
function lowerMedian(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor((sorted.length - 1) / 2)];
}

/** Course pad dimensions from this course's own visible pads -- the only
 * source of pad size this module accepts. */
export function derivePadDims(
	pads: readonly BorderFitVisiblePad[],
	knobs: BorderFitKnobs
): BorderFitPadDims {
	const sampleSize = pads.length;
	if (sampleSize < knobs.minimumPadSampleSize) {
		return {
			longPx: NaN,
			shortPx: NaN,
			wallPx: NaN,
			sampleSize,
			minimumPadSampleSize: knobs.minimumPadSampleSize,
			isFallback: true,
			provenance:
				`only ${sampleSize} visible pad(s) on this course's board, below minimumPadSampleSize=` +
				`${knobs.minimumPadSampleSize} -- pad size is UNKNOWN and no border fit is attempted ` +
				'(footgun law: a pad size must be course-measured or loudly absent, never assumed).'
		};
	}
	const longPx = Math.round(lowerMedian(pads.map((pad) => Math.max(pad.majorPx, pad.minorPx))));
	const shortPx = Math.round(lowerMedian(pads.map((pad) => Math.min(pad.majorPx, pad.minorPx))));
	const medianArea = lowerMedian(pads.map((pad) => pad.areaPx));
	const wallPx = Math.max(1, Math.round(medianArea / (2 * (longPx + shortPx))));
	return {
		longPx,
		shortPx,
		wallPx,
		sampleSize,
		minimumPadSampleSize: knobs.minimumPadSampleSize,
		isFallback: false,
		provenance:
			`lower medians over the ${sampleSize} visible tee pads on THIS course's board: ` +
			`long=${longPx}px short=${shortPx}px (PCA-projected extents); wall thickness ` +
			`${wallPx}px = median pad area ${medianArea}px / outline perimeter 2*(long+short), ` +
			'clamped >= 1. No absolute size constant is used anywhere in this fit.'
	};
}

/** The bright component that is a basket's own white body. Probed, never
 * assumed: glyph interiors carry ink lines, so several probe points are
 * tried and the first bright label wins. */
export function resolveGlyphFillLabel(
	masks: BorderFitMasks,
	basket: BorderFitBasket
): number | null {
	const [wx, wy, ww, wh] = basket.whiteBboxLocal;
	const probes: readonly (readonly [number, number])[] = [
		[basket.centerXLocalPx, basket.centerYLocalPx],
		[wx + ww / 2, wy + wh / 2],
		[wx + ww / 4, wy + wh / 2],
		[wx + (3 * ww) / 4, wy + wh / 2],
		[wx + ww / 2, wy + wh / 4],
		[wx + ww / 2, wy + (3 * wh) / 4]
	];
	for (const [px, py] of probes) {
		const x = Math.round(px);
		const y = Math.round(py);
		if (x < 0 || y < 0 || x >= masks.width || y >= masks.height) continue;
		const label = masks.brightLabels[y * masks.width + x];
		if (label > 0) return label;
	}
	return null;
}

interface DiscoveredCandidate {
	readonly component: BorderFitComponent;
	readonly anchorBasketIds: readonly string[];
}

export interface BorderDiscovery {
	readonly candidates: readonly DiscoveredCandidate[];
	readonly excluded: readonly BorderExcludedCandidate[];
	readonly glyphFillLabels: readonly (readonly [string, number | null])[];
}

function bboxesIntersect(
	ax: number,
	ay: number,
	aw: number,
	ah: number,
	bx: number,
	by: number,
	bw: number,
	bh: number
): boolean {
	return ax < bx + bw && bx < ax + aw && ay < by + bh && by < ay + ah;
}

/** Owner's discovery rule: ANY white component connected to a basket's black
 * border is a tee-recovery candidate -- except the basket's own white fill
 * and components already owned by visible tees, both excluded BY NAME. */
export function discoverBorderCandidates(
	masks: BorderFitMasks,
	components: readonly BorderFitComponent[],
	baskets: readonly BorderFitBasket[],
	visiblePads: readonly BorderFitVisiblePad[],
	padDims: BorderFitPadDims,
	knobs: BorderFitKnobs
): BorderDiscovery {
	const { width, height, dark, brightLabels } = masks;
	const glyphFillLabels: (readonly [string, number | null])[] = baskets.map((basket) => [
		basket.detId,
		resolveGlyphFillLabel(masks, basket)
	]);
	const glyphLabelSet = new Set<number>();
	for (const [, label] of glyphFillLabels) if (label !== null) glyphLabelSet.add(label);
	const ownedPadLabels = new Set(visiblePads.map((pad) => pad.componentLabel));

	const margin = knobs.borderMarginPx;
	const anchorsByLabel = new Map<number, string[]>();
	for (const basket of baskets) {
		const [bx, by, bw, bh] = basket.bboxLocal;
		const ex = bx - margin;
		const ey = by - margin;
		const ew = bw + 2 * margin;
		const eh = bh + 2 * margin;
		for (const component of components) {
			// grow by 1 so single-pixel adjacency across the bbox edge still counts
			if (
				!bboxesIntersect(
					component.bboxX - 1,
					component.bboxY - 1,
					component.bboxW + 2,
					component.bboxH + 2,
					ex,
					ey,
					ew,
					eh
				)
			) {
				continue;
			}
			let adjacent = false;
			for (let y = component.bboxY; y < component.bboxY + component.bboxH && !adjacent; y++) {
				for (let x = component.bboxX; x < component.bboxX + component.bboxW && !adjacent; x++) {
					if (brightLabels[y * width + x] !== component.label) continue;
					for (let dy = -1; dy <= 1 && !adjacent; dy++) {
						for (let dx = -1; dx <= 1 && !adjacent; dx++) {
							if (dx === 0 && dy === 0) continue;
							const nx = x + dx;
							const ny = y + dy;
							if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
							if (dark[ny * width + nx] !== 1) continue;
							if (nx < ex || ny < ey || nx >= ex + ew || ny >= ey + eh) continue;
							adjacent = true;
						}
					}
				}
			}
			if (!adjacent) continue;
			const anchors = anchorsByLabel.get(component.label) ?? [];
			if (!anchors.includes(basket.detId)) anchors.push(basket.detId);
			anchorsByLabel.set(component.label, anchors);
		}
	}

	const candidates: DiscoveredCandidate[] = [];
	const excluded: BorderExcludedCandidate[] = [];
	const areaCap = padDims.isFallback
		? NaN
		: padDims.longPx * padDims.shortPx * knobs.candidateAreaCapFactor;
	const evidenceFloor = padDims.isFallback
		? NaN
		: padDims.wallPx * padDims.shortPx * knobs.evidenceFloorFactor;
	const byLabel = new Map(components.map((component) => [component.label, component]));
	for (const [label, anchorBasketIds] of [...anchorsByLabel.entries()].sort((a, b) => a[0] - b[0])) {
		const component = byLabel.get(label);
		if (!component) continue;
		if (glyphLabelSet.has(label)) {
			excluded.push({
				anchorBasketIds,
				componentLabel: label,
				reason: 'basket-glyph-fill',
				detail:
					`component ${label} IS a basket's own white body (area ${component.area}px) -- the ` +
					'named occluder, never pad evidence and never a candidate.'
			});
			continue;
		}
		if (ownedPadLabels.has(label)) {
			excluded.push({
				anchorBasketIds,
				componentLabel: label,
				reason: 'owned-by-visible-tee',
				detail: `component ${label} is already a visible tee's pad component.`
			});
			continue;
		}
		if (!padDims.isFallback && component.area > areaCap) {
			excluded.push({
				anchorBasketIds,
				componentLabel: label,
				reason: 'exceeds-course-pad-area-cap',
				detail:
					`area ${component.area}px > cap ${areaCap.toFixed(1)}px = courseLong*courseShort*` +
					`${knobs.candidateAreaCapFactor} (course-derived; a component bigger than a whole pad ` +
					'cannot be a pad remnant).'
			});
			continue;
		}
		if (!padDims.isFallback && component.area < evidenceFloor) {
			excluded.push({
				anchorBasketIds,
				componentLabel: label,
				reason: 'below-course-evidence-floor',
				detail:
					`area ${component.area}px < floor ${evidenceFloor.toFixed(1)}px = wall*short*` +
					`${knobs.evidenceFloorFactor} (course-derived: less than ${knobs.evidenceFloorFactor} ` +
					'of one short wall run cannot anchor a pad; an anti-alias speck could otherwise claim ' +
					'a fully-occluded placement with near-zero evidence).'
			});
			continue;
		}
		candidates.push({ component, anchorBasketIds });
	}
	return { candidates, excluded, glyphFillLabels };
}

/** Normalized distance (deg) from a PCA angle to the nearest image axis. */
export function axisOrthogonalityErrorDeg(angleRad: number): number {
	const deg = ((angleRad * DEG) % 180 + 180) % 180;
	return Math.min(deg, Math.abs(deg - 90), Math.abs(deg - 180));
}

type PixelClass = 'evidence' | 'occluded' | 'transition' | 'bare';

function classifierFor(
	masks: BorderFitMasks,
	glyphLabelSet: ReadonlySet<number>,
	haloPx: number
): (x: number, y: number) => PixelClass {
	const { width, height, bright, dark, brightLabels } = masks;
	const isOccluder = (x: number, y: number): boolean => {
		if (x < 0 || y < 0 || x >= width || y >= height) return false;
		const index = y * width + x;
		return dark[index] === 1 || glyphLabelSet.has(brightLabels[index]);
	};
	return (x: number, y: number): PixelClass => {
		if (x < 0 || y < 0 || x >= width || y >= height) return 'bare';
		const index = y * width + x;
		if (bright[index] === 1 && !glyphLabelSet.has(brightLabels[index])) return 'evidence';
		if (isOccluder(x, y)) return 'occluded';
		for (let dy = -haloPx; dy <= haloPx; dy++) {
			for (let dx = -haloPx; dx <= haloPx; dx++) {
				if (isOccluder(x + dx, y + dy)) return 'transition';
			}
		}
		return 'bare';
	};
}

function outlineIndices(
	x0: number,
	y0: number,
	w: number,
	h: number,
	wallPx: number,
	width: number
): { pixels: readonly (readonly [number, number])[]; band: ReadonlySet<number> } {
	const pixels: (readonly [number, number])[] = [];
	const band = new Set<number>();
	for (let y = y0; y < y0 + h; y++) {
		for (let x = x0; x < x0 + w; x++) {
			const onBand =
				x - x0 < wallPx || x0 + w - 1 - x < wallPx || y - y0 < wallPx || y0 + h - 1 - y < wallPx;
			if (!onBand) continue;
			pixels.push([x, y]);
			band.add(y * width + x);
		}
	}
	return { pixels, band };
}

function candidatePixels(
	masks: BorderFitMasks,
	component: BorderFitComponent
): readonly (readonly [number, number])[] {
	const pixels: (readonly [number, number])[] = [];
	for (let y = component.bboxY; y < component.bboxY + component.bboxH; y++) {
		for (let x = component.bboxX; x < component.bboxX + component.bboxW; x++) {
			if (masks.brightLabels[y * masks.width + x] === component.label) pixels.push([x, y]);
		}
	}
	return pixels;
}

export interface CandidateFit {
	readonly accepted: BorderFitPlacement | null;
	readonly best: BorderFitPlacement | null;
	/** Contradiction-free placements tied with `accepted` on evidence --
	 * nonempty means orientation needs the badge tie-break. */
	readonly acceptedTies: readonly BorderFitPlacement[];
	readonly abstention: BorderCornerAbstention | null;
	readonly placementsScored: number;
}

/**
 * Anchor the course-median pad to the remnant's bbox faces (the remnant lies
 * ON the wall band) and slide it along the wall -- integer positions, exact
 * pixel walk, no rotation. Both orientations and all four wall families are
 * enumerated; the classification decides, never a prior.
 */
export function fitBorderCandidate(
	masks: BorderFitMasks,
	glyphLabelSet: ReadonlySet<number>,
	candidate: DiscoveredCandidate,
	padDims: BorderFitPadDims,
	knobs: BorderFitKnobs
): CandidateFit {
	const { component, anchorBasketIds } = candidate;
	const orthErr = axisOrthogonalityErrorDeg(component.angle);
	if (orthErr > knobs.axisOrthogonalToleranceDeg) {
		return {
			accepted: null,
			best: null,
			acceptedTies: [],
			abstention: {
				anchorBasketIds,
				componentLabel: component.label,
				reason: 'non-orthogonal-axis',
				detail:
					`remnant PCA is ${orthErr.toFixed(1)}deg off the nearest image axis ` +
					`(> axisOrthogonalToleranceDeg=${knobs.axisOrthogonalToleranceDeg}); the axis-aligned ` +
					'corner fit does not apply and this landing abstains rather than rotating a fit ' +
					'(rotated rails are a sibling lane).'
			},
			placementsScored: 0
		};
	}

	const classify = classifierFor(masks, glyphLabelSet, knobs.haloPx);
	const remnant = candidatePixels(masks, component);
	const cbx = component.bboxX;
	const cby = component.bboxY;
	const cbw = component.bboxW;
	const cbh = component.bboxH;

	const seen = new Set<string>();
	const placements: BorderFitPlacement[] = [];
	for (const [w, h] of [
		[padDims.shortPx, padDims.longPx],
		[padDims.longPx, padDims.shortPx]
	] as const) {
		const xSlides: (readonly [number, number])[] = [];
		// remnant on the left or right wall: x anchored, y slides
		for (const x0 of [cbx, cbx + cbw - w]) {
			const lo = Math.min(cby + cbh - h, cby);
			const hi = Math.max(cby + cbh - h, cby);
			for (let y0 = lo; y0 <= hi; y0++) xSlides.push([x0, y0]);
		}
		// remnant on the top or bottom wall: y anchored, x slides
		for (const y0 of [cby, cby + cbh - h]) {
			const lo = Math.min(cbx + cbw - w, cbx);
			const hi = Math.max(cbx + cbw - w, cbx);
			for (let x0 = lo; x0 <= hi; x0++) xSlides.push([x0, y0]);
		}
		for (const [x0, y0] of xSlides) {
			const key = `${x0},${y0},${w},${h}`;
			if (seen.has(key)) continue;
			seen.add(key);
			const { pixels, band } = outlineIndices(x0, y0, w, h, padDims.wallPx, masks.width);
			let evidencePx = 0;
			let occludedPx = 0;
			let transitionPx = 0;
			let barePx = 0;
			const bareSample: string[] = [];
			for (const [x, y] of pixels) {
				const cls = classify(x, y);
				if (cls === 'evidence') evidencePx++;
				else if (cls === 'occluded') occludedPx++;
				else if (cls === 'transition') transitionPx++;
				else {
					barePx++;
					if (bareSample.length < 8) bareSample.push(`(${x},${y})`);
				}
			}
			let candidateOnOutlinePx = 0;
			let candidateWallAdjacentPx = 0;
			let candidateOffOutlinePx = 0;
			for (const [x, y] of remnant) {
				if (band.has(y * masks.width + x)) {
					candidateOnOutlinePx++;
					continue;
				}
				let nearBand = false;
				for (let dy = -knobs.haloPx; dy <= knobs.haloPx && !nearBand; dy++) {
					for (let dx = -knobs.haloPx; dx <= knobs.haloPx && !nearBand; dx++) {
						if (band.has((y + dy) * masks.width + (x + dx))) nearBand = true;
					}
				}
				if (nearBand) candidateWallAdjacentPx++;
				else candidateOffOutlinePx++;
			}
			placements.push({
				x0,
				y0,
				w,
				h,
				centerXPx: x0 + (w - 1) / 2,
				centerYPx: y0 + (h - 1) / 2,
				axisRad: h >= w ? Math.PI / 2 : 0,
				outlinePx: pixels.length,
				evidencePx,
				occludedPx,
				transitionPx,
				barePx,
				candidateOnOutlinePx,
				candidateWallAdjacentPx,
				candidateOffOutlinePx,
				hardContradictions: barePx + candidateOffOutlinePx,
				bareSample
			});
		}
	}

	placements.sort(
		(a, b) =>
			a.hardContradictions - b.hardContradictions ||
			b.evidencePx - a.evidencePx ||
			a.x0 - b.x0 ||
			a.y0 - b.y0 ||
			a.w - b.w
	);
	const best = placements[0] ?? null;
	if (!best || best.hardContradictions > 0) {
		return {
			accepted: null,
			best,
			acceptedTies: [],
			abstention: {
				anchorBasketIds,
				componentLabel: component.label,
				reason: 'no-contradiction-free-placement',
				detail: best
					? `best placement [${best.x0},${best.y0} ${best.w}x${best.h}] still has ` +
						`${best.barePx} BARE outline px + ${best.candidateOffOutlinePx} remnant px off the ` +
						`wall band (bare sample: ${best.bareSample.join(' ')}); a contradicted placement is ` +
						'never accepted.'
					: 'no placement could be enumerated for this remnant.',
			},
			placementsScored: placements.length
		};
	}
	const acceptedTies = placements.filter(
		(placement) =>
			placement !== best &&
			placement.hardContradictions === 0 &&
			placement.evidencePx === best.evidencePx &&
			(placement.centerXPx !== best.centerXPx ||
				placement.centerYPx !== best.centerYPx ||
				placement.axisRad !== best.axisRad)
	);
	return { accepted: best, best, acceptedTies, abstention: null, placementsScored: placements.length };
}

/** Undirected axis-vs-bearing error (a pad axis has no arrowhead). */
export function undirectedAxisErrorDeg(axisRad: number, bearingRad: number): number {
	const delta = Math.abs(Math.atan2(Math.sin(axisRad - bearingRad), Math.cos(axisRad - bearingRad)));
	return Math.min(delta, Math.PI - delta) * DEG;
}

interface AimReading {
	readonly badgeId: string;
	readonly badgeLabel: string | null;
	readonly errorDeg: number;
	readonly runnerUpBadgeId: string | null;
	readonly runnerUpGapDeg: number | null;
}

function aimFor(
	placement: BorderFitPlacement,
	badges: readonly BorderFitBadge[]
): AimReading | null {
	const readings = badges
		.map((badge) => ({
			badgeId: badge.detId,
			badgeLabel: badge.label,
			errorDeg: undirectedAxisErrorDeg(
				placement.axisRad,
				Math.atan2(badge.cyLocalPx - placement.centerYPx, badge.cxLocalPx - placement.centerXPx)
			)
		}))
		.sort((a, b) => a.errorDeg - b.errorDeg || a.badgeId.localeCompare(b.badgeId));
	const bestReading = readings[0];
	if (!bestReading) return null;
	const runnerUp = readings[1] ?? null;
	return {
		badgeId: bestReading.badgeId,
		badgeLabel: bestReading.badgeLabel,
		errorDeg: bestReading.errorDeg,
		runnerUpBadgeId: runnerUp?.badgeId ?? null,
		runnerUpGapDeg: runnerUp ? runnerUp.errorDeg - bestReading.errorDeg : null
	};
}

/**
 * Full pipeline: dims -> discovery -> per-candidate fit -> badge aim
 * tie-break -> per-badge uniqueness.
 *
 * `coveredBadgeIds` is the union of badges touched by POSSIBLE visible-tee
 * testimony (resolveVisibleTeeBadgeRays' eligibility contract: only a badge
 * absent from that set is eligible for recovery). A buried tee can only aim
 * at an UNSERVED badge -- without this, any far badge that happens to lie
 * near one of the two axes steals the orientation tie-break, which is
 * exactly what the first Heritage production run showed (badge "11",
 * 0.056deg off the horizontal axis, already served by its own visible tee,
 * outvoted the unserved hole-6 badge at 6.9deg off the vertical axis).
 */
export function runBorderCornerFit(
	masks: BorderFitMasks,
	components: readonly BorderFitComponent[],
	baskets: readonly BorderFitBasket[],
	badges: readonly BorderFitBadge[],
	visiblePads: readonly BorderFitVisiblePad[],
	knobs: BorderFitKnobs,
	coveredBadgeIds: readonly string[] = []
): BorderCornerFitResult {
	const padDims = derivePadDims(visiblePads, knobs);
	if (padDims.isFallback) {
		return {
			padDims,
			basketsScanned: baskets.length,
			candidatesConsidered: 0,
			claims: [],
			abstentions: [
				{
					anchorBasketIds: [],
					componentLabel: null,
					reason: 'course-pad-dims-unknown',
					detail: padDims.provenance
				}
			],
			excluded: [],
			glyphFillLabels: baskets.map((basket) => [basket.detId, null]),
			aimEligibility: {
				badgesOnBoard: badges.length,
				coveredBadgeIds: [...coveredBadgeIds],
				eligibleBadgeIds: []
			}
		};
	}
	const discovery = discoverBorderCandidates(masks, components, baskets, visiblePads, padDims, knobs);
	const glyphLabelSet = new Set<number>();
	for (const [, label] of discovery.glyphFillLabels) if (label !== null) glyphLabelSet.add(label);

	const covered = new Set(coveredBadgeIds);
	const eligibleBadges = badges.filter((badge) => !covered.has(badge.detId));

	const abstentions: BorderCornerAbstention[] = [];
	const provisional: BorderCornerClaim[] = [];
	for (const candidate of discovery.candidates) {
		const fit = fitBorderCandidate(masks, glyphLabelSet, candidate, padDims, knobs);
		if (fit.abstention) {
			abstentions.push(fit.abstention);
			continue;
		}
		const accepted = fit.accepted;
		if (!accepted) continue;
		if (eligibleBadges.length === 0) {
			abstentions.push({
				anchorBasketIds: candidate.anchorBasketIds,
				componentLabel: candidate.component.label,
				reason: 'no-eligible-aim-badge',
				detail:
					`a contradiction-free fit exists but 0 of ${badges.length} badges are eligible to aim ` +
					`at (${covered.size} covered by possible visible-tee testimony); recovery only claims ` +
					'badges no visible tee can serve.'
			});
			continue;
		}
		let winner = accepted;
		if (fit.acceptedTies.length > 0) {
			const scored = [accepted, ...fit.acceptedTies]
				.map((placement) => ({ placement, aim: aimFor(placement, eligibleBadges) }))
				.sort((a, b) => (a.aim?.errorDeg ?? Infinity) - (b.aim?.errorDeg ?? Infinity));
			const bestScored = scored[0];
			const nextScored = scored[1];
			if (
				bestScored.aim &&
				nextScored?.aim &&
				bestScored.aim.errorDeg === nextScored.aim.errorDeg
			) {
				abstentions.push({
					anchorBasketIds: candidate.anchorBasketIds,
					componentLabel: candidate.component.label,
					reason: 'orientation-unresolved',
					detail:
						'contradiction-free placements tie on evidence AND on badge-aim error ' +
						`(${bestScored.aim.errorDeg.toFixed(3)}deg); no honest way to choose.`
				});
				continue;
			}
			winner = bestScored.placement;
		}
		const aim = aimFor(winner, eligibleBadges);
		if (!aim) {
			abstentions.push({
				anchorBasketIds: candidate.anchorBasketIds,
				componentLabel: candidate.component.label,
				reason: 'no-eligible-aim-badge',
				detail: 'a fit was accepted but there is no eligible badge to aim the claim at.'
			});
			continue;
		}
		// the axis is quantized to the image grid: bearings closer together
		// than atan(1px over the pad's long side) are indistinguishable
		const aimResolutionBoundDeg = Math.atan2(1, padDims.longPx) * DEG;
		provisional.push({
			anchorBasketIds: candidate.anchorBasketIds,
			componentLabel: candidate.component.label,
			componentArea: candidate.component.area,
			componentBbox: [
				candidate.component.bboxX,
				candidate.component.bboxY,
				candidate.component.bboxW,
				candidate.component.bboxH
			],
			placement: winner,
			teeXPx: winner.centerXPx,
			teeYPx: winner.centerYPx,
			angleRad: winner.axisRad,
			aimBadgeId: aim.badgeId,
			aimBadgeLabel: aim.badgeLabel,
			aimErrorDeg: aim.errorDeg,
			aimRunnerUpBadgeId: aim.runnerUpBadgeId,
			aimRunnerUpGapDeg: aim.runnerUpGapDeg,
			aimResolved: aim.runnerUpGapDeg === null || aim.runnerUpGapDeg >= aimResolutionBoundDeg,
			aimResolutionBoundDeg
		});
	}

	// G4 contract: a UNIQUE TeeBadgeClaim per badge, or a NAMED abstention.
	const byBadge = new Map<string, BorderCornerClaim[]>();
	for (const claim of provisional) {
		const list = byBadge.get(claim.aimBadgeId) ?? [];
		list.push(claim);
		byBadge.set(claim.aimBadgeId, list);
	}
	const claims: BorderCornerClaim[] = [];
	for (const [badgeId, group] of byBadge) {
		if (group.length === 1) {
			claims.push(group[0]);
			continue;
		}
		const ranked = [...group].sort((a, b) => b.placement.evidencePx - a.placement.evidencePx);
		if (ranked[0].placement.evidencePx > ranked[1].placement.evidencePx) {
			claims.push(ranked[0]);
			for (const loser of ranked.slice(1)) {
				abstentions.push({
					anchorBasketIds: loser.anchorBasketIds,
					componentLabel: loser.componentLabel,
					reason: 'lost-evidence-dominance',
					detail:
						`aims at ${badgeId} like component ${ranked[0].componentLabel}, but with ` +
						`${loser.placement.evidencePx} evidence px vs the winner's ` +
						`${ranked[0].placement.evidencePx}; the strictly stronger remnant keeps the claim.`
				});
			}
		} else {
			for (const contested of ranked) {
				abstentions.push({
					anchorBasketIds: contested.anchorBasketIds,
					componentLabel: contested.componentLabel,
					reason: 'badge-contested',
					detail:
						`${ranked.length} remnants aim at ${badgeId} with equal-strength evidence ` +
						`(${ranked[0].placement.evidencePx}px); no unique claim exists, so ALL abstain by name.`
				});
			}
		}
	}
	claims.sort((a, b) => a.aimBadgeId.localeCompare(b.aimBadgeId));

	return {
		padDims,
		basketsScanned: baskets.length,
		candidatesConsidered: discovery.candidates.length,
		claims,
		abstentions,
		excluded: discovery.excluded,
		glyphFillLabels: discovery.glyphFillLabels,
		aimEligibility: {
			badgesOnBoard: badges.length,
			coveredBadgeIds: [...coveredBadgeIds],
			eligibleBadgeIds: eligibleBadges.map((badge) => badge.detId)
		}
	};
}
