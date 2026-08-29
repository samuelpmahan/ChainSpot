// Trace-only CLI/visual receipt for G1 badgeGlyphTemplate. This module reads
// only Drawable/UnitTrace/RunTrace testimony the producer already stamped
// (g1.badgeGlyphTemplate.ts) -- it never recomputes a score, a label, or a
// verdict. Disagreements are the headline: they get their own labeled block
// so a reviewer cannot miss one by skimming.

import type { Drawable, FeatureRender, FeatureRenderPlan, RunTrace, UnitTrace } from './types';

export const BADGE_GLYPH_TEMPLATE_FEATURE_ID = 'badgeGlyphTemplate' as const;
const UNKNOWN = 'UNKNOWN' as const;

export type BadgeGlyphTemplateReceiptValue = number | typeof UNKNOWN;
export type BadgeGlyphTemplateReceiptText = string | typeof UNKNOWN;

export interface BadgeGlyphTemplateReceiptRow {
	readonly badgeId: BadgeGlyphTemplateReceiptText;
	readonly currentLabel: BadgeGlyphTemplateReceiptText;
	readonly currentConfidence: BadgeGlyphTemplateReceiptText;
	readonly templateLabel: BadgeGlyphTemplateReceiptText;
	readonly templateBestLabel: BadgeGlyphTemplateReceiptText;
	readonly templateScore: BadgeGlyphTemplateReceiptValue;
	readonly templateMargin: BadgeGlyphTemplateReceiptValue;
	readonly templateAbstention: BadgeGlyphTemplateReceiptText;
	readonly agreement: BadgeGlyphTemplateReceiptText;
	readonly verdict: Drawable['verdict'];
	readonly reason: string;
}

export interface BadgeGlyphTemplateReceiptCounts {
	readonly badges: BadgeGlyphTemplateReceiptValue;
	readonly agree: BadgeGlyphTemplateReceiptValue;
	readonly disagree: BadgeGlyphTemplateReceiptValue;
	readonly templateAbstained: BadgeGlyphTemplateReceiptValue;
	readonly readerAbstained: BadgeGlyphTemplateReceiptValue;
	readonly bothAbstained: BadgeGlyphTemplateReceiptValue;
}

export interface BadgeGlyphTemplateReceipt {
	readonly plan: FeatureRenderPlan;
	readonly rows: readonly BadgeGlyphTemplateReceiptRow[];
	readonly disagreementRows: readonly BadgeGlyphTemplateReceiptRow[];
	readonly counts: BadgeGlyphTemplateReceiptCounts;
	readonly cliText: string;
}

function isVerdictDrawable(drawable: Drawable): boolean {
	return (
		drawable.type === 'point' &&
		(drawable as unknown as { readonly visualRole?: string }).visualRole ===
			'badge-glyph-template-verdict'
	);
}

function finite(values: Drawable['values'], name: string): BadgeGlyphTemplateReceiptValue {
	const value = values?.[name];
	return typeof value === 'number' && Number.isFinite(value) ? value : UNKNOWN;
}

function valueText(value: BadgeGlyphTemplateReceiptValue): string {
	return typeof value === 'number' ? String(Number(value.toFixed(6))) : value;
}

function holeText(value: BadgeGlyphTemplateReceiptValue): string {
	return typeof value === 'number' ? `H${value}` : UNKNOWN;
}

/** `row.currentLabel`/`templateLabel`/`templateBestLabel` carry the
 * producer's own sentinel text ('UNREAD', 'ABSTAIN', 'UNKNOWN') when there
 * is no numeric hole to show; only a real digit string is ever rendered as
 * `H<n>`, so an abstention/UNREAD cell prints its own honest word instead of
 * `Number('ABSTAIN')`'s `NaN`. */
function holeOrText(value: BadgeGlyphTemplateReceiptText): string {
	const n = Number(value);
	return Number.isFinite(n) ? holeText(n) : value;
}

function text(value: unknown): string {
	return typeof value === 'string' && value.length > 0 ? value : UNKNOWN;
}

