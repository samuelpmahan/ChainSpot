// Trace-only receipt and render seam for the G4 teeBadgeCompass deviation.
//
// The teeBadgeCompass producer owns every geometry row, sigma derivation,
// pose-quality measurement, matching decision, and drawable. This module
// never inspects pixels, never reads baskets/assignment, and never
// recomputes a bearing, an angle, or a pose-quality flag -- it partitions
// producer-stamped drawables and renders their carried testimony verbatim,
// mirroring g4.teeBadgeLockReceipt.ts's contract for its sibling feature.

import type { Drawable, FeatureRender, FeatureRenderPlan, RunTrace, UnitTrace } from './types';
import { RECOVERY_POSE_EXCLUSION_NOTE } from './g4.teeBadgeCompassMath';

export const TEE_BADGE_COMPASS_FEATURE_ID = 'teeBadgeCompass' as const;
const UNKNOWN = 'UNKNOWN' as const;
const TEE_BADGE_COMPASS_UNIT = TEE_BADGE_COMPASS_FEATURE_ID;
const TEE_BADGE_PATH_ROLE = 'tee-badge-path';

export type CompassValue = number | typeof UNKNOWN;
export type CompassText = string | typeof UNKNOWN;

export interface TeeBadgeCompassLockRow {
	readonly ref: CompassText;
	readonly teeId: CompassText;
	readonly badgeId: CompassText;
	readonly hole: CompassValue;
	readonly holeLabel: CompassText;
	readonly angularErrorDeg: CompassValue;
	readonly distancePx: CompassValue;
	readonly weight: CompassValue;
	readonly runnerUpHole: CompassValue;
	readonly runnerUpHoleLabel: CompassText;
	readonly runnerUpAngularErrorDeg: CompassValue;
	readonly gapDeg: CompassValue;
	readonly verdict: CompassText;
	/** Pose-quality ingredients for THIS tee, carried verbatim (owner
	 * mid-build amendment) -- raw numbers, never a synthesized score. */
	readonly supportPx: CompassValue;
	readonly fill: CompassValue;
	readonly majorPx: CompassValue;
	readonly minorPx: CompassValue;
	readonly courseMedianSupportPx: CompassValue;
	readonly courseMedianFill: CompassValue;
	readonly poseDegraded: CompassText;
	readonly poseDegradedReason: CompassText;
	readonly reason: string;
}

export interface TeeBadgeCompassNoPadRow {
	readonly teeId: CompassText;
	readonly reason: string;
}

export interface TeeBadgeCompassUnmatchedRow {
	readonly badgeId: CompassText;
	readonly hole: CompassValue;
	readonly holeLabel: CompassText;
	readonly why: CompassText;
}

export interface TeeBadgeCompassCounts {
	readonly eligibleTees: CompassValue;
	readonly noPadTees: CompassValue;
	readonly locked: CompassValue;
	readonly lockedWeakPose: CompassValue;
	readonly ambiguous: CompassValue;
	readonly unmatchedBadges: CompassValue;
	readonly unusedTees: CompassValue;
}

export interface TeeBadgeCompassSigmaSummary {
	readonly sigmaDeg: CompassValue;
	readonly floorDeg: CompassValue;
	readonly quantileFraction: CompassValue;
	readonly quantileValueDeg: CompassValue;
	readonly totalEligibleTees: CompassValue;
	readonly excludedForPoseQuality: CompassValue;
	readonly sampleSize: CompassValue;
	readonly minimumSampleSize: CompassValue;
	readonly representativeDistancePx: CompassValue;
	readonly isFallback: CompassText;
	readonly provenance: string;
}

export interface TeeBadgeCompassReceipt {
	readonly plan: FeatureRenderPlan;
	readonly lockRows: readonly TeeBadgeCompassLockRow[];
	readonly noPadRows: readonly TeeBadgeCompassNoPadRow[];
	readonly unmatchedRows: readonly TeeBadgeCompassUnmatchedRow[];
	readonly counts: TeeBadgeCompassCounts;
	readonly sigma: TeeBadgeCompassSigmaSummary;
	readonly cliText: string;
}

