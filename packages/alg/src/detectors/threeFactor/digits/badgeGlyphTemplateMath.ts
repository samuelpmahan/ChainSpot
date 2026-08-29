/**
 * Whole-glyph Dice-coefficient template matcher — a pure-TS port of the
 * PRE-REBUILD classifier (`old-stuff/src/lib/autoAnnotation/
 * badgeGlyphClassifier.ts`, `classifyKnownBadgeBodiesPureTs` +
 * `normalizeBadgeGlyphMask` + `shiftedDice`), resurrected per docs/
 * CLAIMS-LEDGER.md row 23 (UPHELD): on the full Dev6 corpus this mechanism
 * formed an exact 1..18 bijection and was correct on every disputed badge
 * the per-digit segmentation reader misread, because the vocabulary here is
 * STRUCTURAL — the classifier can only ever say "this looks most like one
 * of these 18 known shapes, or I abstain" — rather than concatenating
 * independently-classified digits into an unbounded string.
 *
 * This module is the badgeGlyphTemplate ABFeature's math only: given a
 * badge's on-image bounding box and the raw RGBA raster it was detected in
 * (the SAME `localImage` slot and the SAME badge bbox the current per-digit
 * reader consumes — see g1.badgeGlyphTemplate.ts), it samples a coarse
 * bright/dark mask, normalizes it to a small canonical canvas, and scores it
 * against 18 pre-normalized canonical hole-number templates by a
 * translation-tolerant (shifted) Dice coefficient. Abstention is
 * first-class: a low top score or a thin top-vs-runner-up margin refuses to
 * label rather than guessing (house rule: loud UNKNOWN over silent
 * smoothing).
 *
 * Every threshold below is the OLD system's own empirical value, carried as
 * verbatim as this port allows (house rule: an imported numeric constant
 * needs a per-image or empirical justification comment; these are the old
 * classifier's own values, proven on this exact corpus by the ledger row 23
 * head-to-head, so the justification IS that empirical record, not a fresh
 * derivation here).
 */

export interface RgbaBitmap {
	readonly width: number;
	readonly height: number;
	/** RGBA, row-major, 4 bytes per pixel. Alpha is ignored. */
	readonly data: Uint8Array | Uint8ClampedArray;
}

/** Center + size of the badge region to sample, in the same image-pixel
 * frame as `RgbaBitmap` — identical shape to the current reader's
 * `ComponentStats.bboxX/Y/W/H`-derived crop, just center-based like the old
 * classifier's own `KnownBadgeBody`. */
export interface BadgeCropBody {
	readonly xPx: number;
	readonly yPx: number;
	readonly widthPx: number;
	readonly heightPx: number;
}

export interface NormalizedGlyphMask {
	readonly widthPx: number;
	readonly heightPx: number;
	/** one byte per pixel, 0/1, row-major */
	readonly data: Uint8Array;
}

export interface BadgeGlyphTemplateKnobs {
	/** Dice score below this is an outright reject, never a guess (old
	 * system's empirical `minScore`, badgeGlyphClassifier.ts DEFAULTS). */
	readonly minScore: number;
	/** Gap between the best and second-best template score required before
	 * accepting the best one (old system's empirical `minMargin`). */
	readonly minMargin: number;
	/** Max grayscale channel value at/above which a sampled pixel counts as
	 * "bright" foreground (old system's empirical `foregroundThreshold`,
	 * paired with a <=90 max-min channel spread test for neutral/white). */
	readonly foregroundThreshold: number;
	/** Canonical normalized canvas size the old classifier trained/tested
	 * its templates at (old system's empirical `normalizedWidthPx/HeightPx`). */
	readonly normalizedWidthPx: number;
	readonly normalizedHeightPx: number;
	/** +/- integer pixel search window for the best translation alignment
	 * before scoring Dice (old system's empirical `maxShiftPx`). */
	readonly maxShiftPx: number;
}

// Old system's own empirical values (old-stuff/src/lib/autoAnnotation/
// badgeGlyphClassifier.ts DEFAULTS), carried as-is per the house rule above.
export const DEFAULT_BADGE_GLYPH_TEMPLATE_KNOBS: BadgeGlyphTemplateKnobs = Object.freeze({
	minScore: 0.58,
	minMargin: 0.045,
	foregroundThreshold: 150,
	normalizedWidthPx: 24,
	normalizedHeightPx: 18,
	maxShiftPx: 1
});

interface SampledMask {
	readonly widthPx: number;
	readonly heightPx: number;
	readonly data: Uint8Array;
	readonly foreground: number;
}

function rgbaAt(image: RgbaBitmap, x: number, y: number): readonly [number, number, number] {
	const clampedX = Math.max(0, Math.min(image.width - 1, x));
	const clampedY = Math.max(0, Math.min(image.height - 1, y));
	const offset = (clampedY * image.width + clampedX) * 4;
	return [image.data[offset], image.data[offset + 1], image.data[offset + 2]];
}

