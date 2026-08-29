/**
 * G1 badgeGlyphTemplate — default-OFF whole-glyph Dice-template classifier,
 * run alongside (never replacing) the current per-digit segmentation reader.
 *
 * Mission (owner, near-verbatim): "put the thing in an ABFeature and test
 * it -- isn't that the entire point of ABF?" The "thing" is the pre-rebuild
 * whole-glyph badge classifier docs/CLAIMS-LEDGER.md row 23 (UPHELD)
 * resurrected as a standalone harness (scripts/chainspot-lab/
 * legacyBadgeClassifier/, now deleted -- its evidence lives in the ledger,
 * not in a lab surface) and, per the ledger's standing docket, given a
 * permanent lane here as a real ABFeature.
 *
 * When OFF (the default): this unit is not even present in a default
 * execution list (see configs/default.json vs configs/
 * badge-glyph-template-on.json) -- zero behavior change, by absence, exactly
 * like teeMinAreaPose/teeBadgeLock.
 *
 * When ON: for every badge the current reader already produced
 * (`board.get('badges')`), this feature independently classifies the SAME
 * on-image badge bbox against the SAME `localImage` raster the current
 * reader's `extractBadgeGlyph`/`readBadge` pipeline consumes (measure.ts's
 * `makeBadges` -> `readCourseBadges` -> `readBadge`), using the ported
 * whole-glyph template matcher (`../digits/badgeGlyphTemplateMath.ts`). It
 * NEVER writes back into `badges` or `BadgeEvidence.label` -- the current
 * reader's read stands unmodified. It publishes, per badge: the template's
 * own label (or abstention), its best-guess label, its Dice score and
 * ambiguity margin, and an explicit agreement verdict against the current
 * reader's read. A disagreement is `verdict: 'rejected'` (loud), an
 * agreement is `verdict: 'accepted'`, and any abstention on either side is
 * `verdict: 'info'` with the abstaining side named -- never silently folded
 * into agreement or disagreement.
 */

import templateAssetData from '../assets/badge-glyph-templates.json';
import type { BadgeEvidence, RgbaImage, Viewport } from '../types';
import {
	classifyBadgeGlyphAgainstTemplates,
	DEFAULT_BADGE_GLYPH_TEMPLATE_KNOBS,
	type BadgeCropBody,
	type BadgeGlyphTemplateClassification,
	type BadgeGlyphTemplateEntry,
	type BadgeGlyphTemplateKnobs,
	type RgbaBitmap
} from '../digits/badgeGlyphTemplateMath';
import { badgeGlyphTemplateRender } from './g1.badgeGlyphTemplateReceipt';
import type { ABFeature, EngineUnit, EvidenceBoard, FeatureContext } from './types';

interface BadgeGlyphTemplateAsset {
	readonly schema: string;
	readonly sourceCommit: string;
	readonly normalizedWidthPx: number;
	readonly normalizedHeightPx: number;
	readonly templates: readonly { readonly label: number; readonly rows: readonly string[] }[];
}

const ASSET = templateAssetData as BadgeGlyphTemplateAsset;

// Standing tripwire (same shape as g1.digits.ts's MODEL_FEATURE_COUNT check):
// fails at registry import time, before any config is parsed, if the baked
// asset's own dimensions ever drift from what this file assumes.
if (ASSET.normalizedWidthPx !== DEFAULT_BADGE_GLYPH_TEMPLATE_KNOBS.normalizedWidthPx) {
	throw new Error(
		`g1.badgeGlyphTemplate: assets/badge-glyph-templates.json normalizedWidthPx=` +
			`${ASSET.normalizedWidthPx}, expected ${DEFAULT_BADGE_GLYPH_TEMPLATE_KNOBS.normalizedWidthPx} ` +
			`-- the baked asset and the runtime normalizer have drifted out of sync; re-bake with ` +
			`scripts/generate-badge-glyph-templates.mjs or update the knob together, not separately.`
	);
}
if (ASSET.normalizedHeightPx !== DEFAULT_BADGE_GLYPH_TEMPLATE_KNOBS.normalizedHeightPx) {
	throw new Error(
		`g1.badgeGlyphTemplate: assets/badge-glyph-templates.json normalizedHeightPx=` +
			`${ASSET.normalizedHeightPx}, expected ${DEFAULT_BADGE_GLYPH_TEMPLATE_KNOBS.normalizedHeightPx} ` +
			`-- see the normalizedWidthPx tripwire above for the fix.`
	);
}
if (ASSET.templates.length !== 18) {
	throw new Error(
		`g1.badgeGlyphTemplate: assets/badge-glyph-templates.json carries ` +
			`${ASSET.templates.length} templates, expected the fixed 1..18 vocabulary.`
	);
}