function nonEmpty(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

interface TraceMetadata {
	readonly runId: string;
	readonly imageId: string;
	readonly paramsHash: string;
	readonly featureId: string;
	readonly traceHash: string;
	readonly canonicalFrame: string;
}

function runMetadata(run: RunTrace, unitFeatureId?: string): TraceMetadata {
	return {
		runId: nonEmpty(run.runId) ?? UNKNOWN,
		imageId: nonEmpty(run.imageId) ?? UNKNOWN,
		paramsHash: nonEmpty(run.paramsHash) ?? UNKNOWN,
		featureId: nonEmpty(unitFeatureId) ?? UNKNOWN,
		traceHash: nonEmpty(run.traceHash) ?? UNKNOWN,
		canonicalFrame: nonEmpty(run.canonicalFrame) ?? UNKNOWN
	};
}

function numeric(values: Drawable['values'], name: string): CompassValue {
	const value = values?.[name];
	return typeof value === 'number' && Number.isFinite(value) ? value : UNKNOWN;
}

function text(value: unknown): string {
	return typeof value === 'string' && value.length > 0 ? value : UNKNOWN;
}

function valueText(value: CompassValue): string {
	return typeof value === 'number' ? String(Number(value.toFixed(6))) : value;
}

function holeText(hole: CompassValue, label: CompassText): string {
	if (typeof hole === 'number') return `H${valueText(hole)}`;
	return label === UNKNOWN ? UNKNOWN : `UNREAD(${label})`;
}

function isTeeBadgePath(drawable: Drawable): boolean {
	return (
		drawable.type === 'polyline' &&
		(drawable as unknown as { readonly visualRole?: string }).visualRole === TEE_BADGE_PATH_ROLE
	);
}

function isNoPadPoint(drawable: Drawable): boolean {
	return drawable.type === 'point' && drawable.metadata?.role === 'no-pad';
}

function isUnmatchedBadge(drawable: Drawable): boolean {
	return drawable.type === 'point' && drawable.metadata?.role === 'unmatched-badge';
}

function lockRowFor(drawable: Drawable): TeeBadgeCompassLockRow {
	const metadata = drawable.metadata ?? {};
	return {
		ref: text(drawable.ref),
		teeId: text(metadata.teeId),
		badgeId: text(metadata.badgeId),
		hole: numeric(drawable.values, 'hole'),
		holeLabel: text(metadata.badgeLabel),
		angularErrorDeg: numeric(drawable.values, 'angularErrorDeg'),
		distancePx: numeric(drawable.values, 'distancePx'),
		weight: numeric(drawable.values, 'weight'),
		runnerUpHole: numeric(drawable.values, 'runnerUpHole'),
		runnerUpHoleLabel: text(metadata.runnerUpBadgeLabel),
		runnerUpAngularErrorDeg: numeric(drawable.values, 'runnerUpAngularErrorDeg'),
		gapDeg: numeric(drawable.values, 'gapDeg'),
		verdict: text(metadata.verdict),
		supportPx: numeric(drawable.values, 'supportPx'),
		fill: numeric(drawable.values, 'fill'),
		majorPx: numeric(drawable.values, 'majorPx'),
		minorPx: numeric(drawable.values, 'minorPx'),
		courseMedianSupportPx: numeric(drawable.values, 'courseMedianSupportPx'),
		courseMedianFill: numeric(drawable.values, 'courseMedianFill'),
		poseDegraded: text(metadata.poseDegraded),
		poseDegradedReason: text(metadata.poseDegradedReason),
		reason: text(drawable.reason)
	};
}

function noPadRowFor(drawable: Drawable): TeeBadgeCompassNoPadRow {
	return { teeId: text(drawable.ref), reason: text(drawable.reason) };
}

function unmatchedRowFor(drawable: Drawable): TeeBadgeCompassUnmatchedRow {
	const metadata = drawable.metadata ?? {};
	return {
		badgeId: text(metadata.badgeId),
		hole: numeric(drawable.values, 'hole'),
		holeLabel: text(metadata.badgeLabel),
		why: text(metadata.why)
	};
}

function measurementValue(unit: UnitTrace, name: string): CompassValue {
	const matches = (unit.measurements ?? []).filter((measurement) => measurement.name === name);
	if (matches.length !== 1) return UNKNOWN;
	const value = matches[0].sum;
	return typeof value === 'number' && Number.isFinite(value) ? value : UNKNOWN;
}

function countsFor(unit: UnitTrace): TeeBadgeCompassCounts {
	return {
		eligibleTees: measurementValue(unit, 'eligibleTees'),
		noPadTees: measurementValue(unit, 'noPadTees'),
		locked: measurementValue(unit, 'locked'),
		lockedWeakPose: measurementValue(unit, 'lockedWeakPose'),
		ambiguous: measurementValue(unit, 'ambiguous'),
		unmatchedBadges: measurementValue(unit, 'unmatchedBadges'),
		unusedTees: measurementValue(unit, 'unusedTees')
	};
}

function sigmaSummary(unit: UnitTrace): TeeBadgeCompassSigmaSummary {
	const sigmaDrawable = unit.drawables.find((drawable) => drawable.metadata?.role === 'sigma');
	const values = sigmaDrawable?.values;
	const metadata = sigmaDrawable?.metadata ?? {};
	return {
		sigmaDeg: numeric(values, 'sigmaDeg'),
		floorDeg: numeric(values, 'floorDeg'),
		quantileFraction: numeric(values, 'quantileFraction'),
		quantileValueDeg: numeric(values, 'quantileValueDeg'),
		totalEligibleTees: numeric(values, 'totalEligibleTees'),
		excludedForPoseQuality: numeric(values, 'excludedForPoseQuality'),
		sampleSize: numeric(values, 'sampleSize'),
		minimumSampleSize: numeric(values, 'minimumSampleSize'),
		representativeDistancePx: numeric(values, 'representativeDistancePx'),
		isFallback: text(metadata.isFallback),
		provenance: text(sigmaDrawable?.reason)
	};
}

function cliLines(
	metadata: TraceMetadata,
	counts: TeeBadgeCompassCounts,
	sigma: TeeBadgeCompassSigmaSummary,
	lockRows: readonly TeeBadgeCompassLockRow[],
	noPadRows: readonly TeeBadgeCompassNoPadRow[],
	unmatchedRows: readonly TeeBadgeCompassUnmatchedRow[]
): string[] {
	const lines = [
		'TEE→BADGE COMPASS',
		`runId=${metadata.runId}`,
		`imageId=${metadata.imageId}`,
		`paramsHash=${metadata.paramsHash}`,
		`featureId=${metadata.featureId}`,
		`traceHash=${metadata.traceHash}`,
		`frame=${metadata.canonicalFrame}`,
		'basketEvidenceRead=0 assignmentRead=0 routingRead=0',
		RECOVERY_POSE_EXCLUSION_NOTE,
		'',
		'SIGMA DERIVATION',
		`sigmaDeg=${valueText(sigma.sigmaDeg)} floorDeg=${valueText(sigma.floorDeg)} ` +
			`quantileFraction=${valueText(sigma.quantileFraction)} quantileValueDeg=${valueText(sigma.quantileValueDeg)}`,
		`totalEligibleTees=${valueText(sigma.totalEligibleTees)} excludedForPoseQuality=${valueText(sigma.excludedForPoseQuality)} ` +
			`sampleSize=${valueText(sigma.sampleSize)} minimumSampleSize=${valueText(sigma.minimumSampleSize)}`,
		`representativeDistancePx=${valueText(sigma.representativeDistancePx)} isFallback=${sigma.isFallback}`,
		`provenance: ${sigma.provenance}`,
		'',
		`eligibleTees=${valueText(counts.eligibleTees)} noPadTees=${valueText(counts.noPadTees)} ` +
			`locked=${valueText(counts.locked)} lockedWeakPose=${valueText(counts.lockedWeakPose)} ` +
			`ambiguous=${valueText(counts.ambiguous)} unmatchedBadges=${valueText(counts.unmatchedBadges)} ` +
			`unusedTees=${valueText(counts.unusedTees)}`,
		'',
		'TEE ROWS',
		'teeId | lockedHole | angularErrorDeg | distancePx | runnerUpHole | gapDeg | verdict | ' +
			'supportPx | fill | majorPx | minorPx | courseMedianSupportPx | courseMedianFill | poseDegraded'
	];
	for (const row of lockRows) {
		lines.push(
			[
				row.teeId,
				holeText(row.hole, row.holeLabel),
				valueText(row.angularErrorDeg),
				valueText(row.distancePx),
				row.runnerUpHole === UNKNOWN && row.runnerUpHoleLabel === UNKNOWN
					? 'none'
					: holeText(row.runnerUpHole, row.runnerUpHoleLabel),
				valueText(row.gapDeg),
				row.verdict,
				valueText(row.supportPx),
				valueText(row.fill),
				valueText(row.majorPx),
				valueText(row.minorPx),
				valueText(row.courseMedianSupportPx),
				valueText(row.courseMedianFill),
				row.poseDegraded === 'true' ? `DEGRADED (${row.poseDegradedReason})` : 'ok'
			].join(' | ')
		);
	}
	for (const row of noPadRows) {
		lines.push(`${row.teeId} | no-pad | ${row.reason}`);
	}
	lines.push('', 'UNMATCHED BADGES', 'badgeId | hole | why');
	for (const row of unmatchedRows) {
		lines.push(`${row.badgeId} | ${holeText(row.hole, row.holeLabel)} | ${row.why}`);
	}
	if (unmatchedRows.length === 0) lines.push('(none)');
	return lines;
}

function planFor(
	unit: UnitTrace,
	run: RunTrace,
	acceptedPaths: readonly Drawable[],
	cliText: string
): FeatureRenderPlan {
	return {
		title: `G4 Tee→Badge compass (${run.configName})`,
		base: 'badgeStage.masks.bright',
		layers: [
			{
				name: 'Tee→Badge compass readings (thin blue)',
				note:
					'#00a2ff thin-blue layer: each segment runs from a tee center along its OWN pad axis for ' +
					'exactly the tee-to-badge distance -- it visibly misses the badge by angularErrorDeg when ' +
					'that is nonzero, rather than snapping onto it. basketEvidenceRead=0, assignmentRead=0.',
				drawables: acceptedPaths
			}
		],
		notes: [
			`feature: ${TEE_BADGE_COMPASS_FEATURE_ID} -- ${unit.gate}, trace unit '${unit.id}'`,
			'presentation style is applied by Terra shared Sweep integration; this feature declares no paint or geometry policy.',
			'exact geometry contract: no interpolation, refit, or pixel read occurs here; every drawable is producer-emitted.',
			...cliText.split('\n')
		]
	};
}

/** Build the CLI/visual receipt pair from one teeBadgeCompass UnitTrace. */
export function buildTeeBadgeCompassReceipt(unit: UnitTrace, run: RunTrace): TeeBadgeCompassReceipt {
	const acceptedPaths = unit.drawables.filter((drawable) => isTeeBadgePath(drawable));
	const lockRows = acceptedPaths.map(lockRowFor);
	const noPadRows = unit.drawables.filter(isNoPadPoint).map(noPadRowFor);
	const unmatchedRows = unit.drawables.filter(isUnmatchedBadge).map(unmatchedRowFor);
	const counts = countsFor(unit);
	const sigma = sigmaSummary(unit);
	const metadata = runMetadata(run, unit.featureId);
	const cliText = cliLines(metadata, counts, sigma, lockRows, noPadRows, unmatchedRows).join('\n');
	const plan = planFor(unit, run, acceptedPaths, cliText);
	return { plan, lockRows, noPadRows, unmatchedRows, counts, sigma, cliText };
}

/** FeatureRender seam: one exact forwarded layer over the bright-mask base. */
export const TEE_BADGE_COMPASS_RENDER: FeatureRender = {
	units: [TEE_BADGE_COMPASS_UNIT],
	draw(unit, run) {
		return buildTeeBadgeCompassReceipt(unit, run).plan;
	}
};