// A pixel is "glyph foreground" when it is bright AND roughly neutral
// (small max-min channel spread) — the old classifier's own test for a
// white/near-white printed digit against a colored badge plate.
function brightNeutral(r: number, g: number, b: number, threshold: number): boolean {
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	return max >= threshold && max - min <= 90;
}

/**
 * Coarse foreground sample over the badge's interior, with a fixed inset
 * margin (old system's empirical 14%/16% margins, which exclude the plate's
 * own printed border from the sample) on a fixed 48x36 sampling grid.
 */
function rawBadgeGlyphMask(
	image: RgbaBitmap,
	badge: BadgeCropBody,
	threshold: number,
	sampleWidthPx: number,
	sampleHeightPx: number
): SampledMask {
	const data = new Uint8Array(sampleWidthPx * sampleHeightPx);
	const left = badge.xPx - badge.widthPx / 2;
	const top = badge.yPx - badge.heightPx / 2;
	const marginX = 0.14;
	const marginY = 0.16;
	let foreground = 0;
	for (let y = 0; y < sampleHeightPx; y += 1) {
		const v = (y + 0.5) / sampleHeightPx;
		if (v < marginY || v > 1 - marginY) continue;
		for (let x = 0; x < sampleWidthPx; x += 1) {
			const u = (x + 0.5) / sampleWidthPx;
			if (u < marginX || u > 1 - marginX) continue;
			const sourceX = Math.round(left + u * badge.widthPx - 0.5);
			const sourceY = Math.round(top + v * badge.heightPx - 0.5);
			const [r, g, b] = rgbaAt(image, sourceX, sourceY);
			if (!brightNeutral(r, g, b, threshold)) continue;
			data[y * sampleWidthPx + x] = 1;
			foreground += 1;
		}
	}
	return { widthPx: sampleWidthPx, heightPx: sampleHeightPx, data, foreground };
}

function tightBounds(
	mask: SampledMask
): { minX: number; minY: number; maxX: number; maxY: number } | null {
	let minX = mask.widthPx;
	let minY = mask.heightPx;
	let maxX = -1;
	let maxY = -1;
	for (let y = 0; y < mask.heightPx; y += 1) {
		for (let x = 0; x < mask.widthPx; x += 1) {
			if (!mask.data[y * mask.widthPx + x]) continue;
			minX = Math.min(minX, x);
			maxX = Math.max(maxX, x);
			minY = Math.min(minY, y);
			maxY = Math.max(maxY, y);
		}
	}
	return maxX < 0 ? null : { minX, minY, maxX, maxY };
}

/**
 * Sample a badge crop's foreground, tight-crop it, and re-draw it centered
 * on the canonical normalized canvas (nearest-neighbor, preserving aspect
 * ratio). Returns null when the badge has no bright foreground at all
 * (empty-glyph — the caller must abstain, not guess).
 */
export function normalizeBadgeGlyphMask(
	image: RgbaBitmap,
	badge: BadgeCropBody,
	knobs: BadgeGlyphTemplateKnobs = DEFAULT_BADGE_GLYPH_TEMPLATE_KNOBS
): NormalizedGlyphMask | null {
	const sampled = rawBadgeGlyphMask(image, badge, knobs.foregroundThreshold, 48, 36);
	const bounds = tightBounds(sampled);
	if (!bounds) return null;
	const sourceWidth = bounds.maxX - bounds.minX + 1;
	const sourceHeight = bounds.maxY - bounds.minY + 1;
	const innerWidth = Math.max(1, knobs.normalizedWidthPx - 2);
	const innerHeight = Math.max(1, knobs.normalizedHeightPx - 2);
	const scale = Math.min(innerWidth / sourceWidth, innerHeight / sourceHeight);
	const drawWidth = Math.max(1, Math.round(sourceWidth * scale));
	const drawHeight = Math.max(1, Math.round(sourceHeight * scale));
	const offsetX = Math.floor((knobs.normalizedWidthPx - drawWidth) / 2);
	const offsetY = Math.floor((knobs.normalizedHeightPx - drawHeight) / 2);
	const data = new Uint8Array(knobs.normalizedWidthPx * knobs.normalizedHeightPx);
	for (let y = 0; y < drawHeight; y += 1) {
		const sourceY = Math.min(
			bounds.maxY,
			bounds.minY + Math.floor(((y + 0.5) * sourceHeight) / drawHeight)
		);
		for (let x = 0; x < drawWidth; x += 1) {
			const sourceX = Math.min(
				bounds.maxX,
				bounds.minX + Math.floor(((x + 0.5) * sourceWidth) / drawWidth)
			);
			if (!sampled.data[sourceY * sampled.widthPx + sourceX]) continue;
			data[(offsetY + y) * knobs.normalizedWidthPx + (offsetX + x)] = 1;
		}
	}
	return { widthPx: knobs.normalizedWidthPx, heightPx: knobs.normalizedHeightPx, data };
}

/** Dice coefficient (2|A∩B| / (|A|+|B|)) between two same-size masks after
 * shifting `b` by (dx, dy) — 0 when either mask is empty. */
