// Trace-only receipt and render seam for the G4 teeBorderCornerFit
// deviation. Mirrors g4.teeBadgeCompassReceipt.ts's contract: this module
// never inspects pixels and never recomputes a fit -- it partitions
// producer-stamped drawables and renders their carried testimony verbatim.

import type { Drawable, FeatureRender, FeatureRenderPlan, RunTrace, UnitTrace } from './types';

export const TEE_BORDER_CORNER_FIT_FEATURE_ID = 'teeBorderCornerFit' as const;
const UNKNOWN = 'UNKNOWN' as const;

export type BorderFitValue = number | typeof UNKNOWN;
export type BorderFitText = string | typeof UNKNOWN;

export interface BorderFitClaimRow {
	readonly ref: BorderFitText;
	readonly anchorBaskets: BorderFitText;
	readonly componentLabel: BorderFitText;
	readonly componentArea: BorderFitValue;
	readonly padX0: BorderFitValue;
	readonly padY0: BorderFitValue;
	readonly padW: BorderFitValue;
	readonly padH: BorderFitValue;
	readonly teeXPx: BorderFitValue;
	readonly teeYPx: BorderFitValue;
	readonly axisDeg: BorderFitValue;
	readonly aimBadgeId: BorderFitText;
	readonly aimBadgeLabel: BorderFitText;
	readonly aimErrorDeg: BorderFitValue;
	readonly aimRangePx: BorderFitValue;
	readonly aimRunnerUpRangePx: BorderFitValue;
	readonly aimResolved: BorderFitText;
	readonly aimRunnerUpBadgeId: BorderFitText;
	readonly aimResolutionBoundPx: BorderFitValue;
	readonly evidencePx: BorderFitValue;
	readonly occludedPx: BorderFitValue;
	readonly transitionPx: BorderFitValue;
	readonly barePx: BorderFitValue;
	readonly outlinePx: BorderFitValue;
	readonly remnantOnOutlinePx: BorderFitValue;
	readonly remnantWallAdjacentPx: BorderFitValue;
	readonly reason: string;
}

export interface BorderFitAbstentionRow {
	readonly anchorBaskets: BorderFitText;
	readonly componentLabel: BorderFitText;
	readonly why: BorderFitText;
	readonly detail: string;
}

export interface BorderFitExcludedRow {
	readonly anchorBaskets: BorderFitText;
	readonly componentLabel: BorderFitText;
	readonly why: BorderFitText;
	readonly detail: string;
}

export interface BorderFitPadDimsSummary {
	readonly longPx: BorderFitValue;
	readonly shortPx: BorderFitValue;
	readonly wallPx: BorderFitValue;
	readonly sampleSize: BorderFitValue;
	readonly minimumPadSampleSize: BorderFitValue;
	readonly isFallback: BorderFitText;
	readonly provenance: string;
}

export interface BorderFitCounts {
	readonly basketsScanned: BorderFitValue;
	readonly candidatesConsidered: BorderFitValue;
	readonly claims: BorderFitValue;
	readonly abstentions: BorderFitValue;
	readonly excluded: BorderFitValue;
}

export interface TeeBorderCornerFitReceipt {
	readonly plan: FeatureRenderPlan;
	readonly claimRows: readonly BorderFitClaimRow[];
	readonly abstentionRows: readonly BorderFitAbstentionRow[];
	readonly excludedRows: readonly BorderFitExcludedRow[];
	readonly padDims: BorderFitPadDimsSummary;
	readonly counts: BorderFitCounts;
	readonly cliText: string;
}