function abstentionText(code: BadgeGlyphTemplateReceiptValue): BadgeGlyphTemplateReceiptText {
	if (code === 0) return 'none';
	if (code === 1) return 'empty-glyph';
	if (code === 2) return 'low-score';
	if (code === 3) return 'ambiguous';
	return UNKNOWN;
}

function agreementText(code: BadgeGlyphTemplateReceiptValue): BadgeGlyphTemplateReceiptText {
	if (code === 0) return 'agree';
	if (code === 1) return 'disagree';
	if (code === 2) return 'templateAbstained';
	if (code === 3) return 'readerAbstained';
	if (code === 4) return 'bothAbstained';
	return UNKNOWN;
}

function readerConfidenceText(
	confidence: number | undefined,
	fillFraction: number | undefined
): BadgeGlyphTemplateReceiptValue {
	if (typeof confidence === 'number') {
		if (Number.isFinite(confidence)) {
			return confidence;
		} else if (typeof fillFraction === 'number' && Number.isFinite(fillFraction)) {
			return fillFraction;
		}
	}
	return UNKNOWN;
}

function rowFor(drawable: Drawable): BadgeGlyphTemplateReceiptRow {
	const metadata = drawable.metadata ?? {};
	const readerConfidence = (drawable.values?.readerConfidence as number | undefined) ?? undefined;
	const readerFillFraction = (drawable.values?.readerFillFraction as number | undefined) ?? undefined;
	const confidenceValue = readerConfidenceText(readerConfidence, readerFillFraction);
	const currentConfidence: BadgeGlyphTemplateReceiptText =
		typeof confidenceValue === 'number'
			? Number.isFinite(readerConfidence ?? NaN)
				? String(Number(readerConfidence!.toFixed(6)))
				: typeof readerFillFraction === 'number'
					? `fill=${Number(readerFillFraction.toFixed(6))}`
					: UNKNOWN
			: UNKNOWN;
	return {
		badgeId: text(metadata.badgeId ?? drawable.ref),
		currentLabel: text(metadata.currentLabel),
		currentConfidence,
		templateLabel: text(metadata.templateLabel),
		templateBestLabel: text(metadata.templateBestLabel),
		templateScore: finite(drawable.values, 'templateScore'),
		templateMargin: finite(drawable.values, 'templateMargin'),
		templateAbstention: abstentionText(finite(drawable.values, 'templateAbstentionCode')),
		agreement: agreementText(finite(drawable.values, 'agreementCode')),
		verdict: drawable.verdict,
		reason: text(drawable.reason)
	};
}

function verdictDrawables(unit: UnitTrace): readonly Drawable[] {
	return unit.drawables.filter(isVerdictDrawable);
}

function measurementValue(unit: UnitTrace, name: string): BadgeGlyphTemplateReceiptValue {
	const matches = (unit.measurements ?? []).filter((measurement) => measurement.name === name);
	if (matches.length !== 1) return UNKNOWN;
	const value = matches[0].sum;
	return typeof value === 'number' && Number.isFinite(value) ? value : UNKNOWN;
}

function countsFor(unit: UnitTrace): BadgeGlyphTemplateReceiptCounts {
	return {
		badges: measurementValue(unit, 'badges'),
		agree: measurementValue(unit, 'agree'),
		disagree: measurementValue(unit, 'disagree'),
		templateAbstained: measurementValue(unit, 'templateAbstained'),
		readerAbstained: measurementValue(unit, 'readerAbstained'),
		bothAbstained: measurementValue(unit, 'bothAbstained')
	};
}