export function shiftedDice(a: NormalizedGlyphMask, b: NormalizedGlyphMask, dx: number, dy: number): number {
	let intersection = 0;
	let aCount = 0;
	let bCount = 0;
	for (let y = 0; y < a.heightPx; y += 1) {
		for (let x = 0; x < a.widthPx; x += 1) {
			const av = a.data[y * a.widthPx + x];
			const bx = x + dx;
			const by = y + dy;
			const bv =
				bx >= 0 && by >= 0 && bx < b.widthPx && by < b.heightPx
					? b.data[by * b.widthPx + bx]
					: 0;
			if (av) aCount += 1;
			if (bv) bCount += 1;
			if (av && bv) intersection += 1;
		}
	}
	if (aCount === 0 || bCount === 0) return 0;
	return (2 * intersection) / (aCount + bCount);
}

/** Best Dice score over every integer translation within +/- maxShiftPx —
 * tolerates the old classifier's small alignment jitter between a live
 * badge crop and a canonical template. */
export function bestMaskScore(
	a: NormalizedGlyphMask,
	b: NormalizedGlyphMask,
	maxShiftPx: number
): number {
	let best = 0;
	for (let dy = -maxShiftPx; dy <= maxShiftPx; dy += 1) {
		for (let dx = -maxShiftPx; dx <= maxShiftPx; dx += 1) {
			best = Math.max(best, shiftedDice(a, b, dx, dy));
		}
	}
	return best;
}

export interface BadgeGlyphTemplateEntry {
	readonly label: number;
	readonly mask: NormalizedGlyphMask;
}

export type BadgeGlyphTemplateAbstention = 'empty-glyph' | 'low-score' | 'ambiguous';

export interface BadgeGlyphTemplateClassification {
	/** Accepted label, or undefined when abstained. */
	readonly label?: number;
	/** The top-scoring label regardless of abstention, for receipts (mirrors
	 * BadgeEvidence.bestLabel's "what it would have said" contract). Absent
	 * only when there was no glyph to score at all. */
	readonly bestLabel?: number;
	readonly bestScore: number;
	readonly runnerUpScore: number;
	readonly ambiguityMargin: number;
	readonly abstention: BadgeGlyphTemplateAbstention | null;
}

/**
 * Rank an already-normalized candidate mask against the vocabulary and
 * decide accept/abstain. Split out from `classifyBadgeGlyphAgainstTemplates`
 * so the classifier's OWN self-test contract (old-stuff/tests/unit/
 * badgeGlyphClassifier.test.ts: "every canonical template classifies as
 * itself") can be exercised directly on the baked template masks
 * (assets/badge-glyph-templates.json), with no raw-pixel re-sampling
 * round-trip through a synthesized image — see
 * tests/unit/badgeGlyphTemplateMath.test.ts.
 */
export function classifyNormalizedGlyph(
	candidate: NormalizedGlyphMask | null,
	templates: readonly BadgeGlyphTemplateEntry[],
	knobs: BadgeGlyphTemplateKnobs = DEFAULT_BADGE_GLYPH_TEMPLATE_KNOBS
): BadgeGlyphTemplateClassification {
	if (!candidate) {
		return { bestScore: 0, runnerUpScore: 0, ambiguityMargin: 0, abstention: 'empty-glyph' };
	}
	const ranked = templates
		.map((template) => ({ label: template.label, score: bestMaskScore(candidate, template.mask, knobs.maxShiftPx) }))
		.sort((a, b) => b.score - a.score || a.label - b.label);
	const winner = ranked[0];
	const runnerUp = ranked[1];
	const bestScore = winner?.score ?? 0;
	const runnerUpScore = runnerUp?.score ?? 0;
	const ambiguityMargin = bestScore - runnerUpScore;
	const abstention: BadgeGlyphTemplateAbstention | null = !winner
		? 'empty-glyph'
		: bestScore < knobs.minScore
			? 'low-score'
			: ambiguityMargin < knobs.minMargin
				? 'ambiguous'
				: null;
	return {
		...(abstention === null && winner ? { label: winner.label } : {}),
		...(winner ? { bestLabel: winner.label } : {}),
		bestScore,
		runnerUpScore,
		ambiguityMargin,
		abstention
	};
}

/**
 * Classify one badge crop against the 18-template vocabulary. Structurally
 * incapable of emitting a label outside `templates` — the vocabulary
 * constraint the ledger's row 22/23 forensics found the per-digit reader
 * lacks.
 */
export function classifyBadgeGlyphAgainstTemplates(
	image: RgbaBitmap,
	badge: BadgeCropBody,
	templates: readonly BadgeGlyphTemplateEntry[],
	knobs: BadgeGlyphTemplateKnobs = DEFAULT_BADGE_GLYPH_TEMPLATE_KNOBS
): BadgeGlyphTemplateClassification {
	const candidate = normalizeBadgeGlyphMask(image, badge, knobs);
	return classifyNormalizedGlyph(candidate, templates, knobs);
}
