// Trace-only receipt and render seam for G4 tee↔badge ownership locks.
//
// The teeBadgeLock producer owns all matching, scoring, tiering, and path
// sampling.  This module deliberately does not inspect pixels, read baskets,
// rebuild IDs, or derive geometry from a path.  It carries the producer's
// testimony into a literal CLI receipt and a declarative FeatureRender plan.

import type { Drawable, FeatureRender, FeatureRenderPlan, RunTrace, UnitTrace } from './types';

export const TEE_BADGE_LOCK_FEATURE_ID = 'teeBadgeLock' as const;

const UNKNOWN = 'UNKNOWN' as const;
const TEE_BADGE_LOCK_UNIT = TEE_BADGE_LOCK_FEATURE_ID;
const TEE_BADGE_PATH_ROLE = 'tee-badge-path';

/** Run-level identity fields are optional on legacy RunTrace callers. */
export interface TeeBadgeLockTraceMetadata {
	readonly runId?: string;
	readonly imageId?: string;
	readonly paramsHash?: string;
	readonly featureId?: string;
	readonly traceHash?: string;
	readonly canonicalFrame?: string;
}

export type TeeBadgeLockValue = number | typeof UNKNOWN;
export type TeeBadgeLockText = string | typeof UNKNOWN;

export interface TeeBadgeLockReceiptRow {
	/** The exact producer ref, retained even when its encoded IDs are invalid. */
	readonly lockId: TeeBadgeLockText;
	/** Numeric hole value from the producer; the CLI renders this as H<number>. */
	readonly hole: TeeBadgeLockValue;
	readonly badgeId: TeeBadgeLockText;
	readonly teeId: TeeBadgeLockText;
	readonly tier: TeeBadgeLockText;
	readonly tierCode: TeeBadgeLockValue;
	readonly score: TeeBadgeLockValue;
	readonly weakAligned: TeeBadgeLockValue;
	readonly efficiency: TeeBadgeLockValue;
	readonly axisErrorDeg: TeeBadgeLockValue;
	readonly axisSource: TeeBadgeLockText;
	readonly axisSourceCode: TeeBadgeLockValue;
	readonly margin: TeeBadgeLockValue;
	readonly pathPoints: TeeBadgeLockValue;
	readonly recovered: TeeBadgeLockValue;
	readonly verdict: Drawable['verdict'];
	/** Producer testimony is carried verbatim; absent testimony is UNKNOWN. */
	readonly reason: string;
}

export interface TeeBadgeLockReceiptCounts {
	readonly candidates: TeeBadgeLockValue;
	readonly locks: TeeBadgeLockValue;
	readonly visibleLocks: TeeBadgeLockValue;
	readonly recoveredLocks: TeeBadgeLockValue;
	readonly unmatchedBadges: TeeBadgeLockValue;
	readonly unusedTees: TeeBadgeLockValue;
}

export interface TeeBadgeLockCorrespondence {
	/** Every accepted tee-badge trace drawable, in trace order. */
	readonly traceLockRefs: readonly TeeBadgeLockText[];
	/** Every CLI row, in row order. */
	readonly cliLockRefs: readonly TeeBadgeLockText[];
	/** Every drawable forwarded to the visual layer, in draw order. */
	readonly visualLockRefs: readonly TeeBadgeLockText[];
	readonly duplicateCliRefs: readonly TeeBadgeLockText[];
	readonly duplicateVisualRefs: readonly TeeBadgeLockText[];
	readonly missingVisualRefs: readonly TeeBadgeLockText[];
	readonly orphanVisualRefs: readonly TeeBadgeLockText[];
	/** Ref strings which failed the exact teeBadgeLock encoding contract. */
	readonly malformedRefs: readonly TeeBadgeLockText[];
	readonly matched: boolean;
}

export interface TeeBadgeLockReceipt {
	readonly plan: FeatureRenderPlan;
	readonly rows: readonly TeeBadgeLockReceiptRow[];
	readonly counts: TeeBadgeLockReceiptCounts;
	readonly cliText: string;
	readonly correspondence: TeeBadgeLockCorrespondence;
}