function nonEmpty(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function numeric(values: Drawable['values'], name: string): BorderFitValue {
	const value = values?.[name];
	return typeof value === 'number' && Number.isFinite(value) ? value : UNKNOWN;
}

function text(value: unknown): string {
	return typeof value === 'string' && value.length > 0 ? value : UNKNOWN;
}

function valueText(value: BorderFitValue): string {
	return typeof value === 'number' ? String(Number(value.toFixed(6))) : value;
}

function isClaim(drawable: Drawable): boolean {
	return drawable.type === 'polyline' && drawable.metadata?.role === 'border-claim';
}

function isAbstention(drawable: Drawable): boolean {
	return drawable.type === 'point' && drawable.metadata?.role === 'border-abstention';
}

function isExcluded(drawable: Drawable): boolean {
	return drawable.type === 'point' && drawable.metadata?.role === 'border-excluded';
}

function claimRowFor(drawable: Drawable): BorderFitClaimRow {
	const metadata = drawable.metadata ?? {};
	return {
		ref: text(drawable.ref),
		anchorBaskets: text(metadata.anchorBasketIds),
		componentLabel: text(metadata.componentLabel),
		componentArea: numeric(drawable.values, 'componentArea'),
		padX0: numeric(drawable.values, 'padX0'),
		padY0: numeric(drawable.values, 'padY0'),
		padW: numeric(drawable.values, 'padW'),
		padH: numeric(drawable.values, 'padH'),
		teeXPx: numeric(drawable.values, 'teeXPx'),
		teeYPx: numeric(drawable.values, 'teeYPx'),
		axisDeg: numeric(drawable.values, 'axisDeg'),
		aimBadgeId: text(metadata.aimBadgeId),
		aimBadgeLabel: text(metadata.aimBadgeLabel),
		aimErrorDeg: numeric(drawable.values, 'aimErrorDeg'),
		aimRangePx: numeric(drawable.values, 'aimRangePx'),
		aimRunnerUpRangePx: numeric(drawable.values, 'aimRunnerUpRangePx'),
		aimResolved: text(metadata.aimResolved),
		aimRunnerUpBadgeId: text(metadata.aimRunnerUpBadgeId),
		aimResolutionBoundPx: numeric(drawable.values, 'aimResolutionBoundPx'),
		evidencePx: numeric(drawable.values, 'evidencePx'),
		occludedPx: numeric(drawable.values, 'occludedPx'),
		transitionPx: numeric(drawable.values, 'transitionPx'),
		barePx: numeric(drawable.values, 'barePx'),
		outlinePx: numeric(drawable.values, 'outlinePx'),
		remnantOnOutlinePx: numeric(drawable.values, 'remnantOnOutlinePx'),
		remnantWallAdjacentPx: numeric(drawable.values, 'remnantWallAdjacentPx'),
		reason: text(drawable.reason)
	};
}

function abstentionRowFor(drawable: Drawable): BorderFitAbstentionRow {
	const metadata = drawable.metadata ?? {};
	return {
		anchorBaskets: text(metadata.anchorBasketIds),
		componentLabel: text(metadata.componentLabel),
		why: text(metadata.why),
		detail: text(drawable.reason)
	};
}

function excludedRowFor(drawable: Drawable): BorderFitExcludedRow {
	const metadata = drawable.metadata ?? {};
	return {
		anchorBaskets: text(metadata.anchorBasketIds),
		componentLabel: text(metadata.componentLabel),
		why: text(metadata.why),
		detail: text(drawable.reason)
	};
}

export interface BorderFitAimEligibilitySummary {
	readonly badgesOnBoard: BorderFitValue;
	readonly coveredBadges: BorderFitValue;
	readonly eligibleBadges: BorderFitValue;
	readonly detail: string;
}

function aimEligibilitySummary(unit: UnitTrace): BorderFitAimEligibilitySummary {
	const drawable = unit.drawables.find((entry) => entry.metadata?.role === 'aim-eligibility');
	return {
		badgesOnBoard: numeric(drawable?.values, 'badgesOnBoard'),
		coveredBadges: numeric(drawable?.values, 'coveredBadges'),
		eligibleBadges: numeric(drawable?.values, 'eligibleBadges'),
		detail: text(drawable?.reason)
	};
}

function padDimsSummary(unit: UnitTrace): BorderFitPadDimsSummary {
	const dims = unit.drawables.find((drawable) => drawable.metadata?.role === 'pad-dims');
	const values = dims?.values;
	return {
		longPx: numeric(values, 'longPx'),
		shortPx: numeric(values, 'shortPx'),
		wallPx: numeric(values, 'wallPx'),
		sampleSize: numeric(values, 'sampleSize'),
		minimumPadSampleSize: numeric(values, 'minimumPadSampleSize'),
		isFallback: text(dims?.metadata?.isFallback),
		provenance: text(dims?.reason)
	};
}

function measurementValue(unit: UnitTrace, name: string): BorderFitValue {
	const matches = (unit.measurements ?? []).filter((measurement) => measurement.name === name);
	if (matches.length !== 1) return UNKNOWN;
	const value = matches[0].sum;
	return typeof value === 'number' && Number.isFinite(value) ? value : UNKNOWN;
}

function countsFor(unit: UnitTrace): BorderFitCounts {
	return {
		basketsScanned: measurementValue(unit, 'basketsScanned'),
		candidatesConsidered: measurementValue(unit, 'candidatesConsidered'),
		claims: measurementValue(unit, 'claims'),
		abstentions: measurementValue(unit, 'abstentions'),
		excluded: measurementValue(unit, 'excluded')
	};
}

function cliLines(
	run: RunTrace,
	unit: UnitTrace,
	padDims: BorderFitPadDimsSummary,
	aimEligibility: BorderFitAimEligibilitySummary,
	counts: BorderFitCounts,
	claimRows: readonly BorderFitClaimRow[],
	abstentionRows: readonly BorderFitAbstentionRow[],
	excludedRows: readonly BorderFitExcludedRow[]
): string[] {
	const lines = [
		'TEE BORDER CORNER FIT',
		`runId=${nonEmpty(run.runId) ?? UNKNOWN}`,
		`imageId=${nonEmpty(run.imageId) ?? UNKNOWN}`,
		`paramsHash=${nonEmpty(run.paramsHash) ?? UNKNOWN}`,
		`featureId=${nonEmpty(unit.featureId) ?? UNKNOWN}`,
		`traceHash=${nonEmpty(run.traceHash) ?? UNKNOWN}`,
		'occluder model: basket ink (dark mask) + basket glyph WHITE FILL by component label; ' +
			'glyph fill is never pad evidence',
		'',
		'COURSE PAD DIMS',
		`longPx=${valueText(padDims.longPx)} shortPx=${valueText(padDims.shortPx)} ` +
			`wallPx=${valueText(padDims.wallPx)} sampleSize=${valueText(padDims.sampleSize)} ` +
			`minimumPadSampleSize=${valueText(padDims.minimumPadSampleSize)} isFallback=${padDims.isFallback}`,
		`provenance: ${padDims.provenance}`,
		'',
		'AIM ELIGIBILITY',
		`badgesOnBoard=${valueText(aimEligibility.badgesOnBoard)} ` +
			`coveredByVisibleTestimony=${valueText(aimEligibility.coveredBadges)} ` +
			`eligible=${valueText(aimEligibility.eligibleBadges)}`,
		`detail: ${aimEligibility.detail}`,
		'',
		`basketsScanned=${valueText(counts.basketsScanned)} ` +
			`candidatesConsidered=${valueText(counts.candidatesConsidered)} ` +
			`claims=${valueText(counts.claims)} abstentions=${valueText(counts.abstentions)} ` +
			`excluded=${valueText(counts.excluded)}`,
		'',
		'CLAIMS',
		'anchorBaskets | component | area | pad[x0,y0 wxh] | center | axisDeg | aim | aimErrDeg | ' +
			'aimStatus | outline ev/occ/trans/BARE of total | remnant on/adj'
	];
	for (const row of claimRows) {
		lines.push(
			[
				row.anchorBaskets,
				row.componentLabel,
				valueText(row.componentArea),
				`[${valueText(row.padX0)},${valueText(row.padY0)} ${valueText(row.padW)}x${valueText(row.padH)}]`,
				`(${valueText(row.teeXPx)},${valueText(row.teeYPx)})`,
				valueText(row.axisDeg),
				`${row.aimBadgeId}${row.aimBadgeLabel === UNKNOWN ? '' : `(label ${row.aimBadgeLabel})`}`,
				valueText(row.aimErrorDeg),
				row.aimResolved === 'false'
					? `UNRESOLVED vs ${row.aimRunnerUpBadgeId}: ranges ${valueText(row.aimRangePx)} / ` +
						`${valueText(row.aimRunnerUpRangePx)}px, gap under one pad length ` +
						`(${valueText(row.aimResolutionBoundPx)}px)`
					: `resolved (range ${valueText(row.aimRangePx)}px, next claimant ` +
						`${valueText(row.aimRunnerUpRangePx)}px)`,
				`${valueText(row.evidencePx)}/${valueText(row.occludedPx)}/${valueText(row.transitionPx)}/` +
					`${valueText(row.barePx)} of ${valueText(row.outlinePx)}`,
				`${valueText(row.remnantOnOutlinePx)}/${valueText(row.remnantWallAdjacentPx)}`
			].join(' | ')
		);
	}
	if (claimRows.length === 0) lines.push('(none)');
	lines.push('', 'NAMED ABSTENTIONS', 'anchorBaskets | component | why | detail');
	for (const row of abstentionRows) {
		lines.push(`${row.anchorBaskets} | ${row.componentLabel} | ${row.why} | ${row.detail}`);
	}
	if (abstentionRows.length === 0) lines.push('(none)');
	lines.push('', 'EXCLUDED BORDER-ADJACENT COMPONENTS', 'anchorBaskets | component | why | detail');
	for (const row of excludedRows) {
		lines.push(`${row.anchorBaskets} | ${row.componentLabel} | ${row.why} | ${row.detail}`);
	}
	if (excludedRows.length === 0) lines.push('(none)');
	return lines;
}

function planFor(
	unit: UnitTrace,
	run: RunTrace,
	claims: readonly Drawable[],
	cliText: string
): FeatureRenderPlan {
	return {
		title: `G4 Tee border corner fit (${run.configName})`,
		base: 'badgeStage.masks.bright',
		layers: [
			{
				name: 'Border corner-fit pad claims (closed rectangles)',
				note:
					'each rectangle is the course-median pad anchored to a border remnant with zero ' +
					'contradictions; the outline accounting (evidence/occluded/transition/bare) is carried ' +
					'on the drawable verbatim.',
				drawables: claims
			}
		],
		notes: [
			`feature: ${TEE_BORDER_CORNER_FIT_FEATURE_ID} -- ${unit.gate}, trace unit '${unit.id}'`,
			'presentation style is applied by the shared Sweep integration; this feature declares no paint policy.',
			'exact geometry contract: no interpolation, refit, or pixel read occurs here; every drawable is producer-emitted.',
			...cliText.split('\n')
		]
	};
}

/** Build the CLI/visual receipt pair from one teeBorderCornerFit UnitTrace. */
export function buildTeeBorderCornerFitReceipt(
	unit: UnitTrace,
	run: RunTrace
): TeeBorderCornerFitReceipt {
	const claimDrawables = unit.drawables.filter(isClaim);
	const claimRows = claimDrawables.map(claimRowFor);
	const abstentionRows = unit.drawables.filter(isAbstention).map(abstentionRowFor);
	const excludedRows = unit.drawables.filter(isExcluded).map(excludedRowFor);
	const padDims = padDimsSummary(unit);
	const aimEligibility = aimEligibilitySummary(unit);
	const counts = countsFor(unit);
	const cliText = cliLines(
		run,
		unit,
		padDims,
		aimEligibility,
		counts,
		claimRows,
		abstentionRows,
		excludedRows
	).join('\n');
	const plan = planFor(unit, run, claimDrawables, cliText);
	return { plan, claimRows, abstentionRows, excludedRows, padDims, counts, cliText };
}

/** FeatureRender seam: one exact forwarded layer over the bright-mask base. */
export const TEE_BORDER_CORNER_FIT_RENDER: FeatureRender = {
	units: [TEE_BORDER_CORNER_FIT_FEATURE_ID],
	draw(unit, run) {
		return buildTeeBorderCornerFitReceipt(unit, run).plan;
	}
};