/** Parsed once at import time: the baked rows (0/1 char strings) decoded to
 * Uint8Array masks, in template-label order. */
export const BADGE_GLYPH_TEMPLATES: readonly BadgeGlyphTemplateEntry[] = ASSET.templates
	.map((template) => ({
		label: template.label,
		mask: {
			widthPx: ASSET.normalizedWidthPx,
			heightPx: ASSET.normalizedHeightPx,
			data: Uint8Array.from(
				template.rows.join('').split('').map((ch) => (ch === '1' ? 1 : 0))
			)
		}
	}))
	.sort((a, b) => a.label - b.label);

export const badgeGlyphTemplateFeature = {
	id: 'badgeGlyphTemplate',
	gate: 'G1',
	kind: 'deviation',
	defaultEnabled: false,
	resolveOnlyWhenConfigured: true,
	note:
		'Whole-glyph Dice-coefficient template classifier (docs/CLAIMS-LEDGER.md row 23) run ' +
		'alongside the current per-digit reader for comparison; never overwrites BadgeEvidence.label.',
	render: badgeGlyphTemplateRender,
	knobs: {
		minScore: {
			default: DEFAULT_BADGE_GLYPH_TEMPLATE_KNOBS.minScore,
			note:
				"old system's empirical value (badgeGlyphClassifier.ts DEFAULTS.minScore) carried as-is; " +
				'proven on the full Dev6 corpus by the ledger row 23 head-to-head. Below this Dice score ' +
				"the best-matching template is rejected outright ('low-score' abstention)."
		},
		minMargin: {
			default: DEFAULT_BADGE_GLYPH_TEMPLATE_KNOBS.minMargin,
			note:
				"old system's empirical value (DEFAULTS.minMargin), same provenance as g1.digits' " +
				"labelAmbiguityMargin (inherited from this same source). Below this Dice-score gap between " +
				"the best and second-best template, the read abstains as 'ambiguous' rather than guessing."
		},
		foregroundThreshold: {
			default: DEFAULT_BADGE_GLYPH_TEMPLATE_KNOBS.foregroundThreshold,
			note:
				"old system's empirical value (DEFAULTS.foregroundThreshold): minimum grayscale channel " +
				'value for a sampled pixel to count as bright/printed-glyph foreground.'
		},
		maxShiftPx: {
			default: DEFAULT_BADGE_GLYPH_TEMPLATE_KNOBS.maxShiftPx,
			note:
				"old system's empirical value (DEFAULTS.maxShiftPx): integer-pixel search window for the " +
				'best translation alignment before scoring Dice against each template.'
		}
	}
} satisfies ABFeature;

export interface BadgeGlyphTemplateVerdict {
	readonly badgeId: string;
	/** Current per-digit reader's accepted label (null when UNREAD/abstained/collision). */
	readonly currentLabel: string | null;
	/** Template classifier's accepted label (null when it abstained). */
	readonly templateLabel: string | null;
	/** Template classifier's top candidate regardless of its own abstention. */
	readonly templateBestLabel: string | null;
	readonly templateScore: number;
	readonly templateMargin: number;
	readonly templateAbstention: BadgeGlyphTemplateClassification['abstention'];
	/** Current reader's classifier margin (BadgeEvidence.confidence), or Infinity
	 * when no digits were scored (in which case readerFillFraction exists instead). */
	readonly readerConfidence: number;
	/** Current reader's geometric fill fraction (BadgeEvidence.fillFraction) when
	 * readerConfidence is Infinity; undefined otherwise. */
	readonly readerFillFraction?: number;
	/**
	 * 'agree'      both sides emitted the same label.
	 * 'disagree'   both sides emitted a label and they differ -- loud finding.
	 * 'templateAbstained'  reader has a label, template abstained.
	 * 'readerAbstained'    template has a label, reader abstained/UNREAD.
	 * 'bothAbstained'      neither side emitted a label.
	 */
	readonly agreement: 'agree' | 'disagree' | 'templateAbstained' | 'readerAbstained' | 'bothAbstained';
}

function agreementOf(
	currentLabel: string | null,
	templateLabel: string | null
): BadgeGlyphTemplateVerdict['agreement'] {
	if (currentLabel !== null && templateLabel !== null) {
		return currentLabel === templateLabel ? 'agree' : 'disagree';
	}
	if (currentLabel !== null) return 'templateAbstained';
	if (templateLabel !== null) return 'readerAbstained';
	return 'bothAbstained';
}