type TraceWithMetadata = RunTrace & Partial<TeeBadgeLockTraceMetadata>;

function nonEmpty(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function runMetadata(run: RunTrace, unitFeatureId?: string): Required<TeeBadgeLockTraceMetadata> {
	const source = run as TraceWithMetadata;
	return {
		runId: nonEmpty(source.runId) ?? UNKNOWN,
		imageId: nonEmpty(source.imageId) ?? UNKNOWN,
		paramsHash: nonEmpty(source.paramsHash) ?? UNKNOWN,
		// A compatibility run-level feature id takes precedence over the unit
		// id.  Do not fall back to this module's constant: UNKNOWN is required
		// when both trace sources omit it.
		featureId: nonEmpty(source.featureId) ?? nonEmpty(unitFeatureId) ?? UNKNOWN,
		traceHash: nonEmpty(source.traceHash) ?? UNKNOWN,
		canonicalFrame: nonEmpty(source.canonicalFrame) ?? UNKNOWN
	};
}

function finite(values: Drawable['values'], name: string): TeeBadgeLockValue {
	const value = values?.[name];
	return typeof value === 'number' && Number.isFinite(value) ? value : UNKNOWN;
}

function valueText(value: TeeBadgeLockValue): string {
	return typeof value === 'number' ? String(Number(value.toFixed(6))) : value;
}

function holeText(value: TeeBadgeLockValue): string {
	return typeof value === 'number' ? `H${valueText(value)}` : UNKNOWN;
}

function textValue(value: unknown): string {
	return typeof value === 'string' ? value : UNKNOWN;
}

function isTeeBadgePath(drawable: Drawable): boolean {
	// The shared Drawable role union predates this feature in some worktrees;
	// keep the local guard narrow until that shared vocabulary is widened.
	return (
		drawable.type === 'polyline' &&
		drawable.verdict === 'accepted' &&
		(drawable as unknown as { readonly visualRole?: string }).visualRole === TEE_BADGE_PATH_ROLE
	);
}

function teeBadgePaths(unit: UnitTrace): Drawable[] {
	return unit.drawables.filter(isTeeBadgePath);
}

interface DecodedLockRef {
	readonly badgeId: string;
	readonly teeId: string;
}

/**
 * Decode only the exact canonical form emitted by the producer.  In
 * particular, a malformed percent escape, an unescaped colon, a non-canonical
 * escape, or an empty ID is not repaired or guessed.
 */
function decodeLockRef(ref: unknown): DecodedLockRef | undefined {
	if (typeof ref !== 'string') return undefined;
	const prefix = `${TEE_BADGE_LOCK_FEATURE_ID}:`;
	if (!ref.startsWith(prefix)) return undefined;
	const encoded = ref.slice(prefix.length).split(':');
	if (encoded.length !== 2 || encoded.some((part) => part.length === 0)) return undefined;
	try {
		const badgeId = decodeURIComponent(encoded[0]);
		const teeId = decodeURIComponent(encoded[1]);
		if (!badgeId || !teeId) return undefined;
		// Exact producer format: accepting a differently escaped spelling would
		// make the visual ref and receipt identity disagree.
		if (encodeURIComponent(badgeId) !== encoded[0] || encodeURIComponent(teeId) !== encoded[1]) {
			return undefined;
		}
		return { badgeId, teeId };
	} catch {
		return undefined;
	}
}

function lockId(drawable: Drawable): TeeBadgeLockText {
	return textValue(drawable.ref);
}

function tierFor(code: TeeBadgeLockValue): TeeBadgeLockText {
	if (code === 0) return 'visible';
	if (code === 1) return 'recovered';
	return UNKNOWN;
}

function axisSourceFor(code: TeeBadgeLockValue): TeeBadgeLockText {
	if (code === 0) return 'tee.pad.minAreaPose.angleRad';
	if (code === 1) return 'TeeEvidence.angleRad';
	if (code === 2) return 'TeeEvidence.pad.angleRad';
	// Code 3 is producer testimony for an unknown source, not a source name.
	return UNKNOWN;
}

function rowFor(drawable: Drawable): TeeBadgeLockReceiptRow {
	const ref = lockId(drawable);
	const decoded = decodeLockRef(drawable.ref);
	const tierCode = finite(drawable.values, 'tierCode');
	const axisSourceCode = finite(drawable.values, 'axisSourceCode');
	return {
		lockId: ref,
		hole: finite(drawable.values, 'hole'),
		badgeId: decoded?.badgeId ?? UNKNOWN,
		teeId: decoded?.teeId ?? UNKNOWN,
		tier: tierFor(tierCode),
		tierCode,
		score: finite(drawable.values, 'score'),
		weakAligned: finite(drawable.values, 'weakAligned'),
		efficiency: finite(drawable.values, 'efficiency'),
		axisErrorDeg: finite(drawable.values, 'axisErrorDeg'),
		axisSource: axisSourceFor(axisSourceCode),
		axisSourceCode,
		margin: finite(drawable.values, 'margin'),
		pathPoints: finite(drawable.values, 'pathPoints'),
		recovered: finite(drawable.values, 'recovered'),
		verdict: drawable.verdict,
		reason: typeof drawable.reason === 'string' ? drawable.reason : UNKNOWN
	};
}

function measurementValue(unit: UnitTrace, name: string): TeeBadgeLockValue {
	const matches = (unit.measurements ?? []).filter((measurement) => measurement.name === name);
	if (matches.length !== 1) return UNKNOWN;
	const value = matches[0].sum;
	return typeof value === 'number' && Number.isFinite(value) ? value : UNKNOWN;
}

function countsFor(unit: UnitTrace): TeeBadgeLockReceiptCounts {
	return {
		candidates: measurementValue(unit, 'candidates'),
		locks: measurementValue(unit, 'locks'),
		visibleLocks: measurementValue(unit, 'visibleLocks'),
		recoveredLocks: measurementValue(unit, 'recoveredLocks'),
		unmatchedBadges: measurementValue(unit, 'unmatchedBadges'),
		unusedTees: measurementValue(unit, 'unusedTees')
	};
}

function duplicateRefs(refs: readonly TeeBadgeLockText[]): readonly TeeBadgeLockText[] {
	const counts = new Map<TeeBadgeLockText, number>();
	for (const ref of refs) counts.set(ref, (counts.get(ref) ?? 0) + 1);
	return [...counts]
		.filter(([, count]) => count > 1)
		.map(([ref]) => ref)
		.sort();
}

function correspondence(
	traceDrawables: readonly Drawable[],
	rows: readonly TeeBadgeLockReceiptRow[],
	visualDrawables: readonly Drawable[]
): TeeBadgeLockCorrespondence {
	const refsFor = (drawables: readonly Drawable[]): TeeBadgeLockText[] =>
		drawables.map((drawable) => lockId(drawable));
	const traceLockRefs = refsFor(traceDrawables);
	const cliLockRefs = rows.map((row) => row.lockId);
	const visualLockRefs = refsFor(visualDrawables);
	const duplicateCliRefs = duplicateRefs(cliLockRefs);
	const duplicateVisualRefs = duplicateRefs(visualLockRefs);
	const cliUnique = [...new Set(cliLockRefs)];
	const visualUnique = [...new Set(visualLockRefs)];
	const missingVisualRefs = cliUnique.filter((ref) => !visualUnique.includes(ref));
	const orphanVisualRefs = visualUnique.filter((ref) => !cliUnique.includes(ref));
	const malformedRefs = traceDrawables
		.map((drawable) => lockId(drawable))
		.filter((ref) => ref === UNKNOWN || !decodeLockRef(ref));
	return {
		traceLockRefs,
		cliLockRefs,
		visualLockRefs,
		duplicateCliRefs,
		duplicateVisualRefs,
		missingVisualRefs,
		orphanVisualRefs,
		malformedRefs: [...new Set(malformedRefs)],
		matched:
			traceLockRefs.length === cliLockRefs.length &&
			cliLockRefs.length === visualLockRefs.length &&
			duplicateCliRefs.length === 0 &&
			duplicateVisualRefs.length === 0 &&
			missingVisualRefs.length === 0 &&
			orphanVisualRefs.length === 0 &&
			traceLockRefs.every(
				(ref, index) => ref === cliLockRefs[index] && ref === visualLockRefs[index]
			)
	};
}

function cliRows(
	metadata: Required<TeeBadgeLockTraceMetadata>,
	counts: TeeBadgeLockReceiptCounts,
	rows: readonly TeeBadgeLockReceiptRow[]
): string[] {
	const header =
		'lockId | hole | badgeId | teeId | tier | score | weakAligned | efficiency | axisErrorDeg | axisSource | margin | pathPoints | verdict | reason';
	const lines = [
		'TEE→BADGE LOCK',
		`runId=${metadata.runId}`,
		`imageId=${metadata.imageId}`,
		`paramsHash=${metadata.paramsHash}`,
		`featureId=${metadata.featureId}`,
		`traceHash=${metadata.traceHash}`,
		`frame=${metadata.canonicalFrame}`,
		'basketEvidenceRead=0',
		`candidates=${valueText(counts.candidates)}`,
		`locks=${valueText(counts.locks)}`,
		`visibleLocks=${valueText(counts.visibleLocks)}`,
		`recoveredLocks=${valueText(counts.recoveredLocks)}`,
		`unmatchedBadges=${valueText(counts.unmatchedBadges)}`,
		`unusedTees=${valueText(counts.unusedTees)}`,
		header
	];
	for (const row of rows) {
		lines.push(
			[
				row.lockId,
				holeText(row.hole),
				row.badgeId,
				row.teeId,
				row.tier,
				valueText(row.score),
				valueText(row.weakAligned),
				valueText(row.efficiency),
				valueText(row.axisErrorDeg),
				row.axisSource,
				valueText(row.margin),
				valueText(row.pathPoints),
				row.verdict,
				row.reason
			].join(' | ')
		);
	}
	return lines;
}

function planFor(
	unit: UnitTrace,
	run: RunTrace,
	acceptedPaths: readonly Drawable[],
	cliText: string
): FeatureRenderPlan {
	return {
		title: `G4 Tee→Badge ownership lock (${run.configName})`,
		base: 'badgeStage.masks.bright',
		layers: [
			{
				name: 'Tee→Badge ownership locks (thin blue)',
				note: '#00a2ff thin-blue layer: exact producer-emitted routed testimony; paths are forwarded unchanged; basketEvidenceRead=0',
				drawables: acceptedPaths
			}
		],
		notes: [
			`feature: ${TEE_BADGE_LOCK_FEATURE_ID} -- ${unit.gate}, trace unit '${unit.id}'`,
			'presentation style is applied by Terra shared Sweep integration; this feature declares no paint or geometry policy.',
			'exact path contract: each accepted teeBadgePath is forwarded in producer order; no reverse, refit, smoothing, regeneration, or pixel read occurs here.',
			...cliText.split('\n')
		]
	};
}

/** Build the CLI/visual receipt pair from one teeBadgeLock UnitTrace. */
export function buildTeeBadgeLockReceipt(unit: UnitTrace, run: RunTrace): TeeBadgeLockReceipt {
	const acceptedPaths = teeBadgePaths(unit);
	const rows = acceptedPaths.map(rowFor);
	const counts = countsFor(unit);
	const metadata = runMetadata(run, unit.featureId);
	const cliText = cliRows(metadata, counts, rows).join('\n');
	const plan = planFor(unit, run, acceptedPaths, cliText);
	const matched = correspondence(acceptedPaths, rows, acceptedPaths);
	return { plan, rows, counts, cliText, correspondence: matched };
}

/** FeatureRender seam: one exact forwarded layer over the bright-mask base. */
export const TEE_BADGE_LOCK_RENDER: FeatureRender = {
	units: [TEE_BADGE_LOCK_UNIT],
	draw(unit, run) {
		return buildTeeBadgeLockReceipt(unit, run).plan;
	}
};

export const teeBadgeLockRender = TEE_BADGE_LOCK_RENDER;