function cliRows(
	run: RunTrace,
	unit: UnitTrace,
	counts: BadgeGlyphTemplateReceiptCounts,
	rows: readonly BadgeGlyphTemplateReceiptRow[],
	disagreements: readonly BadgeGlyphTemplateReceiptRow[]
): string[] {
	const header =
		'badgeId | currentLabel | currentConfidence | templateLabel | templateBestLabel | score | margin | abstention | agreement | verdict | reason';
	const lines = [
		'G1 BADGE-GLYPH-TEMPLATE vs CURRENT READER',
		`runId=${text(run.runId)}`,
		`imageId=${text(run.imageId)}`,
		`paramsHash=${text(run.paramsHash)}`,
		`featureId=${text(unit.featureId)}`,
		`config=${text(run.configName)}`,
		`badges=${valueText(counts.badges)}`,
		`agree=${valueText(counts.agree)}`,
		`disagree=${valueText(counts.disagree)}`,
		`templateAbstained=${valueText(counts.templateAbstained)}`,
		`readerAbstained=${valueText(counts.readerAbstained)}`,
		`bothAbstained=${valueText(counts.bothAbstained)}`,
		header
	];
	for (const row of rows) {
		lines.push(
			[
				row.badgeId,
				holeOrText(row.currentLabel),
				row.currentConfidence,
				holeOrText(row.templateLabel),
				holeOrText(row.templateBestLabel),
				valueText(row.templateScore),
				valueText(row.templateMargin),
				row.templateAbstention,
				row.agreement,
				row.verdict,
				row.reason
			].join(' | ')
		);
	}
	if (disagreements.length > 0) {
		lines.push(
			'',
			`DISAGREEMENTS (${disagreements.length}) -- named loudly, never fudged:`
		);
		for (const row of disagreements) {
			lines.push(
				`  badge ${row.badgeId}: current reader says ${row.currentLabel} ` +
					`(confidence=${row.currentConfidence}), ` +
					`template says ${row.templateLabel} at score=${valueText(row.templateScore)} ` +
					`margin=${valueText(row.templateMargin)}`
			);
		}
	} else {
		lines.push('', 'DISAGREEMENTS: none.');
	}
	return lines;
}

function planFor(unit: UnitTrace, run: RunTrace, verdicts: readonly Drawable[], cliText: string): FeatureRenderPlan {
	const accepted = verdicts.filter((d) => d.verdict === 'accepted');
	const rejected = verdicts.filter((d) => d.verdict === 'rejected');
	const info = verdicts.filter((d) => d.verdict === 'info');
	return {
		title: `G1 badgeGlyphTemplate -- whole-glyph template vs per-digit reader (${run.configName})`,
		layers: [
			{
				name: 'agreements (green)',
				note: 'both readers emitted the same label',
				drawables: accepted
			},
			{
				name: 'disagreements (red) -- LOUD',
				note: 'both readers emitted a label and they differ; neither reading is overwritten',
				drawables: rejected
			},
			{
				name: 'abstentions (info)',
				note: 'one or both sides abstained; abstaining side is named in the reason',
				drawables: info
			}
		],
		notes: [
			`feature: ${BADGE_GLYPH_TEMPLATE_FEATURE_ID} -- ${unit.gate}, trace unit '${unit.id}'`,
			`unit enabled: ${unit.enabled} (source: UnitTrace.enabled)`,
			'Semantics: this feature never overwrites BadgeEvidence.label; it publishes an independent read for comparison.',
			...cliText.split('\n')
		]
	};
}

/** Build the CLI/visual receipt pair from one badgeGlyphTemplate UnitTrace. */
export function buildBadgeGlyphTemplateReceipt(unit: UnitTrace, run: RunTrace): BadgeGlyphTemplateReceipt {
	const verdictDs = verdictDrawables(unit);
	const rows = verdictDs.map(rowFor);
	const disagreementRows = rows.filter((row) => row.agreement === 'disagree');
	const counts = countsFor(unit);
	const cliText = cliRows(run, unit, counts, rows, disagreementRows).join('\n');
	const plan = planFor(unit, run, verdictDs, cliText);
	return { plan, rows, disagreementRows, counts, cliText };
}

/** FeatureRender seam: producer drawables are forwarded unchanged. */
export const badgeGlyphTemplateRender: FeatureRender = {
	units: [BADGE_GLYPH_TEMPLATE_FEATURE_ID],
	draw(unit, run) {
		return buildBadgeGlyphTemplateReceipt(unit, run).plan;
	}
};