/**
 * `BadgeEvidence.bbox` is in ORIGINAL-image (canonical, viewport-independent)
 * coordinates (measure.ts's `makeBadges` doc comment: "digit reading + label
 * candidates, original-image coordinates" -- every badge field is shifted by
 * `+viewportTopPx`). `localImage`, the SAME raster the current reader's
 * `extractBadgeGlyph`/`readBadge` pipeline consumes, is the viewport-cropped
 * LOCAL raster (measure.ts: `board.set('localImage', cropImage(image, topPx,
 * bottomPx))`). Sampling `localImage` at a badge's original-image bbox
 * without undoing that shift would silently sample the wrong rows whenever
 * `topPx > 0` -- so `viewportTopPx` is subtracted here before cropping,
 * exactly undoing the shift `makeBadges` applied when producing the bbox in
 * the first place.
 */
function cropBodyFor(badge: BadgeEvidence, viewportTopPx: number): BadgeCropBody {
	const [x, y, w, h] = badge.bbox;
	return { xPx: x + w / 2, yPx: y + h / 2 - viewportTopPx, widthPx: w, heightPx: h };
}

/**
 * The ABFeature only exposes the 4 genuinely tunable knobs (minScore/
 * minMargin/foregroundThreshold/maxShiftPx); normalizedWidthPx/HeightPx are
 * NOT knobs (they are fixed by the baked template asset's own dimensions,
 * checked by the tripwire above) and so are never present in
 * `ctx.resolve().knobs`. Merging them back in here -- rather than only
 * relying on `classifyBadgeGlyphAgainstTemplates`'s default PARAMETER, which
 * a caller passing an explicit (partial) knobs object bypasses -- is
 * required: without it the normalizer's canvas-size math silently computes
 * NaN, `new Uint8Array(NaN)` clamps to a zero-length array (ECMAScript
 * ToIndex), and every Dice score below zeroes out to 0 for every badge.
 */
function knobsOf(ctx: FeatureContext): BadgeGlyphTemplateKnobs {
	const resolved = ctx.resolve(badgeGlyphTemplateFeature).knobs as Partial<BadgeGlyphTemplateKnobs>;
	return {
		...DEFAULT_BADGE_GLYPH_TEMPLATE_KNOBS,
		...resolved,
		normalizedWidthPx: DEFAULT_BADGE_GLYPH_TEMPLATE_KNOBS.normalizedWidthPx,
		normalizedHeightPx: DEFAULT_BADGE_GLYPH_TEMPLATE_KNOBS.normalizedHeightPx
	};
}

/** Runtime entry point shared by the EngineUnit below and unit tests: pure
 * function over one badge + the raster it was detected in. */
export function classifyBadgeAgainstTemplates(
	image: RgbaBitmap,
	badge: BadgeEvidence,
	viewportTopPx = 0,
	knobs: BadgeGlyphTemplateKnobs = DEFAULT_BADGE_GLYPH_TEMPLATE_KNOBS
): BadgeGlyphTemplateVerdict {
	const classification = classifyBadgeGlyphAgainstTemplates(
		image,
		cropBodyFor(badge, viewportTopPx),
		BADGE_GLYPH_TEMPLATES,
		knobs
	);
	const templateLabel = classification.label !== undefined ? String(classification.label) : null;
	const templateBestLabel =
		classification.bestLabel !== undefined ? String(classification.bestLabel) : null;
	return {
		badgeId: badge.detId,
		currentLabel: badge.label,
		templateLabel,
		templateBestLabel,
		templateScore: classification.bestScore,
		templateMargin: classification.ambiguityMargin,
		templateAbstention: classification.abstention,
		readerConfidence: badge.confidence,
		readerFillFraction: badge.fillFraction,
		agreement: agreementOf(badge.label, templateLabel)
	};
}

function abstentionCode(reason: BadgeGlyphTemplateClassification['abstention']): number {
	if (reason === null) return 0;
	if (reason === 'empty-glyph') return 1;
	if (reason === 'low-score') return 2;
	return 3; // 'ambiguous'
}

function agreementCode(agreement: BadgeGlyphTemplateVerdict['agreement']): number {
	switch (agreement) {
		case 'agree':
			return 0;
		case 'disagree':
			return 1;
		case 'templateAbstained':
			return 2;
		case 'readerAbstained':
			return 3;
		case 'bothAbstained':
			return 4;
	}
}

function drawableVerdict(agreement: BadgeGlyphTemplateVerdict['agreement']): 'accepted' | 'rejected' | 'info' {
	if (agreement === 'agree') return 'accepted';
	if (agreement === 'disagree') return 'rejected';
	return 'info';
}

function reasonFor(verdict: BadgeGlyphTemplateVerdict): string {
	const current = verdict.currentLabel ?? 'UNREAD';
	const template = verdict.templateLabel ?? `ABSTAIN(${verdict.templateAbstention ?? 'unknown'})`;
	switch (verdict.agreement) {
		case 'agree':
			return `template agrees with current reader: both read hole ${current}`;
		case 'disagree':
			return (
				`DISAGREEMENT: current reader read ${current}, template classifier read ${template} ` +
				`(score=${verdict.templateScore.toFixed(4)}, margin=${verdict.templateMargin.toFixed(4)}) -- ` +
				`neither reading is overwritten; both are receipted`
			);
		case 'templateAbstained':
			return (
				`template ABSTAINED (${verdict.templateAbstention}) where current reader read ${current}; ` +
				`template best-guess was ${verdict.templateBestLabel ?? 'UNKNOWN'}`
			);
		case 'readerAbstained':
			return `current reader is UNREAD/abstained; template classifier read ${template}`;
		case 'bothAbstained':
			return `both sides ABSTAINED -- current reader UNREAD, template ${template}`;
	}
}

/** Default-OFF G1 deviation: independent evidence alongside the current
 * reader, never a replacement. Absent from a config's `execution` list, this
 * unit does not run at all (same "absence, not merely disabled" contract as
 * teeMinAreaPose/teeBadgeLock). */
export const badgeGlyphTemplateUnit: EngineUnit = {
	id: 'badgeGlyphTemplate',
	gate: 'G1',
	consumes: ['localImage', 'badges', 'viewport'],
	produces: ['badgeGlyphTemplate'],
	note:
		'default-OFF whole-glyph Dice-template classification of every G1 badge, published alongside ' +
		'(never overwriting) the current per-digit reader; publishes an explicit agreement verdict.',
	run(board: EvidenceBoard, ctx: FeatureContext) {
		const stop = ctx.span('badgeGlyphTemplate');
		const badges = board.get<readonly BadgeEvidence[]>('badges');
		const state = ctx.resolve(badgeGlyphTemplateFeature);
		if (!state.enabled) {
			board.set('badgeGlyphTemplate', [] as readonly BadgeGlyphTemplateVerdict[]);
			stop();
			return;
		}
		const image = board.get<RgbaImage>('localImage');
		const { topPx } = board.get<Viewport>('viewport');
		const knobs = knobsOf(ctx);
		const bitmap: RgbaBitmap = { width: image.width, height: image.height, data: image.data };

		const verdicts: BadgeGlyphTemplateVerdict[] = [];
		let agree = 0;
		let disagree = 0;
		let templateAbstained = 0;
		let readerAbstained = 0;
		let bothAbstained = 0;
		for (const badge of badges) {
			const verdict = classifyBadgeAgainstTemplates(bitmap, badge, topPx, knobs);
			verdicts.push(verdict);
			if (verdict.agreement === 'agree') agree++;
			else if (verdict.agreement === 'disagree') disagree++;
			else if (verdict.agreement === 'templateAbstained') templateAbstained++;
			else if (verdict.agreement === 'readerAbstained') readerAbstained++;
			else bothAbstained++;

			ctx.overlay('badgeGlyphTemplate', {
				type: 'point',
				xPx: badge.cxPx,
				yPx: badge.cyPx,
				verdict: drawableVerdict(verdict.agreement),
				visualRole: 'badge-glyph-template-verdict',
				ref: verdict.badgeId,
				reason: reasonFor(verdict),
				values: {
					agreementCode: agreementCode(verdict.agreement),
					templateScore: verdict.templateScore,
					templateMargin: verdict.templateMargin,
					templateAbstentionCode: abstentionCode(verdict.templateAbstention),
					readerConfidence: verdict.readerConfidence,
					...(Number.isFinite(verdict.readerConfidence) ? {} : { readerFillFraction: verdict.readerFillFraction }),
					...(verdict.currentLabel !== null ? { currentLabel: Number(verdict.currentLabel) } : {}),
					...(verdict.templateLabel !== null ? { templateLabel: Number(verdict.templateLabel) } : {}),
					...(verdict.templateBestLabel !== null
						? { templateBestLabel: Number(verdict.templateBestLabel) }
						: {})
				},
				metadata: {
					role: 'target',
					badgeId: verdict.badgeId,
					agreement: verdict.agreement,
					currentLabel: verdict.currentLabel ?? 'UNREAD',
					templateLabel: verdict.templateLabel ?? 'ABSTAIN',
					templateBestLabel: verdict.templateBestLabel ?? 'UNKNOWN',
					templateAbstention: verdict.templateAbstention ?? 'none'
				}
			});
		}
		ctx.measure('badgeGlyphTemplate', 'badges', badges.length);
		ctx.measure('badgeGlyphTemplate', 'agree', agree);
		ctx.measure('badgeGlyphTemplate', 'disagree', disagree);
		ctx.measure('badgeGlyphTemplate', 'templateAbstained', templateAbstained);
		ctx.measure('badgeGlyphTemplate', 'readerAbstained', readerAbstained);
		ctx.measure('badgeGlyphTemplate', 'bothAbstained', bothAbstained);
		board.set('badgeGlyphTemplate', verdicts);
		stop();
	}
};
