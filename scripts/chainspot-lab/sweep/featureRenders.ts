// Trace-driven, FEATURE-owned rendering.
//
// The other renderer path in this directory (rendererContract.ts +
// artifactIo.ts) keys on ArtifactKind. That dispatch hands a renderer ONE
// artifact and tells it nothing about which feature produced it or why, so
// it can draw "a mask" and never "g3.endpoints' rejected tee candidates
// over the bright mask it rejected them on". Both paths stay: the
// kind-keyed one owns raw bytes, this one owns meaning. Nothing here
// modifies, imports, or depends on rendererContract.ts/artifactIo.ts.
//
// What this module does, in one sentence: walk RunTrace.units, resolve each
// unit to the ABFeature(s) that own it, and call ABFeature.render.draw()
// when the feature declared one.
//
// LAB's hard rule still applies -- this file NEVER recomputes detector data.
// Every coordinate it draws was already in the trace; every number in a
// receipt is either read straight off the trace or is a count of trace
// entries, and says which. Where a number is not available it prints a loud
// UNKNOWN with the reason, per the repo rule "every number ships with where
// it came from, or a loud UNKNOWN".

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { PNG } from 'pngjs';
import { OPERATION_UNIVERSE, type HoleLabeledAssignment } from '@chainspot/alg/exec';
import { ALL_FEATURES } from '@chainspot/alg/detectors/threeFactor/features/registry';
import { buildTeeMinAreaPoseReceipt } from '@chainspot/alg/detectors/threeFactor/features/g3.teeMinAreaPoseReceipt';
import { buildTeeBadgeLockReceipt } from '@chainspot/alg/detectors/threeFactor/features/g4.teeBadgeLockReceipt';
import { buildBadgeGlyphTemplateReceipt } from '@chainspot/alg/detectors/threeFactor/features/g1.badgeGlyphTemplateReceipt';
import { SCORE_ANOMALY_ORDERS_BELOW_MEDIAN, assignmentScoreMedian, scoreAnomalyNote } from './runReceipt';
import { notFoundReceiptLines, sortByHole, type NotFoundBadgeRow } from './notFoundRows';
import type { TeeBadgeLockReceipt } from '@chainspot/alg/detectors/threeFactor/features/g4.teeBadgeLockReceipt';
import type {
	ABFeature,
	Drawable,
	FeatureRender,
	FeatureRenderPlan,
	RunTrace,
	UnitTrace
} from '@chainspot/alg/detectors/threeFactor/features/types';
import type { GateScore, GroundingComparison, TruthScoreboard } from './truthScoring';

// ---------------------------------------------------------------------------
// unit id -> feature id, read off the compiled operation universe.
//
// This mapping is NOT guessable from the trace alone and is NOT hardcoded
// here. OperationSpec (packages/alg/src/exec/contract.ts) already declares
// both `unit` ("owning engine unit") and `features` ("ABFeature ids this
// operation reads enabled/knobs from"), and OPERATION_UNIVERSE
// (operations.ts) is the exported list of every spec. So the association
// LAB needs already exists in the algorithm and is simply read here.
//
// It matters because a unit id is NOT a feature id: g3.endpoints' drawables
// land on the trace unit called 'tees'. Anything that assumes
// featureById(unit.id) silently renders nothing for the one feature where
// the rejections live.
// ---------------------------------------------------------------------------

export function featureIdsForUnit(unitId: string): readonly string[] {
	const ids = new Set<string>();
	for (const op of OPERATION_UNIVERSE) {
		if (op.unit !== unitId) continue;
		for (const featureId of op.features ?? []) ids.add(featureId);
	}
	return [...ids].sort();
}

/**
 * Features whose `render` is written but not yet landed in the feature's own
 * source file.
 *
 * This exists for exactly one reason: the reference implementation below
 * belongs in
 * packages/alg/src/detectors/threeFactor/features/g3.endpoints.ts as
 * `render: ENDPOINTS_RENDER`, a two-line diff, and that file is owned by a
 * different concern right now. Attaching it here is a decoration, not a
 * mutation -- g3EndpointsFeature is never modified, and the walker prefers
 * `feature.render` whenever it is present, so this table goes dead the
 * moment the two-line diff lands. Keep it EMPTY once that happens; it is
 * scaffolding, not an extension point.
 */
export const PENDING_FEATURE_RENDERS: Readonly<Record<string, FeatureRender>> = {
	get endpoints() {
		return ENDPOINTS_RENDER;
	}
};

function renderFor(feature: ABFeature): FeatureRender | undefined {
	return feature.render ?? PENDING_FEATURE_RENDERS[feature.id];
}

// ---------------------------------------------------------------------------
// The reference render: g3.endpoints.
//
// Chosen because it is where the rejections live. G3's tee unit is the only
// place in the algorithm that examines a candidate, kills it, and (per
// features/types.ts's "no silent drops" rule) leaves a rejected drawable
// with a reason. A kind-keyed renderer can never show that: the accepted
// tees ship as a `candidateSet` artifact and the rejected ones ship as
// nothing at all, because a rejection is not a board value. It is only ever
// a trace entry.
// ---------------------------------------------------------------------------

const ENDPOINTS_UNIT = 'tees';
/** Cross-gate: G2's accepted baskets. A tee suppressed for sitting near a
 * basket sprite is unreadable without the basket that suppressed it. */
const BASKETS_UNIT = 'baskets';
/** The raster these coordinates are evidence over. A NAME (an artifact id
 * from operations.ts's ARTIFACT_EXTRACTORS), never bytes -- resolving it to
 * a file stays with the kind-keyed path. */
const BRIGHT_MASK_ARTIFACT = 'badgeStage.masks.bright';

function verdictOf(drawables: readonly Drawable[], verdict: Drawable['verdict']): Drawable[] {
	return drawables.filter((d) => d.verdict === verdict);
}

function countByReason(drawables: readonly Drawable[]): Array<[string, number]> {
	const counts = new Map<string, number>();
	for (const d of drawables) {
		const reason =
			d.reason ?? '(no reason recorded -- violates features/types.ts "no silent drops")';
		counts.set(reason, (counts.get(reason) ?? 0) + 1);
	}
	return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** Reads the exact feature state resolved for this run. Unit ids and feature
 * ids differ, so UnitTrace.knobs cannot establish this provenance. */
function deviationNotes(run: RunTrace, unit: UnitTrace, featureId: string): string[] {
	const feature = ALL_FEATURES.find((candidate) => candidate.id === featureId);
	const state = run.features[featureId];
	if (!feature || !state) {
		return [
			`knobsDeviating: UNKNOWN -- resolved feature '${featureId}' is absent from RunTrace.features.`,
			`  Unit '${unit.id}' cannot prove which thresholds it used.`
		];
	}
	const knobNames = Object.keys(state.knobs);
	const deviating = knobNames.filter((name) => feature.knobs[name]?.default !== state.knobs[name]);
	if (deviating.length > 0) {
		return [
			`knobsDeviating: ${deviating.length} of ${knobNames.length} knob(s) DEVIATE from the feature's frozen default --`,
			...deviating.map(
				(name) =>
					`    ${name} = ${JSON.stringify(state.knobs[name])}  (source: RunTrace.features['${featureId}'].knobs['${name}'])`
			),
			`  => this run did NOT use frozen '${featureId}' thresholds. Read every rejection below against the deviated value, not the default.`
		];
	}
	return [
		`knobsDeviating: none -- all ${knobNames.length} knob(s) sit at feature '${featureId}'s frozen defaults`,
		`  (source: RunTrace.features['${featureId}'], compared directly with ABFeature.knobs defaults)`
	];
}

export const SPRITE_RENDER: FeatureRender = {
	units: [BASKETS_UNIT],
	draw(unit: UnitTrace, run: RunTrace): FeatureRenderPlan {
		const accepted = verdictOf(unit.drawables, 'accepted');
		const rejected = verdictOf(unit.drawables, 'rejected');
		const whiteBounds = verdictOf(unit.drawables, 'info').filter(
			(drawable) => drawable.type === 'box' && drawable.ref?.endsWith(':white-component')
		);
		const semanticTips = verdictOf(unit.drawables, 'info').filter(
			(drawable) => drawable.type === 'point' && drawable.ref?.endsWith(':semantic-tip')
		);
		const reasons = countByReason(rejected);
		const notes = [
			`feature:      sprite (g2.sprite) -- ${unit.gate}, trace unit '${unit.id}'`,
			`unit enabled: ${unit.enabled}  (source: UnitTrace.enabled)`,
			`config:       ${run.configName}`,
			`paramsHash:   ${run.paramsHash || 'UNKNOWN -- caller ran the engine without one'}`,
			`unit ms:      ${unit.ms.toFixed(2)}  (source: UnitTrace.ms; wall clock, not a quality signal)`,
			'',
			...deviationNotes(run, unit, 'sprite'),
			'',
			`accepted basket candidates: ${accepted.length}   (source: count of UnitTrace.drawables with verdict 'accepted')`,
			`rejected basket candidates: ${rejected.length}   (source: count of UnitTrace.drawables with verdict 'rejected')`,
			`examined renderer-family candidates: ${accepted.length + rejected.length}`,
			'',
			'candidate boundary: Pass 1 promotes connected bright components within the basket-family bbox',
			'  tolerance. Pass 2 promotes fine hypotheses only after they clear recoveryIdentityMin, inside',
			'  neighborhoods seeded by a known badge or accepted basket. Lower-scoring grid samples are search',
			'  measurements, not object candidates. Every promoted candidate is represented with its final decision.',
			'',
			'rejections by reason:'
		];
		if (reasons.length === 0) notes.push('  none');
		else
			for (const [reason, count] of reasons)
				notes.push(`  ${String(count).padStart(4)} x  ${reason}`);
		for (const measurement of unit.measurements) {
			notes.push(
				`measurement '${measurement.name}': n=${measurement.count} min=${measurement.min} max=${measurement.max} mean=${(measurement.sum / Math.max(1, measurement.count)).toFixed(4)}  (source: UnitTrace.measurements)`
			);
		}
		return {
			title: `g2.sprite -- basket candidates, accepted vs rejected (${run.configName})`,
			base: BRIGHT_MASK_ARTIFACT,
			layers: [
				{
					name: 'basket candidates rejected (G2)',
					note: 'renderer-family or seeded-recovery candidates rejected with measured testimony',
					drawables: rejected
				},
				{
					name: 'basket candidates accepted (G2)',
					note: 'the exact basket objects emitted to the evidence board',
					drawables: accepted
				},
				{
					name: 'basket white-component bounds (G2)',
					note: 'detector-local bright bounds; deliberately not the semantic object bbox',
					drawables: whiteBounds
				},
				{
					name: 'basket semantic endpoints (G2)',
					note: 'engine-emitted geometric endpoints; informational only, never ownership',
					drawables: semanticTips
				}
			],
			notes
		};
	}
};

export const ENDPOINTS_RENDER: FeatureRender = {
	units: [ENDPOINTS_UNIT],
	draw(unit: UnitTrace, run: RunTrace): FeatureRenderPlan {
		const accepted = verdictOf(unit.drawables, 'accepted');
		const rejected = verdictOf(unit.drawables, 'rejected');
		const info = verdictOf(unit.drawables, 'info');
		const baskets = run.units.find((u) => u.id === BASKETS_UNIT);
		const acceptedBaskets = verdictOf(baskets?.drawables ?? [], 'accepted');
		const reasons = countByReason(rejected);

		const notes: string[] = [
			`feature:      endpoints (g3.endpoints) -- ${unit.gate}, trace unit '${unit.id}'`,
			`unit enabled: ${unit.enabled}  (source: UnitTrace.enabled)`,
			`config:       ${run.configName}`,
			`paramsHash:   ${run.paramsHash || 'UNKNOWN -- caller ran the engine without one'}`,
			`unit ms:      ${unit.ms.toFixed(2)}  (source: UnitTrace.ms; wall clock, not a quality signal)`,
			'',
			...deviationNotes(run, unit, 'endpoints'),
			'',
			`accepted tee candidates: ${accepted.length}   (source: count of UnitTrace.drawables with verdict 'accepted')`,
			`rejected tee candidates: ${rejected.length}   (source: count of UnitTrace.drawables with verdict 'rejected')`,
			`info drawables:          ${info.length}`,
			`examined (accepted + rejected): ${accepted.length + rejected.length}`
		];

		if (rejected.length === 0) {
			notes.push(
				'',
				'WHAT THIS RUN COULD NOT SEE: no rejected drawable was recorded at all.',
				"  features/types.ts requires a rejected drawable per killed candidate ('no silent drops').",
				'  Zero rejections means EITHER nothing was killed, OR a suppression path is still',
				'  dropping candidates without recording them. This render cannot tell those apart --',
				'  it can only report that the trace is silent.'
			);
		} else {
			notes.push(
				'',
				'rejections by reason (each line is a candidate the algorithm examined and threw away):'
			);
			for (const [reason, count] of reasons)
				notes.push(`  ${String(count).padStart(4)} x  ${reason}`);
		}

		for (const measurement of unit.measurements) {
			notes.push(
				`measurement '${measurement.name}': n=${measurement.count} min=${measurement.min} max=${measurement.max} mean=${(measurement.sum / Math.max(1, measurement.count)).toFixed(4)}  (source: UnitTrace.measurements)`
			);
		}

		notes.push(
			'',
			`cross-gate layer: ${acceptedBaskets.length} accepted basket(s) from trace unit '${BASKETS_UNIT}'` +
				(baskets ? '' : ` -- UNIT ABSENT from this trace, layer is empty`),
			`  drawn because a tee killed for sitting near a basket sprite is unreadable without the basket.`,
			`base raster: '${BRIGHT_MASK_ARTIFACT}' (artifact id, not bytes). It is computed over the same`,
			`  G0 canonical raster as these coordinates. Original-source coordinates remain a truth-receipt concern`,
			`  because CROP/STITCH provenance lives in the G0 transform ledger, not in detector drawables.`
		);

		return {
			title: `g3.endpoints -- tee candidates, accepted vs rejected (${run.configName})`,
			base: BRIGHT_MASK_ARTIFACT,
			layers: [
				{
					name: 'baskets (G2, accepted)',
					note: `cross-gate context from unit '${BASKETS_UNIT}' -- why a nearby tee may have been suppressed`,
					drawables: acceptedBaskets
				},
				{
					name: 'tee candidates rejected (G3)',
					note: 'every candidate examined and killed, with the reason the algorithm recorded',
					drawables: rejected
				},
				{
					name: 'tee candidates accepted (G3)',
					note: 'what survived to the assignment gate',
					drawables: accepted
				},
				...(info.length > 0
					? [
							{
								name: 'tee candidates info (G3)',
								note: 'neither accepted nor rejected',
								drawables: info
							}
						]
					: [])
			],
			notes
		};
	}
};

// ---------------------------------------------------------------------------
// The walk.
// ---------------------------------------------------------------------------

export interface FeatureRenderCanvas {
	readonly widthPx: number;
	readonly heightPx: number;
	/** where the caller got these from, printed verbatim in the receipt */
	readonly source: string;
}

export interface FeatureRenderBase {
	/** stable suffix used in reusable filenames surfaced by LAB UI/scope */
	readonly id: string;
	/** absolute path to an already-rendered PNG (e.g. the kind-keyed mask
	 * renderer's output). This module never produces one. */
	readonly pngPath: string;
	/** offset from the base raster's origin to original-image origin. Caller
	 * supplied, never inferred; stated in the receipt. */
	readonly offsetXPx?: number;
	readonly offsetYPx?: number;
	readonly source: string;
}

export interface RenderTraceFeaturesInput {
	readonly run: RunTrace;
	readonly outDir: string;
	readonly canvas?: FeatureRenderCanvas;
	readonly bases?: readonly FeatureRenderBase[];
	readonly truthEvaluation?: {
		readonly scoreboard?: TruthScoreboard;
		readonly groundingComparisons: readonly GroundingComparison[];
	};
	/** canonical = original + offset; omitted for a stitched frame that cannot
	 * be mapped back to one unambiguous source image. */
	readonly sourceFrameOffset?: {
		readonly xPx: number;
		readonly yPx: number;
		readonly source: string;
	};
	/** Final board 'assignment' rows, hole-labeled via the shared
	 * withHoleLabels() mapping (@chainspot/alg/exec) -- the same rows
	 * run.receipt.txt's HOLE ASSIGNMENTS section prints. Only
	 * renderRunEndpointReceipt reads this; the per-unit feature loop above
	 * does not. Omitted (not empty-array) when assignment.selection was not
	 * scheduled, so the endpoint receipt can say NOT-SCHEDULED rather than a
	 * misleading empty table. */
	readonly assignmentRows?: readonly HoleLabeledAssignment[];
	/** Every G1-read badge absent from assignmentRows above -- computed once
	 * (operation.ts, from the exact same assignmentRows set) and forwarded
	 * verbatim here, so run.receipt.txt and run.visual.receipt.txt can never
	 * name a different missing badge. Omitted (not empty) exactly when
	 * assignmentRows is omitted. */
	readonly notFoundRows?: readonly NotFoundBadgeRow[];
	/** Canonical positions for the endpoints named by assignmentRows, so the
	 * endpoint image can annotate each ASSIGNED tee and basket with its
	 * post-assignment hole number. Sourced from the final board 'assignment'
	 * slot's own tee inventory and the measurement's baskets -- never
	 * recomputed geometry. */
	readonly endpointPositions?: {
		readonly tees: readonly { readonly id: string; readonly xPx: number; readonly yPx: number }[];
		readonly baskets: readonly { readonly id: string; readonly xPx: number; readonly yPx: number }[];
	};
}

export interface FeatureRenderResult {
	readonly featureId: string;
	readonly unitId: string;
	readonly gate: string;
	readonly title: string;
	readonly drawableCount: number;
	readonly acceptedCount: number;
	readonly rejectedCount: number;
	readonly filesWritten: readonly string[];
	readonly receiptText: string;
	readonly summary: string;
	/** loud problems found while walking -- never swallowed */
	readonly warnings: readonly string[];
}

export interface RenderTraceFeaturesOutput {
	readonly results: readonly FeatureRenderResult[];
	/** units present in the trace that no feature offered to render */
	readonly unrenderedUnits: readonly string[];
	/** features that declared a render for a unit the trace never produced */
	readonly unmatchedRenders: readonly string[];
}

export function renderTraceFeatures(input: RenderTraceFeaturesInput): RenderTraceFeaturesOutput {
	const { run, outDir } = input;
	mkdirSync(outDir, { recursive: true });

	const results: FeatureRenderResult[] = [];
	const renderedUnitIds = new Set<string>();
	const declaredUnitIds = new Set<string>();
	const traceUnitIds = new Set(run.units.map((u) => u.id));

	for (const feature of ALL_FEATURES) {
		const render = renderFor(feature);
		if (!render) continue;
		for (const declared of render.units) {
			if (run.execution.includes(declared)) declaredUnitIds.add(declared);
		}
	}

	for (const unit of run.units) {
		for (const feature of ALL_FEATURES) {
			const render = renderFor(feature);
			if (!render || !render.units.includes(unit.id)) continue;

			// Self-check the seam rather than trusting it: the feature says it
			// renders this unit; the compiled op universe says which features
			// this unit's operations actually read knobs from. A disagreement
			// is a real finding (a renamed unit, a moved feature), so it is
			// printed, not swallowed.
			const warnings: string[] = [];
			const declaredByOps = featureIdsForUnit(unit.id);
			if (!declaredByOps.includes(feature.id)) {
				warnings.push(
					`SEAM MISMATCH: feature '${feature.id}' declares render.units including '${unit.id}', but ` +
						`OPERATION_UNIVERSE says unit '${unit.id}' reads features [${declaredByOps.join(', ') || 'none'}]. ` +
						`One of the two is stale. Rendering anyway, loudly.`
				);
			}
			if (feature.render === undefined) {
				warnings.push(
					`render attached from PENDING_FEATURE_RENDERS, not from the feature file. ` +
						`Land the FeatureRender beside feature '${feature.id}' and drop the entry.`
				);
			}

			const plan = render.draw(unit, run);
			results.push(writePlan(plan, feature, unit, input, warnings));
			renderedUnitIds.add(unit.id);
		}
	}

	return {
		results,
		unrenderedUnits: [...traceUnitIds].filter((id) => !renderedUnitIds.has(id)).sort(),
		unmatchedRenders: [...declaredUnitIds].filter((id) => !traceUnitIds.has(id)).sort()
	};
}

// ---------------------------------------------------------------------------
// The normal Sweep receipt.
//
// Feature-owned plans above remain the source of semantic drawing decisions,
// but a normal run should not make a user reconcile four posters. This
// composer selects only the endpoint testimony that survives those plans and
// places it on one canonical image. Rejections remain in the text receipt;
// drawing them would obscure the accepted geometry the receipt exists to
// inspect.
// ---------------------------------------------------------------------------

function planForRunFeature(
	run: RunTrace,
	featureId: string,
	unitId: string
): FeatureRenderPlan | undefined {
	const feature = ALL_FEATURES.find((candidate) => candidate.id === featureId);
	const unit = run.units.find((candidate) => candidate.id === unitId);
	const render = feature ? renderFor(feature) : undefined;
	return unit && render?.units.includes(unit.id) ? render.draw(unit, run) : undefined;
}

function planDrawables(plan: FeatureRenderPlan | undefined): Drawable[] {
	return plan?.layers.flatMap((layer) => layer.drawables) ?? [];
}

function rejectionReceiptLines(
	run: RunTrace,
	units: readonly { readonly id: string; readonly gate: string }[]
): string[] {
	const lines: string[] = [];
	for (const requested of units) {
		const unit = run.units.find((candidate) => candidate.id === requested.id);
		if (!unit) {
			// A unit that never ran gets its own line: silently skipping it would
			// make "not scheduled" indistinguishable from "0 rejections".
			lines.push(
				`  ${requested.gate} ${requested.id}: NOT-SCHEDULED (no trace unit exists in this run; 'never ran' is different from '0 rejections')`
			);
			continue;
		}
		const rejected = unit.drawables.filter((drawable) => drawable.verdict === 'rejected');
		lines.push(`  ${unit.gate} ${unit.id}: ${rejected.length}`);
		for (const [reason, count] of countByReason(rejected)) lines.push(`    ${count} x ${reason}`);
	}
	return lines;
}

/** A `badge-N`/`tee-N`/`basket-N` id is a detector ordinal, not a hole
 * number -- printed alone it is useless to a human reading this receipt.
 * Every row here also carries the G1-read hole label (`hole`, e.g. "14", or
 * the loud `UNREAD` when the digit read failed) and its confidence, sourced
 * verbatim from `withHoleLabels()` (@chainspot/alg/exec) -- the same mapping
 * run.receipt.txt's HOLE ASSIGNMENTS section and the
 * assignment.selection.table/zfit.finalAssignment.table artifacts use. */
function holeAssignmentLines(rows: readonly HoleLabeledAssignment[] | undefined): string[] {
	if (rows === undefined) {
		return [
			'HOLE ASSIGNMENTS (badge -> hole -> tee -> basket)',
			"NOT-SCHEDULED (no 'assignment.selection' operation ran in this run; 'never ran' is not zero rows)"
		];
	}
	const lines = [
		'HOLE ASSIGNMENTS (badge -> hole -> tee -> basket)',
		"(provenance: board 'assignment' rows via withHoleLabels(); UNREAD means the G1 digit read failed, never a guess)",
		'hole | badgeId | teeId -> basketId | score | hole confidence'
	];
	if (rows.length === 0) {
		lines.push("(none -- 'assignment.selection' ran and produced zero rows)");
		return lines;
	}
	const median = assignmentScoreMedian(rows);
	for (const row of rows) {
		const holeLabel = row.hole === 'UNREAD' ? 'UNREAD' : `H${row.hole}`;
		const confidence =
			row.holeConfidence === null ? 'UNKNOWN' : Number(row.holeConfidence.toFixed(3));
		lines.push(
			`${holeLabel} | ${row.badgeId} | ${row.teeId} -> ${row.basketId} | ${Number(row.score.toFixed(3))} | ${confidence}${scoreAnomalyNote(row.score, median) ?? ''}`
		);
	}
	lines.push(
		`SCORE DISTRIBUTION: median ${median === null ? 'UNKNOWN' : Number(median.toFixed(3))}, min ${Number(Math.min(...rows.map((row) => row.score)).toFixed(3))} -- advisory anomaly rule: >= ${SCORE_ANOMALY_ORDERS_BELOW_MEDIAN} orders of magnitude below median, never a filter`
	);
	return lines;
}

function endpointGateSpan(run: RunTrace): string {
	if (run.units.some((unit) => unit.id === 'straightTest')) return 'G0-G5';
	if (run.units.some((unit) => unit.gate === 'G4')) return 'G0-G4';
	if (run.units.some((unit) => unit.gate === 'G3')) return 'G0-G3';
	if (run.units.some((unit) => unit.gate === 'G2')) return 'G0-G2';
	return 'G0-G1';
}

function straightDrawables(run: RunTrace): Drawable[] {
	// S0 owns candidate selection and abstention markers. The LAB consumer is
	// intentionally paint-only: every returned drawable is copied verbatim.
	return run.units.find((candidate) => candidate.id === 'straightTest')?.drawables ?? [];
}

function straightReceiptLines(run: RunTrace): string[] {
	const straight = run.straightTest;
	if (!straight) return ['straightTest: NOT SCHEDULED'];
	const lines = [
		'G5 STRAIGHT TEST (TRACE-DRIVEN)',
		`featureId: ${straight.featureId}`,
		`runId: ${run.runId ?? 'UNKNOWN'}`,
		`imageId: ${run.imageId ?? 'UNKNOWN'}`,
		`paramsHash: ${run.paramsHash || 'UNKNOWN'}`,
		`traceHash: ${run.traceHash ?? 'UNKNOWN'}`,
		`coordinateFrame: ${straight.coordinateFrame}`,
		`truthMode: ${straight.truthAssistance.mode}`,
		...(straight.truthAssistance.taint ? [straight.truthAssistance.taint] : []),
		`truthAssistance: ${JSON.stringify(straight.truthAssistance)}`
	];
	if (straight.proposals.length === 0) lines.push('proposal: []');
	for (const proposal of straight.proposals) {
		lines.push(`proposal ${proposal.proposalId}: ${JSON.stringify(proposal)}`);
		for (const reason of proposal.reasons) lines.push(`  reason: ${reason}`);
	}
	return lines;
}

/** Write the single, minimal endpoint picture exposed by a normal Sweep. */
export function renderRunEndpointReceipt(
	input: RenderTraceFeaturesInput
): RenderTraceFeaturesOutput {
	const { run, outDir } = input;
	mkdirSync(outDir, { recursive: true });
	const warnings: string[] = [];
	const base = input.bases?.find((candidate) => candidate.id === 'original') ?? input.bases?.[0];
	if (!base) throw new Error('run endpoint receipt requires the G0 canonical raster as its base');

	const badgeUnit = run.units.find((unit) => unit.id === 'badges');
	const acceptedBadges = (badgeUnit?.drawables ?? []).filter(
		(drawable) => drawable.type === 'box' && drawable.verdict === 'accepted'
	);
	const acceptedBadgeRefs = new Set<string>();
	for (const badge of acceptedBadges) {
		if (badge.ref === undefined)
			warnings.push(
				'accepted badge has no defined ref; exact bright-mask pixels cannot be associated'
			);
		else acceptedBadgeRefs.add(badge.ref);
	}
	const badgePixels: Drawable[] = [];
	for (const drawable of badgeUnit?.drawables ?? []) {
		if (
			drawable.type !== 'pixelSet' ||
			drawable.verdict !== 'info' ||
			drawable.visualRole !== 'badge-pixels'
		)
			continue;
		if (drawable.ref === undefined) {
			warnings.push('badge pixel set omitted: trace has no defined badge ref');
			continue;
		}
		if (drawable.pixels.length === 0) {
			warnings.push(
				`badge pixel set '${drawable.ref}' omitted: trace contains an empty exact pixel set`
			);
			continue;
		}
		if (!acceptedBadgeRefs.has(drawable.ref)) {
			warnings.push(
				`badge pixel set '${drawable.ref}' omitted: ref does not match a defined accepted badge`
			);
			continue;
		}
		badgePixels.push(drawable);
	}
	const survivingBadgeRefs = new Set(badgePixels.map((drawable) => drawable.ref));
	for (const badge of acceptedBadges) {
		if (badge.ref !== undefined && !survivingBadgeRefs.has(badge.ref))
			warnings.push(
				`accepted badge '${badge.ref}' omitted: no surviving exact bright-mask pixel set`
			);
	}

	const basketUnit = run.units.find((unit) => unit.id === 'baskets');
	const basketTips = (basketUnit?.drawables ?? [])
		.filter(
			(drawable) =>
				drawable.type === 'point' &&
				(drawable.visualRole === 'basket-tip' || drawable.ref?.endsWith(':semantic-tip'))
		)
		.map((drawable): Drawable => ({
			...drawable,
			visualRole: 'basket-tip'
		}));

	// Exact visible tee pixels and membership remain teeFamily testimony.  The
	// default-OFF min-area pose may replace only the cyan/red
	// presentation pose; a rejected fit therefore cannot make an accepted tee
	// disappear.
	const visiblePlan = planForRunFeature(run, 'teeFamily', 'teeFamily');
	const minAreaPoseEnabled = run.features.teeMinAreaPose?.enabled === true;
	const visiblePosePlan = minAreaPoseEnabled
		? planForRunFeature(run, 'teeMinAreaPose', 'teeMinAreaPose')
		: visiblePlan;
	const visible = planDrawables(visiblePosePlan);
	const visibleTestimony = run.units.find((unit) => unit.id === 'teeFamily')?.drawables ?? [];
	const visibleBorders = visibleTestimony.filter(
		(drawable) => drawable.visualRole === 'tee-border' && drawable.verdict === 'accepted'
	);
	const acceptedVisibleRefs = new Set<string>();
	for (const border of visibleBorders) {
		if (border.ref === undefined)
			warnings.push(
				'accepted visible tee has no defined ref; exact white-component pixels cannot be associated'
			);
		else acceptedVisibleRefs.add(border.ref);
	}
	const visiblePixels: Drawable[] = [];
	for (const drawable of visibleTestimony) {
		if (
			drawable.type !== 'pixelSet' ||
			drawable.verdict !== 'info' ||
			drawable.visualRole !== 'tee-visible-pixels'
		)
			continue;
		if (drawable.ref === undefined) {
			warnings.push('visible tee pixel set omitted: trace has no defined tee ref');
			continue;
		}
		if (drawable.pixels.length === 0) {
			warnings.push(
				`visible tee pixel set '${drawable.ref}' omitted: trace contains an empty exact pixel set`
			);
			continue;
		}
		if (!acceptedVisibleRefs.has(drawable.ref)) {
			warnings.push(
				`visible tee pixel set '${drawable.ref}' omitted: ref does not match a defined accepted visible tee`
			);
			continue;
		}
		visiblePixels.push(drawable);
	}
	const survivingVisibleRefs = new Set(visiblePixels.map((drawable) => drawable.ref));
	for (const border of visibleBorders) {
		if (border.ref !== undefined && !survivingVisibleRefs.has(border.ref))
			warnings.push(
				`accepted visible tee '${border.ref}' omitted: no surviving exact white-component pixel set`
			);
	}
	const visibleDiagonals = visible.filter((drawable) => drawable.visualRole === 'tee-diagonal');
	const visibleCorners = visible.filter((drawable) => drawable.visualRole === 'tee-corner-tick');

	const recoveryPlan = planForRunFeature(run, 'teeRecovery', 'teeRecovery');
	const recovery = planDrawables(recoveryPlan);
	const recoveredShards = recovery.filter(
		(drawable) => drawable.visualRole === 'tee-shard' && drawable.verdict === 'accepted'
	);
	const recoveryDiagonals = recovery.filter((drawable) => drawable.visualRole === 'tee-diagonal');
	const recoveryCorners = recovery.filter((drawable) => drawable.visualRole === 'tee-corner-tick');

	const phantomPlan = planForRunFeature(run, 'phantomTee', 'phantomTee');
	const phantomCenters = planDrawables(phantomPlan).filter(
		(drawable) => drawable.visualRole === 'phantom-center' && drawable.verdict === 'accepted'
	);
	const straight = straightDrawables(run);
	const straightAccepted = straight.filter((drawable) => drawable.verdict === 'accepted');
	const teeBadgeLockUnit = run.units.find((unit) => unit.id === 'teeBadgeLock');
	const teeBadgeLockReceipt = teeBadgeLockUnit
		? buildTeeBadgeLockReceipt(teeBadgeLockUnit, run)
		: undefined;
	// The producer receipt has already selected accepted tee-badge polylines.
	// Forward those exact objects as the first unified visual layer; no path
	// geometry, IDs, or candidate state is reconstructed in Sweep.
	const teeBadgePaths = teeBadgeLockReceipt?.plan.layers.flatMap((layer) => layer.drawables) ?? [];
	const badgeGlyphTemplateUnit = run.units.find((unit) => unit.id === 'badgeGlyphTemplate');
	const badgeGlyphTemplateReceipt = badgeGlyphTemplateUnit
		? buildBadgeGlyphTemplateReceipt(badgeGlyphTemplateUnit, run)
		: undefined;
	const gate = endpointGateSpan(run);

	// Post-assignment hole numbers, drawn beside each ASSIGNED tee and basket.
	// Labels come verbatim from the final hole-labeled assignment rows (the
	// same rows the HOLE ASSIGNMENTS table prints), so the image and the table
	// can never disagree. Painted as the LAST layer for visibility, but the
	// hole-label painter refuses to overwrite any exact testimony color, so
	// pixel counts (badge/tee pixel sets etc.) are never corrupted.
	const holeLabelDrawables: Drawable[] = [];
	if (input.assignmentRows && input.endpointPositions) {
		const teePosition = new Map(input.endpointPositions.tees.map((tee) => [tee.id, tee]));
		const basketPosition = new Map(
			input.endpointPositions.baskets.map((basket) => [basket.id, basket])
		);
		const LABEL_SCALE = 3;
		for (const row of input.assignmentRows) {
			const label = row.hole === 'UNREAD' ? '?' : row.hole;
			const tee = teePosition.get(row.teeId);
			if (tee) {
				holeLabelDrawables.push({
					type: 'pixelSet',
					verdict: 'info',
					visualRole: 'hole-label',
					ref: `hole-label:${row.teeId}`,
					pixels: holeLabelPixels(label, tee.xPx + 13, tee.yPx - 11, LABEL_SCALE)
				});
			} else {
				warnings.push(
					`hole label for ${row.teeId} (hole ${label}) omitted: no canonical tee position was supplied`
				);
			}
			const basket = basketPosition.get(row.basketId);
			if (basket) {
				holeLabelDrawables.push({
					type: 'pixelSet',
					verdict: 'info',
					visualRole: 'hole-label',
					ref: `hole-label:${row.basketId}`,
					pixels: holeLabelPixels(label, basket.xPx + 7, basket.yPx + 3, LABEL_SCALE)
				});
			} else {
				warnings.push(
					`hole label for ${row.basketId} (hole ${label}) omitted: no canonical basket position was supplied`
				);
			}
		}
	}

	const plan: FeatureRenderPlan = {
		title: `${gate} endpoint receipt (${run.configName})`,
		base: 'g0.canonical',
		layers: [
			...(run.straightTest
				? [
						{
							name: 'straight-test geometry (G5, trace-emitted)',
							note: 'tee axis, tee-to-badge ray, tee-to-basket chord, projection/perpendicular, and provisional/abstention marks exactly as emitted by S0',
							drawables: straight
						}
					]
				: []),
			{
				name: 'tee→badge ownership locks (G4)',
				note: 'thin #00a2ff accepted producer-emitted tee→badge paths; exact routed testimony only',
				drawables: teeBadgePaths
			},
			{
				name: 'badge white pixels (G1)',
				note: 'yellow exact bright-mask pixels emitted by the badge detector; black badge pixels remain untouched',
				drawables: badgePixels
			},
			{
				name: 'basket semantic tips (G2)',
				note: 'tiny magenta diamonds at the downstream basket endpoints',
				drawables: basketTips
			},
			{
				name: 'visible tee white components (G3)',
				note: 'exact accepted detector-owned bright-mask component pixels, recolored green',
				drawables: visiblePixels
			},
			{
				name: 'recovered tee visible shards (G4)',
				note: 'only exact non-occluded white pixels accepted by recovery',
				drawables: recoveredShards
			},
			{
				name: 'tee fitted-center diagonals (G3-G4)',
				note: 'one-pixel red opposite-corner diagonals',
				drawables: [...visibleDiagonals, ...recoveryDiagonals]
			},
			{
				name: 'tee pose corners (G3-G4)',
				note: 'cyan pluses aligned to each fitted pad pose',
				drawables: [...visibleCorners, ...recoveryCorners]
			},
			...(phantomCenters.length
				? [
						{
							name: 'assignment-only phantom tee centers (G4)',
							note: 'violet marks; no appearance claim',
							drawables: phantomCenters
						}
					]
				: []),
			{
				name: 'assigned hole numbers (post-G6, final assignment rows)',
				note: 'orange bitmap hole number with 1px black outline beside each assigned tee and basket tip; painted last for visibility but never over an exact testimony color',
				drawables: holeLabelDrawables
			}
		],
		notes: []
	};

	const canvas = input.canvas ?? {
		widthPx: PNG.sync.read(readFileSync(base.pngPath)).width,
		heightPx: PNG.sync.read(readFileSync(base.pngPath)).height,
		source: base.source
	};
	const pngPath = resolve(outDir, 'run.visual.png');
	const receiptPath = resolve(outDir, 'run.visual.receipt.txt');
	writeRasterProof(plan, base, canvas.widthPx, canvas.heightPx, pngPath);

	const recoveredVisibleComponents = recoveredShards.reduce(
		(sum, drawable) => sum + (drawable.values?.supportingComponents ?? 0),
		0
	);
	const expectedRecoverNum = visiblePlan
		? Math.max(0, acceptedBadges.length - visibleBorders.length)
		: undefined;
	const recoveryScheduled = run.units.some((candidate) => candidate.id === 'teeRecovery');
	const phantomScheduled = run.units.some((candidate) => candidate.id === 'phantomTee');
	const rejectedLines = rejectionReceiptLines(run, [
		{ id: 'baskets', gate: 'G2' },
		{ id: 'tees', gate: 'G3' },
		{ id: 'teeFamily', gate: 'G3' },
		{ id: 'teeMinAreaPose', gate: 'G3' },
		{ id: 'teeRecovery', gate: 'G4' },
		{ id: 'phantomTee', gate: 'G4' },
		{ id: 'teeBadgeLock', gate: 'G4' },
		{ id: 'straightTest', gate: 'G5' }
	]);
	const receiptText = [
		'VISUAL RENDER RECEIPT',
		`title: ${plan.title}`,
		`config: ${run.configName}`,
		...(run.straightTest
			? [
					`runId: ${run.runId ?? 'UNKNOWN'}`,
					`imageId: ${run.imageId ?? 'UNKNOWN'}`
				]
			: []),
		`paramsHash: ${run.paramsHash || 'UNKNOWN'}`,
		...(run.straightTest ? [`traceHash: ${run.traceHash ?? 'UNKNOWN'}`] : []),
		`gateSpan: ${endpointGateSpan(run)} (highest gate with drawn endpoint testimony; later analysis gates in the run draw nothing here)`,
		`base: ${base.pngPath}`,
		`canvas: ${canvas.widthPx}x${canvas.heightPx} (${canvas.source})`,
		`coordinateTransform: ${
			input.sourceFrameOffset
				? `canonical = original + (${input.sourceFrameOffset.xPx},${input.sourceFrameOffset.yPx}) (${input.sourceFrameOffset.source})`
				: 'UNKNOWN -- stitched/multi-source frame has no single inverse source mapping'
		}`,
		'',
		'ACCEPTED ENDPOINT TESTIMONY',
		`teeBadgeLocks: ${teeBadgePaths.length} (source: accepted producer-emitted tee-badge-path polylines)`,
		`badges: ${acceptedBadges.length} (source: accepted badge boxes in trace unit 'badges')`,
		`badgeBrightPixelSets: ${badgePixels.length} (source: info pixelSet drawables with visualRole='badge-pixels')`,
		`badgeBrightPixels: ${badgePixels.reduce((sum, drawable) => sum + (drawable.type === 'pixelSet' ? drawable.pixels.length : 0), 0)} (source: total cells in surviving exact badge pixel sets)`,
		`basketSemanticTips: ${basketTips.length}`,
		`visibleTeeBorders: ${visibleBorders.length}`,
		`visibleTeePixelSets: ${visiblePixels.length}`,
		`visibleTeePixels: ${visiblePixels.reduce((sum, drawable) => sum + (drawable.type === 'pixelSet' ? drawable.pixels.length : 0), 0)}`,
		`expectedRecoverNum: ${
			expectedRecoverNum === undefined
				? 'UNKNOWN -- visible tee gate was not scheduled'
				: `${expectedRecoverNum} (math: max(0, badges - visibleTeeBorders))`
		}`,
		`recoveredTeePoses: ${
			recoveryScheduled
				? recoveredShards.length
				: "NOT-SCHEDULED (no 'teeRecovery' unit in this run; 'never ran' is not 0)"
		}`,
		`recoveredVisibleComponents: ${
			recoveryScheduled
				? recoveredVisibleComponents
				: "NOT-SCHEDULED (no 'teeRecovery' unit in this run)"
		}`,
		`phantomTeeCenters: ${
			phantomScheduled
				? phantomCenters.length
				: "NOT-SCHEDULED (no 'phantomTee' unit in this run; the feature is default-OFF)"
		}`,
		`teeCornerMarks: ${visibleCorners.length + recoveryCorners.length}`,
		`teeCenterDiagonals: ${visibleDiagonals.length + recoveryDiagonals.length}`,
		`holeNumberAnnotations: ${
			input.assignmentRows === undefined
				? "NOT-SCHEDULED (no final assignment rows; 'never ran' is not 0)"
				: input.endpointPositions === undefined
					? 'UNKNOWN (assignment rows exist but no endpoint positions were supplied to the renderer)'
					: `${holeLabelDrawables.length} (source: final post-G6 hole-labeled assignment rows; one orange label per assigned tee and per assigned basket tip)`
		}`,
		...(teeBadgeLockReceipt ? ['', teeBadgeLockReceipt.cliText] : []),
		...(badgeGlyphTemplateReceipt ? ['', badgeGlyphTemplateReceipt.cliText] : []),
		'',
		...holeAssignmentLines(input.assignmentRows),
		'',
		'VISUAL CONTRACT',
		'yellow: exact detector-known white/bright badge pixels only (pixelSet; black badge pixels untouched)',
		'magenta: basket semantic tip (tiny diamond)',
		'green: exact detector-owned visible tee white-component pixels or exact recovered shard pixels',
		'cyan: four pose-aligned tee corner pluses',
		'red: thinnest opposite-corner X; intersection is fitted center',
		'violet: assignment-only phantom center; appearance UNKNOWN',
		'blue: exact accepted tee→badge lock path emitted by teeBadgeLock; thin #00a2ff, no geometry recomputation',
		'orange: assigned hole number (post-G6 final assignment rows, same mapping as HOLE ASSIGNMENTS; ? = UNREAD digit) beside each assigned tee and basket tip; black-outlined, painted last for visibility but never overwriting an exact testimony color, so pixel counts stay uncorrupted',
		'rejections: text only, never drawn over accepted geometry',
		'',
		'REJECTIONS RETAINED IN TRACE',
		...(rejectedLines.length ? rejectedLines : ['  none recorded in scheduled endpoint units']),
		...(run.straightTest ? ['', ...straightReceiptLines(run)] : []),
		'',
		`image: ${pngPath}`,
		`receipt: ${receiptPath}`
	].join('\n');
	writeFileSync(receiptPath, `${receiptText}\n`);

	const all = plan.layers.flatMap((layer) => layer.drawables);
	const rejectedCount = run.units
		.filter((unit) =>
			[
				'baskets',
				'tees',
				'teeFamily',
				'teeMinAreaPose',
				'teeRecovery',
				'phantomTee',
				'teeBadgeLock',
				'straightTest'
			].includes(unit.id)
		)
		.flatMap((unit) => unit.drawables)
		.filter((drawable) => drawable.verdict === 'rejected').length;
	const semanticAcceptedCount =
		straightAccepted.length +
		badgePixels.length +
		basketTips.length +
		visibleBorders.length +
		recoveredShards.length +
		phantomCenters.length;
	const endpointResult: FeatureRenderResult = {
		featureId: 'endpointReceipt',
		unitId: 'run',
		gate,
		title: plan.title,
		drawableCount: all.length,
		acceptedCount: semanticAcceptedCount,
		rejectedCount,
		filesWritten: [pngPath, receiptPath],
		receiptText,
		// Union of the receipts-hardening truth ("never ran" is not 0) and the
		// PR #61 tee→badge lock testimony.
		summary:
			`${acceptedBadges.length} badges + ${basketTips.length} baskets + ` +
			`${visibleBorders.length} visible tees + ` +
			`${recoveryScheduled ? `${recoveredShards.length} recovered tees` : 'recovery not-scheduled'} + ` +
			`${teeBadgePaths.length} tee→badge locks in one endpoint image`,
		warnings
	};
	const minAreaPoseUnit = run.units.find((unit) => unit.id === 'teeMinAreaPose');
	const minAreaPoseFeature = ALL_FEATURES.find((feature) => feature.id === 'teeMinAreaPose');
	const minAreaPoseResults: FeatureRenderResult[] = [];
	if (minAreaPoseUnit && run.features.teeMinAreaPose?.enabled && minAreaPoseFeature?.render) {
		// The unified endpoint poster intentionally carries many endpoints. This
		// dedicated A/B sidecar is the one-to-one feature proof: its plan and
		// CLI are both selector projections of the same actual G3 drawables.
		const minAreaPoseReceipt = buildTeeMinAreaPoseReceipt(minAreaPoseUnit, run);
		const featureResult = writePlan(
			minAreaPoseFeature.render.draw(minAreaPoseUnit, run),
			minAreaPoseFeature,
			minAreaPoseUnit,
			input,
			[]
		);
		const cliPath = resolve(outDir, 'feature.teeMinAreaPose.teeMinAreaPose.cli.txt');
		writeFileSync(cliPath, `${minAreaPoseReceipt.cliText}\n`);
		minAreaPoseResults.push({
			...featureResult,
			filesWritten: [...featureResult.filesWritten, cliPath],
			receiptText: `${featureResult.receiptText}\nmatched CLI receipt: ${cliPath}`,
			summary: `${featureResult.summary}; matched CLI receipt uses the same ${minAreaPoseReceipt.rows.length} producer drawables`
		});
	}
	return {
		results: [endpointResult, ...minAreaPoseResults],
		unrenderedUnits: [],
		unmatchedRenders: []
	};
}

// ---------------------------------------------------------------------------
// Presentation. SVG because it is text (diffable, greppable), needs no
// encoder, carries a <title> tooltip per drawable so the REASON is readable
// by hovering, and can sit over a PNG the kind-keyed path already wrote.
// ---------------------------------------------------------------------------

const STYLE: Record<Drawable['verdict'], { stroke: string; fill: string; dash: string }> = {
	accepted: { stroke: '#39ff7a', fill: 'rgba(57,255,122,0.14)', dash: 'none' },
	rejected: { stroke: '#ff4d4d', fill: 'rgba(255,77,77,0.12)', dash: 'none' },
	info: { stroke: '#4dd2ff', fill: 'none', dash: '5 4' }
};

const TEE_CENTER_STYLE = { stroke: '#39ff7a', fill: 'none', dash: 'none' };
const TEE_CORNER_STYLE = { stroke: '#4dd2ff', fill: 'none', dash: 'none' };
const TEE_DIAGONAL_STYLE = { stroke: '#ff2020', fill: 'none', dash: 'none' };
const PHANTOM_STYLE = { stroke: '#c56bff', fill: 'rgba(197,107,255,0.12)', dash: 'none' };
const BADGE_PIXELS_STYLE = { stroke: '#ffe11e', fill: 'none', dash: 'none' };
const BASKET_TIP_STYLE = { stroke: '#ff28dc', fill: 'none', dash: 'none' };
const TEE_PIXELS_STYLE = { stroke: '#1eff5f', fill: 'none', dash: 'none' };
const TEE_BADGE_PATH_STYLE = { stroke: '#00a2ff', fill: 'none', dash: 'none' };

function isBadgePixels(drawable: Drawable): boolean {
	return drawable.type === 'pixelSet' && drawable.visualRole === 'badge-pixels';
}

function isHoleLabel(drawable: Drawable): boolean {
	return drawable.type === 'pixelSet' && drawable.visualRole === 'hole-label';
}

/** Exact testimony colors a hole-number label must NEVER overwrite: receipt
 * pixel counts (badge/tee pixel sets etc.) are verified against these exact
 * colors in the written PNG, so annotation paints around them. */
const HOLE_LABEL_PROTECTED_COLORS: ReadonlySet<number> = new Set(
	[
		[255, 225, 30], // badge bright pixels (yellow)
		[255, 40, 220], // basket semantic tip (magenta)
		[30, 255, 95], // tee visible/shard pixels (green)
		[0, 162, 255], // tee-badge lock path (blue)
		[255, 32, 32], // tee fitted-center diagonal (red)
		[57, 255, 122], // tee center marker
		[30, 210, 255], // corner ticks / info (cyan)
		[197, 107, 255], // phantom center (violet)
		[255, 45, 45] // rejected marks (red)
	].map(([r, g, b]) => (r << 16) | (g << 8) | b)
);

/** 3x5 bitmap glyphs for hole-number annotation (digits plus '?' for UNREAD).
 * Rendered at integer scale as a pixelSet, so the label paints through the
 * exact same rasterDrawable path as every other testimony pixel. */
const HOLE_LABEL_GLYPHS: Readonly<Record<string, readonly string[]>> = {
	'0': ['111', '101', '101', '101', '111'],
	'1': ['010', '110', '010', '010', '111'],
	'2': ['111', '001', '111', '100', '111'],
	'3': ['111', '001', '111', '001', '111'],
	'4': ['101', '101', '111', '001', '001'],
	'5': ['111', '100', '111', '001', '111'],
	'6': ['111', '100', '111', '101', '111'],
	'7': ['111', '001', '010', '010', '010'],
	'8': ['111', '101', '111', '101', '111'],
	'9': ['111', '101', '111', '001', '111'],
	'?': ['111', '001', '011', '000', '010']
};

/** Pixel cells for `text` drawn with its glyph top-left at (xPx, yPx). */
function holeLabelPixels(
	text: string,
	xPx: number,
	yPx: number,
	scale: number
): [number, number][] {
	const cells: [number, number][] = [];
	let cursorX = Math.round(xPx);
	const top = Math.round(yPx);
	for (const character of text) {
		const glyph = HOLE_LABEL_GLYPHS[character] ?? HOLE_LABEL_GLYPHS['?'];
		for (let row = 0; row < glyph.length; row++) {
			for (let column = 0; column < glyph[row].length; column++) {
				if (glyph[row][column] !== '1') continue;
				for (let dy = 0; dy < scale; dy++) {
					for (let dx = 0; dx < scale; dx++) {
						cells.push([cursorX + column * scale + dx, top + row * scale + dy]);
					}
				}
			}
		}
		cursorX += (3 + 1) * scale;
	}
	return cells;
}

function isBasketTip(drawable: Drawable): boolean {
	return drawable.type === 'point' && drawable.visualRole === 'basket-tip';
}

function isTeePixels(drawable: Drawable): boolean {
	return drawable.type === 'pixelSet' && drawable.visualRole === 'tee-visible-pixels';
}

function isCenterMarker(drawable: Drawable): boolean {
	return drawable.type === 'point' && drawable.visualRole === 'tee-center';
}

function isTeeBorderMarker(drawable: Drawable): boolean {
	return drawable.type === 'point' && drawable.visualRole === 'tee-border';
}

function isTeeFamilyPoint(drawable: Drawable, layerName?: string): boolean {
	return drawable.type === 'point' && (layerName?.includes('tee-family') ?? false);
}

function isRejectedTeeRecoveryPoint(drawable: Drawable, layerName?: string): boolean {
	const role = (drawable as Drawable & { readonly visualRole?: string }).visualRole;
	return (
		drawable.type === 'point' &&
		(role === 'tee-rejection' || (layerName?.includes('tee recovery candidates rejected') ?? false))
	);
}

function isCornerMarker(drawable: Drawable): boolean {
	return drawable.type === 'point' && drawable.visualRole === 'tee-corner-tick';
}

function isTeeDiagonal(drawable: Drawable): boolean {
	return drawable.type === 'polyline' && drawable.visualRole === 'tee-diagonal';
}

function isTeeBadgePath(drawable: Drawable): boolean {
	return drawable.type === 'polyline' && drawable.visualRole === 'tee-badge-path';
}

function isPhantomMarker(drawable: Drawable): boolean {
	return drawable.type === 'point' && drawable.visualRole === 'phantom-center';
}

function styleFor(drawable: Drawable): { stroke: string; fill: string; dash: string } {
	if (isBadgePixels(drawable)) return BADGE_PIXELS_STYLE;
	if (isBasketTip(drawable)) return BASKET_TIP_STYLE;
	if (isTeePixels(drawable)) return TEE_PIXELS_STYLE;
	if (isPhantomMarker(drawable)) return PHANTOM_STYLE;
	if (isCenterMarker(drawable)) return TEE_CENTER_STYLE;
	if (isCornerMarker(drawable)) return TEE_CORNER_STYLE;
	if (isTeeDiagonal(drawable)) return TEE_DIAGONAL_STYLE;
	if (isTeeBadgePath(drawable)) return TEE_BADGE_PATH_STYLE;
	return STYLE[drawable.verdict];
}

function strokeWidthFor(drawable: Drawable): number {
	return isBasketTip(drawable) || isCornerMarker(drawable) || isTeeDiagonal(drawable) || isTeeBadgePath(drawable) ? 1 : 2;
}

function svgNumber(value: number): string {
	return String(Number(value.toFixed(4)));
}

function esc(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

function safeSegment(s: string): string {
	return s.replace(/[^a-zA-Z0-9_.-]+/g, '_');
}

function valuesText(values: Drawable['values']): string {
	if (!values) return '[]';
	return `[${Object.entries(values)
		.map(([key, value]) => `${key}=${Number(value.toFixed(4))}`)
		.join(',')}]`;
}

function drawableCoordinates(
	drawable: Drawable,
	offset: RenderTraceFeaturesInput['sourceFrameOffset']
): { canonical: string; original: string } {
	const shift = (x: number, y: number) =>
		offset ? `(${(x - offset.xPx).toFixed(2)},${(y - offset.yPx).toFixed(2)})` : 'UNKNOWN';
	if (drawable.type === 'point') {
		return {
			canonical: `(${drawable.xPx.toFixed(2)},${drawable.yPx.toFixed(2)})`,
			original: shift(drawable.xPx, drawable.yPx)
		};
	}
	if (drawable.type === 'box') {
		const [x, y, width, height] = drawable.bbox;
		return {
			canonical: `bbox=(${x.toFixed(2)},${y.toFixed(2)},${width.toFixed(2)},${height.toFixed(2)})`,
			original: offset
				? `bbox=(${(x - offset.xPx).toFixed(2)},${(y - offset.yPx).toFixed(2)},${width.toFixed(2)},${height.toFixed(2)})`
				: 'UNKNOWN'
		};
	}
	if (drawable.type === 'polyline') {
		return {
			canonical: `path=${JSON.stringify(drawable.path)}`,
			original: offset
				? `path=${JSON.stringify(drawable.path.map(([x, y]) => [x - offset.xPx, y - offset.yPx]))}`
				: 'UNKNOWN'
		};
	}
	if (drawable.type === 'pixelSet') {
		return {
			canonical: `pixels=${JSON.stringify(drawable.pixels)}`,
			original: offset
				? `pixels=${JSON.stringify(drawable.pixels.map(([x, y]) => [x - offset.xPx, y - offset.yPx]))}`
				: 'UNKNOWN'
		};
	}
	return {
		canonical: `origin=(${drawable.originXPx.toFixed(2)},${drawable.originYPx.toFixed(2)}) cells=${drawable.widthCells}x${drawable.heightCells} cellPx=${drawable.cellPx}`,
		original: shift(drawable.originXPx, drawable.originYPx)
	};
}

function tooltip(d: Drawable, layerName: string): string {
	const parts = [`${layerName} | ${d.verdict}`];
	if (d.ref) parts.push(`ref=${d.ref}`);
	if (d.reason) parts.push(`reason: ${d.reason}`);
	if (d.values) for (const [k, v] of Object.entries(d.values)) parts.push(`${k}=${v}`);
	return parts.join('\n');
}

/** Extent over every drawable, used ONLY when the caller could not supply
 * the image size. Reported as derived, never as the image's dimensions. */
function drawableExtent(plan: FeatureRenderPlan): { widthPx: number; heightPx: number } {
	let maxX = 0;
	let maxY = 0;
	for (const layer of plan.layers) {
		for (const d of layer.drawables) {
			if (d.type === 'point') {
				maxX = Math.max(maxX, d.xPx);
				maxY = Math.max(maxY, d.yPx);
			} else if (d.type === 'box') {
				maxX = Math.max(maxX, d.bbox[0] + d.bbox[2]);
				maxY = Math.max(maxY, d.bbox[1] + d.bbox[3]);
			} else if (d.type === 'polyline') {
				for (const [x, y] of d.path) {
					maxX = Math.max(maxX, x);
					maxY = Math.max(maxY, y);
				}
			} else if (d.type === 'pixelSet') {
				for (const [x, y] of d.pixels) {
					maxX = Math.max(maxX, x);
					maxY = Math.max(maxY, y);
				}
			} else {
				maxX = Math.max(maxX, d.originXPx + d.widthCells * d.cellPx);
				maxY = Math.max(maxY, d.originYPx + d.heightCells * d.cellPx);
			}
		}
	}
	return { widthPx: Math.ceil(maxX) + 16, heightPx: Math.ceil(maxY) + 16 };
}

function drawableSvg(d: Drawable, layerName: string): string {
	const s = styleFor(d);
	const title = `<title>${esc(tooltip(d, layerName))}</title>`;
	const semantics = `${d.visualRole ? ` data-visual-role="${esc(d.visualRole)}"` : ''}${d.ref ? ` data-ref="${esc(d.ref)}"` : ''}`;
	const common = `stroke="${s.stroke}" stroke-width="${strokeWidthFor(d)}" stroke-dasharray="${s.dash}" fill="${s.fill}" vector-effect="non-scaling-stroke"${semantics}`;
	if (d.type === 'point') {
		if (isBasketTip(d)) {
			const r = 3;
			return `<g>${title}<path d="M${d.xPx} ${d.yPx - r} L${d.xPx + r} ${d.yPx} L${d.xPx} ${d.yPx + r} L${d.xPx - r} ${d.yPx} Z" ${common} fill="none"/></g>`;
		}
		if (isPhantomMarker(d)) {
			const r = 6;
			return `<g>${title}<path d="M${d.xPx} ${d.yPx - r} L${d.xPx + r} ${d.yPx} L${d.xPx} ${d.yPx + r} L${d.xPx - r} ${d.yPx} Z" ${common}/><path d="M${d.xPx - 4} ${d.yPx} L${d.xPx + 4} ${d.yPx} M${d.xPx} ${d.yPx - 4} L${d.xPx} ${d.yPx + 4}" stroke="${s.stroke}" stroke-width="2" fill="none"/></g>`;
		}
		if (isCenterMarker(d)) {
			const r = 4;
			return `<g>${title}<path d="M${d.xPx - r} ${d.yPx} L${d.xPx + r} ${d.yPx} M${d.xPx} ${d.yPx - r} L${d.xPx} ${d.yPx + r}" ${common} fill="none"/></g>`;
		}
		if (isCornerMarker(d)) {
			const r = 3;
			const angle = d.values?.teeAxisAngleRad ?? 0;
			const axisX = Math.cos(angle) * r;
			const axisY = Math.sin(angle) * r;
			const normalX = -Math.sin(angle) * r;
			const normalY = Math.cos(angle) * r;
			const path =
				`M${svgNumber(d.xPx - axisX)} ${svgNumber(d.yPx - axisY)} ` +
				`L${svgNumber(d.xPx + axisX)} ${svgNumber(d.yPx + axisY)} ` +
				`M${svgNumber(d.xPx - normalX)} ${svgNumber(d.yPx - normalY)} ` +
				`L${svgNumber(d.xPx + normalX)} ${svgNumber(d.yPx + normalY)}`;
			return `<g>${title}<path d="${path}" ${common} fill="none"/></g>`;
		}
		if (
			isTeeBorderMarker(d) ||
			isTeeFamilyPoint(d, layerName) ||
			isRejectedTeeRecoveryPoint(d, layerName)
		) {
			const r = 5;
			return `<g>${title}<path d="M${d.xPx - r} ${d.yPx} L${d.xPx + r} ${d.yPx} M${d.xPx} ${d.yPx - r} L${d.xPx} ${d.yPx + r}" ${common} fill="none"/></g>`;
		}
		// A rejection gets a cross as well as a circle so accepted vs rejected
		// survives a greyscale print and a colour-blind reader.
		const cross =
			d.verdict === 'rejected'
				? `<path d="M${d.xPx - 7} ${d.yPx - 7} L${d.xPx + 7} ${d.yPx + 7} M${d.xPx + 7} ${d.yPx - 7} L${d.xPx - 7} ${d.yPx + 7}" stroke="${s.stroke}" stroke-width="2" fill="none"/>`
				: '';
		return `<g>${title}<circle cx="${d.xPx}" cy="${d.yPx}" r="7" ${common}/>${cross}</g>`;
	}
	if (d.type === 'box') {
		const [x, y, w, h] = d.bbox;
		return `<g>${title}<rect x="${x}" y="${y}" width="${w}" height="${h}" ${common}/></g>`;
	}
	if (d.type === 'polyline') {
		const points = d.path.map(([x, y]) => `${x},${y}`).join(' ');
		return `<g>${title}<polyline points="${points}" ${common} fill="none"/></g>`;
	}
	if (d.type === 'pixelSet') {
		const cells = d.pixels.map(([x, y]) => `M${x - 0.5} ${y - 0.5}h1v1h-1z`).join('');
		return `<g>${title}<path d="${cells}" fill="${s.stroke}" stroke="none"/></g>`;
	}
	// Heatmap payloads ride RunTrace.heatmaps out of band. Drawing the cells
	// would mean reading a buffer this module was not handed, so only the
	// footprint is outlined and the receipt says so.
	const w = d.widthCells * d.cellPx;
	const h = d.heightCells * d.cellPx;
	return `<g>${title}<rect x="${d.originXPx}" y="${d.originYPx}" width="${w}" height="${h}" stroke="${s.stroke}" stroke-width="2" stroke-dasharray="6 5" fill="none"/></g>`;
}

function rasterPixel(
	data: Uint8Array,
	width: number,
	height: number,
	x: number,
	y: number,
	color: readonly [number, number, number]
): void {
	const px = Math.round(x);
	const py = Math.round(y);
	if (px < 0 || py < 0 || px >= width || py >= height) return;
	const index = (py * width + px) * 4;
	data[index] = color[0];
	data[index + 1] = color[1];
	data[index + 2] = color[2];
	data[index + 3] = 255;
}

function rasterLine(
	data: Uint8Array,
	width: number,
	height: number,
	x0: number,
	y0: number,
	x1: number,
	y1: number,
	color: readonly [number, number, number]
): void {
	const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))));
	for (let step = 0; step <= steps; step++) {
		const t = step / steps;
		for (let thickness = -1; thickness <= 1; thickness++) {
			rasterPixel(data, width, height, x0 + (x1 - x0) * t + thickness, y0 + (y1 - y0) * t, color);
			rasterPixel(data, width, height, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t + thickness, color);
		}
	}
}

function rasterLineThin(
	data: Uint8Array,
	width: number,
	height: number,
	x0: number,
	y0: number,
	x1: number,
	y1: number,
	color: readonly [number, number, number]
): void {
	const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))));
	for (let step = 0; step <= steps; step++) {
		const t = step / steps;
		rasterPixel(data, width, height, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, color);
	}
}

function rasterOrientedPlus(
	data: Uint8Array,
	width: number,
	height: number,
	x: number,
	y: number,
	angleRad: number,
	radius: number,
	color: readonly [number, number, number]
): void {
	const axisX = Math.cos(angleRad) * radius;
	const axisY = Math.sin(angleRad) * radius;
	const normalX = -Math.sin(angleRad) * radius;
	const normalY = Math.cos(angleRad) * radius;
	rasterLineThin(data, width, height, x - axisX, y - axisY, x + axisX, y + axisY, color);
	rasterLineThin(data, width, height, x - normalX, y - normalY, x + normalX, y + normalY, color);
}

function rasterDrawable(
	data: Uint8Array,
	width: number,
	height: number,
	drawable: Drawable,
	layerName?: string
): void {
	if (isHoleLabel(drawable) && drawable.type === 'pixelSet') {
		// Hole-number labels paint OVER the scene for visibility, with a 1px
		// black outline for contrast -- but never overwrite an exact testimony
		// color, so every receipt pixel count stays byte-accurate.
		const paint = (x: number, y: number, c: readonly [number, number, number]) => {
			const xi = Math.round(x);
			const yi = Math.round(y);
			if (xi < 0 || yi < 0 || xi >= width || yi >= height) return;
			const i = (yi * width + xi) * 4;
			if (HOLE_LABEL_PROTECTED_COLORS.has((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]))
				return;
			data[i] = c[0];
			data[i + 1] = c[1];
			data[i + 2] = c[2];
			data[i + 3] = 255;
		};
		for (const [x, y] of drawable.pixels)
			for (let oy = -1; oy <= 1; oy++)
				for (let ox = -1; ox <= 1; ox++) paint(x + ox, y + oy, [0, 0, 0]);
		for (const [x, y] of drawable.pixels) paint(x, y, [255, 150, 40]);
		return;
	}
	const color: readonly [number, number, number] = isHoleLabel(drawable)
		? [255, 150, 40]
		: isPhantomMarker(drawable)
		? [197, 107, 255]
		: isBadgePixels(drawable)
			? [255, 225, 30]
			: isBasketTip(drawable)
				? [255, 40, 220]
				: isTeePixels(drawable)
					? [30, 255, 95]
					: isTeeBadgePath(drawable)
						? [0, 162, 255]
						: isTeeDiagonal(drawable)
						? [255, 32, 32]
						: isCenterMarker(drawable)
							? [57, 255, 122]
							: drawable.verdict === 'accepted'
								? [30, 255, 95]
								: drawable.verdict === 'rejected'
									? [255, 45, 45]
									: [30, 210, 255];
	if (drawable.type === 'box') {
		const [x, y, w, h] = drawable.bbox;
		rasterLine(data, width, height, x, y, x + w, y, color);
		rasterLine(data, width, height, x + w, y, x + w, y + h, color);
		rasterLine(data, width, height, x + w, y + h, x, y + h, color);
		rasterLine(data, width, height, x, y + h, x, y, color);
		return;
	}
	if (drawable.type === 'point') {
		if (isBasketTip(drawable)) {
			const r = 3;
			rasterLineThin(
				data,
				width,
				height,
				drawable.xPx,
				drawable.yPx - r,
				drawable.xPx + r,
				drawable.yPx,
				color
			);
			rasterLineThin(
				data,
				width,
				height,
				drawable.xPx + r,
				drawable.yPx,
				drawable.xPx,
				drawable.yPx + r,
				color
			);
			rasterLineThin(
				data,
				width,
				height,
				drawable.xPx,
				drawable.yPx + r,
				drawable.xPx - r,
				drawable.yPx,
				color
			);
			rasterLineThin(
				data,
				width,
				height,
				drawable.xPx - r,
				drawable.yPx,
				drawable.xPx,
				drawable.yPx - r,
				color
			);
			return;
		}
		if (isPhantomMarker(drawable)) {
			const r = 6;
			rasterLine(
				data,
				width,
				height,
				drawable.xPx,
				drawable.yPx - r,
				drawable.xPx + r,
				drawable.yPx,
				color
			);
			rasterLine(
				data,
				width,
				height,
				drawable.xPx + r,
				drawable.yPx,
				drawable.xPx,
				drawable.yPx + r,
				color
			);
			rasterLine(
				data,
				width,
				height,
				drawable.xPx,
				drawable.yPx + r,
				drawable.xPx - r,
				drawable.yPx,
				color
			);
			rasterLine(
				data,
				width,
				height,
				drawable.xPx - r,
				drawable.yPx,
				drawable.xPx,
				drawable.yPx - r,
				color
			);
			rasterCross(data, width, height, drawable.xPx, drawable.yPx, color);
			return;
		}
		if (isCornerMarker(drawable)) {
			rasterOrientedPlus(
				data,
				width,
				height,
				drawable.xPx,
				drawable.yPx,
				drawable.values?.teeAxisAngleRad ?? 0,
				3,
				color
			);
			return;
		}
		if (isCenterMarker(drawable)) {
			rasterCrossRadius(data, width, height, drawable.xPx, drawable.yPx, 4, color);
			return;
		}
		if (
			isTeeBorderMarker(drawable) ||
			isTeeFamilyPoint(drawable, layerName) ||
			isRejectedTeeRecoveryPoint(drawable, layerName)
		) {
			rasterCrossRadius(data, width, height, drawable.xPx, drawable.yPx, 5, color);
			return;
		}
		for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 24) {
			rasterPixel(
				data,
				width,
				height,
				drawable.xPx + Math.cos(angle) * 7,
				drawable.yPx + Math.sin(angle) * 7,
				color
			);
		}
		return;
	}
	if (drawable.type === 'polyline') {
		for (let index = 1; index < drawable.path.length; index++) {
			const [x0, y0] = drawable.path[index - 1];
			const [x1, y1] = drawable.path[index];
			if (isTeeDiagonal(drawable) || isTeeBadgePath(drawable)) rasterLineThin(data, width, height, x0, y0, x1, y1, color);
			else rasterLine(data, width, height, x0, y0, x1, y1, color);
		}
		return;
	}
	if (drawable.type === 'pixelSet') {
		for (const [x, y] of drawable.pixels) rasterPixel(data, width, height, x, y, color);
	}
}

function writeRasterProof(
	plan: FeatureRenderPlan,
	base: FeatureRenderBase,
	width: number,
	height: number,
	path: string
): void {
	const png = PNG.sync.read(readFileSync(base.pngPath));
	if (png.width !== width || png.height !== height) {
		throw new Error(
			`feature render base dimensions ${png.width}x${png.height} do not match canvas ${width}x${height}`
		);
	}
	for (const layer of plan.layers) {
		for (const drawable of layer.drawables)
			rasterDrawable(png.data, width, height, drawable, layer.name);
	}
	writeFileSync(path, PNG.sync.write(png));
}

function rasterCircle(
	data: Uint8Array,
	width: number,
	height: number,
	x: number,
	y: number,
	radius: number,
	color: readonly [number, number, number]
): void {
	for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 72) {
		for (let thickness = -1; thickness <= 1; thickness++) {
			rasterPixel(
				data,
				width,
				height,
				x + Math.cos(angle) * (radius + thickness),
				y + Math.sin(angle) * (radius + thickness),
				color
			);
		}
	}
}

function rasterCross(
	data: Uint8Array,
	width: number,
	height: number,
	x: number,
	y: number,
	color: readonly [number, number, number]
): void {
	rasterCrossRadius(data, width, height, x, y, 8, color);
}

function rasterCrossRadius(
	data: Uint8Array,
	width: number,
	height: number,
	x: number,
	y: number,
	radius: number,
	color: readonly [number, number, number]
): void {
	rasterLine(data, width, height, x - radius, y - radius, x + radius, y + radius, color);
	rasterLine(data, width, height, x + radius, y - radius, x - radius, y + radius, color);
}

function writeTruthProof(
	plan: FeatureRenderPlan,
	base: FeatureRenderBase,
	score: GateScore | undefined,
	comparison: GroundingComparison | undefined,
	width: number,
	height: number,
	path: string
): void {
	const png = PNG.sync.read(readFileSync(base.pngPath));
	if (png.width !== width || png.height !== height) {
		throw new Error(
			`feature truth base dimensions ${png.width}x${png.height} do not match canvas ${width}x${height}`
		);
	}
	for (const layer of plan.layers) {
		for (const drawable of layer.drawables)
			rasterDrawable(png.data, width, height, drawable, layer.name);
	}
	const best = comparison
		? [...comparison.hypotheses].sort(
				(a, b) => a.medianDeviationPx - b.medianDeviationPx || a.meanDeviationPx - b.meanDeviationPx
			)[0]
		: undefined;
	for (const match of score?.objectMatches ?? []) {
		const truth = match.truthCanonical;
		const detection = match.detection;
		rasterLine(
			png.data,
			width,
			height,
			detection.xPx,
			detection.yPx,
			truth.xPx,
			truth.yPx,
			[255, 225, 30]
		);
		rasterCircle(png.data, width, height, truth.xPx, truth.yPx, 9, [255, 225, 30]);
		rasterCircle(png.data, width, height, detection.xPx, detection.yPx, 6, [30, 210, 255]);
		if (best && best.yShiftPx !== 0) {
			rasterCircle(
				png.data,
				width,
				height,
				detection.xPx,
				detection.yPx + best.yShiftPx,
				4,
				[255, 40, 220]
			);
		}
	}
	for (const target of score?.unmatchedTruth ?? []) {
		rasterCircle(png.data, width, height, target.point.xPx, target.point.yPx, 10, [255, 40, 40]);
		rasterCross(png.data, width, height, target.point.xPx, target.point.yPx, [255, 40, 40]);
	}
	for (const detection of score?.unownedDetections ?? []) {
		rasterCircle(png.data, width, height, detection.xPx, detection.yPx, 10, [255, 40, 40]);
		rasterCross(png.data, width, height, detection.xPx, detection.yPx, [255, 40, 40]);
	}
	writeFileSync(path, PNG.sync.write(png));
}

function writeTruthCropSheet(truthProofPath: string, score: GateScore, path: string): void {
	const source = PNG.sync.read(readFileSync(truthProofPath));
	const matches = score.objectMatches ?? [];
	const sourceSize = 72;
	const scale = 3;
	const tileSize = sourceSize * scale;
	const columns = Math.min(6, Math.max(1, matches.length));
	const rows = Math.max(1, Math.ceil(matches.length / columns));
	const sheet = new PNG({ width: columns * tileSize, height: rows * tileSize });
	sheet.data.fill(255);
	for (const [index, match] of matches.entries()) {
		const tileX = (index % columns) * tileSize;
		const tileY = Math.floor(index / columns) * tileSize;
		const startX = Math.round(match.truthCanonical.xPx) - sourceSize / 2;
		const startY = Math.round(match.truthCanonical.yPx) - sourceSize / 2;
		for (let y = 0; y < sourceSize; y++) {
			for (let x = 0; x < sourceSize; x++) {
				const sourceX = Math.max(0, Math.min(source.width - 1, startX + x));
				const sourceY = Math.max(0, Math.min(source.height - 1, startY + y));
				const sourceIndex = (sourceY * source.width + sourceX) * 4;
				for (let sy = 0; sy < scale; sy++) {
					for (let sx = 0; sx < scale; sx++) {
						const outputX = tileX + x * scale + sx;
						const outputY = tileY + y * scale + sy;
						const outputIndex = (outputY * sheet.width + outputX) * 4;
						for (let channel = 0; channel < 4; channel++)
							sheet.data[outputIndex + channel] = source.data[sourceIndex + channel];
					}
				}
			}
		}
		const border: readonly [number, number, number] = [255, 225, 30];
		rasterLine(
			sheet.data,
			sheet.width,
			sheet.height,
			tileX,
			tileY,
			tileX + tileSize - 1,
			tileY,
			border
		);
		rasterLine(
			sheet.data,
			sheet.width,
			sheet.height,
			tileX + tileSize - 1,
			tileY,
			tileX + tileSize - 1,
			tileY + tileSize - 1,
			border
		);
		rasterLine(
			sheet.data,
			sheet.width,
			sheet.height,
			tileX + tileSize - 1,
			tileY + tileSize - 1,
			tileX,
			tileY + tileSize - 1,
			border
		);
		rasterLine(
			sheet.data,
			sheet.width,
			sheet.height,
			tileX,
			tileY + tileSize - 1,
			tileX,
			tileY,
			border
		);
	}
	writeFileSync(path, PNG.sync.write(sheet));
}

function truthReceiptLines(unit: UnitTrace, input: RenderTraceFeaturesInput): string[] {
	const score = input.truthEvaluation?.scoreboard?.scores.find(
		(candidate) => candidate.gate === unit.gate
	);
	const comparison = input.truthEvaluation?.groundingComparisons.find(
		(candidate) => candidate.gate === unit.gate
	);
	if (!score && !comparison) {
		return [
			'truth localization: UNKNOWN -- no annotation evaluation was available for this gate',
			'ownership: UNKNOWN -- no ownership evaluation was available for this gate'
		];
	}
	const lines = ['truth localization (evaluation only; never detector input):'];
	if (score) {
		lines.push(
			`  official/as-emitted: detected=${score.detected ?? 'UNKNOWN'} expected=${score.expected} ` +
				`matched=${score.matched} falsePositives=${score.unownedDetections?.length ?? 0} ` +
				`falseNegatives=${score.unmatchedTruth?.length ?? score.misses.length} ` +
				`maxDeviation=${score.maxDeviationPx.toFixed(2)}px (source: TruthScoreboard from this engine board)`
		);
		for (const match of score.objectMatches ?? []) {
			lines.push(
				`    MATCH ${match.truthIdentity} <- ${match.detection.identity} ` +
					`detection=(${match.detection.xPx.toFixed(2)},${match.detection.yPx.toFixed(2)}) ` +
					`truth=(${match.truthCanonical.xPx.toFixed(2)},${match.truthCanonical.yPx.toFixed(2)}) ` +
					`delta=${match.deviationPx.toFixed(2)}px`
			);
		}
		for (const target of score.unmatchedTruth ?? []) {
			lines.push(
				`    FALSE_NEGATIVE ${target.identity} truth=(${target.point.xPx.toFixed(2)},${target.point.yPx.toFixed(2)})`
			);
		}
		for (const detection of score.unownedDetections ?? []) {
			lines.push(
				`    FALSE_POSITIVE ${detection.identity} detection=(${detection.xPx.toFixed(2)},${detection.yPx.toFixed(2)}) ownership=UNKNOWN`
			);
		}
	} else {
		lines.push(
			'  official/as-emitted: UNKNOWN -- annotation source provenance did not pass the truth firewall'
		);
	}
	if (comparison) {
		lines.push(
			`  grounding hypotheses: ${comparison.provenanceTrusted ? 'source provenance MATCHED' : 'DIAGNOSTIC ONLY -- source provenance UNMATCHED'}`
		);
		const ranked = [...comparison.hypotheses].sort(
			(a, b) => a.medianDeviationPx - b.medianDeviationPx || a.meanDeviationPx - b.meanDeviationPx
		);
		for (const [index, hypothesis] of ranked.entries()) {
			lines.push(
				`    ${index === 0 ? 'LOWEST_RESIDUAL ' : ''}${hypothesis.id}: detectionY+=${hypothesis.yShiftPx}px ` +
					`matched=${hypothesis.matchedWithinTolerance} falsePositives=${hypothesis.falsePositiveCount} ` +
					`falseNegatives=${hypothesis.falseNegativeCount} median=${hypothesis.medianDeviationPx.toFixed(2)}px ` +
					`mean=${hypothesis.meanDeviationPx.toFixed(2)}px max=${hypothesis.maxDeviationPx.toFixed(2)}px ` +
					`provenance="${hypothesis.provenance}"`
			);
		}
	}
	lines.push(
		`ownership: UNKNOWN -- ${unit.gate} truth scoring evaluates localization only; no hole ownership assignment was evaluated`
	);
	return lines;
}

function writePlan(
	plan: FeatureRenderPlan,
	feature: ABFeature,
	unit: UnitTrace,
	input: RenderTraceFeaturesInput,
	warnings: string[]
): FeatureRenderResult {
	const { outDir, canvas } = input;
	const bases = input.bases ?? [];
	const base = bases[0];
	const truthScore = input.truthEvaluation?.scoreboard?.scores.find(
		(candidate) => candidate.gate === unit.gate
	);
	const groundingComparison = input.truthEvaluation?.groundingComparisons.find(
		(candidate) => candidate.gate === unit.gate
	);
	const all = plan.layers.flatMap((l) => l.drawables);
	// Counted off the OWNING unit's drawables, not off the flattened plan: a
	// plan may pull in another gate's accepted drawables for context (this
	// feature's does), and folding those into "accepted" would inflate the
	// number this receipt is read for.
	const acceptedCount = verdictOf(unit.drawables, 'accepted').length;
	const rejectedCount = verdictOf(unit.drawables, 'rejected').length;
	const owningDrawables = new Set<Drawable>(unit.drawables);
	const otherUnitDrawables = new Set<Drawable>(
		input.run.units
			.filter((candidate) => candidate !== unit)
			.flatMap((candidate) => candidate.drawables)
	);
	const crossGateCount = all.filter(
		(drawable) => !owningDrawables.has(drawable) && otherUnitDrawables.has(drawable)
	).length;
	const presentationOnlyCount = all.filter(
		(drawable) => !owningDrawables.has(drawable) && !otherUnitDrawables.has(drawable)
	).length;

	const derived = drawableExtent(plan);
	const width = canvas?.widthPx ?? derived.widthPx;
	const height = canvas?.heightPx ?? derived.heightPx;
	const canvasProvenance = canvas
		? `${width} x ${height} (source: ${canvas.source})`
		: `${width} x ${height} -- DERIVED from drawable extent, NOT the image size. ` +
			`The trace does not carry image dimensions; pass RenderTraceFeaturesInput.canvas to fix this.`;

	const baseName = `feature.${safeSegment(feature.id)}.${safeSegment(unit.id)}`;
	const svgPath = resolve(outDir, `${baseName}.svg`);
	const pngProofs = bases.map((candidate, index) => ({
		base: candidate,
		path: resolve(
			outDir,
			index === 0 ? `${baseName}.png` : `${baseName}.${safeSegment(candidate.id)}.png`
		)
	}));
	const truthProofPath =
		base && (truthScore || groundingComparison)
			? resolve(outDir, `${baseName}.truth-grounding.png`)
			: undefined;
	const truthCropSheetPath =
		truthProofPath && truthScore?.objectMatches?.length
			? resolve(outDir, `${baseName}.truth-grounding-crops.png`)
			: undefined;
	const receiptPath = resolve(outDir, `${baseName}.receipt.txt`);

	let baseLine: string;
	let baseTag = '';
	if (base) {
		const dx = base.offsetXPx ?? 0;
		const dy = base.offsetYPx ?? 0;
		const href = relative(dirname(svgPath), base.pngPath).split('\\').join('/');
		baseTag = `<image href="${esc(href)}" x="${dx}" y="${dy}" width="${width - dx}" height="${height - dy}" preserveAspectRatio="none"/>`;
		baseLine =
			`base rasters (${bases.length} reusable visualizations):\n` +
			bases
				.map(
					(candidate) =>
						`  ${candidate.id}: ${candidate.pngPath} ` +
						`offset=(${candidate.offsetXPx ?? 0},${candidate.offsetYPx ?? 0}) source=${candidate.source}`
				)
				.join('\n') +
			`\n  SVG base: ${base.id}; plan requested artifact '${plan.base ?? '(none)'}'.`;
	} else {
		baseLine =
			`base raster: NOT COMPOSITED. The plan names artifact '${plan.base ?? '(none)'}', but resolving an\n` +
			`  artifact id to bytes belongs to the kind-keyed path (rendererContract.ts/artifactIo.ts).\n` +
			`  Overlay drawn on a flat background instead -- no pixels were invented.`;
	}

	const layerSvg = plan.layers
		.map(
			(layer) =>
				`  <g id="${esc(safeSegment(layer.name))}">\n` +
				`    <!-- ${esc(layer.name)}${layer.note ? ` -- ${esc(layer.note)}` : ''} (${layer.drawables.length} drawable(s)) -->\n` +
				layer.drawables.map((d) => `    ${drawableSvg(d, layer.name)}`).join('\n') +
				`\n  </g>`
		)
		.join('\n');

	const legend = plan.layers
		.map((layer, index) => {
			const verdict = layer.drawables[0]?.verdict ?? 'info';
			const s = layer.drawables[0] ? styleFor(layer.drawables[0]) : STYLE[verdict];
			const y = 28 + index * 26;
			return (
				`    <rect x="14" y="${y - 12}" width="16" height="16" fill="${s.fill}" stroke="${s.stroke}" stroke-width="2"/>` +
				`<text x="40" y="${y + 1}" font-family="monospace" font-size="15" fill="#e6e6e6">${esc(layer.name)}: ${layer.drawables.length}</text>`
			);
		})
		.join('\n');

	const svg =
		`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">\n` +
		`  <title>${esc(plan.title)}</title>\n` +
		`  <desc>${esc(plan.notes.join('\n'))}</desc>\n` +
		`  <rect x="0" y="0" width="${width}" height="${height}" fill="#101014"/>\n` +
		(baseTag ? `  ${baseTag}\n` : '') +
		`${layerSvg}\n` +
		`  <g id="legend">\n` +
		`    <rect x="6" y="6" width="520" height="${18 + plan.layers.length * 26}" fill="rgba(0,0,0,0.72)" stroke="#555"/>\n` +
		`${legend}\n` +
		`  </g>\n` +
		`</svg>\n`;

	const receiptLines = [
		'=== FEATURE RENDER RECEIPT (trace-driven) ===',
		plan.title,
		'',
		`feature id:   ${feature.id}   (ABFeature.id)`,
		`feature kind: ${feature.kind}`,
		`trace unit:   ${unit.id}   (RunTrace.units[].id)`,
		`gate:         ${unit.gate}`,
		`unit -> features, per OPERATION_UNIVERSE: [${featureIdsForUnit(unit.id).join(', ') || 'none declared'}]`,
		'',
		...plan.notes,
		'',
		...truthReceiptLines(unit, input),
		'',
		'layers drawn:',
		...plan.layers.map(
			(l) =>
				`  ${String(l.drawables.length).padStart(4)}  ${l.name}${l.note ? `  -- ${l.note}` : ''}`
		),
		'',
		'object rows (the exact objects drawn in the SVG; tee diagonals/corner orientation are presentation-only connections of detector-emitted corners):',
		...plan.layers.flatMap((layer) =>
			layer.drawables.map((drawable, index) => {
				const coordinates = drawableCoordinates(drawable, input.sourceFrameOffset);
				return (
					`  layer="${layer.name}" object=${index + 1} type=${drawable.type} verdict=${drawable.verdict} ` +
					`identity=${drawable.ref ?? 'UNKNOWN'} canonical=${coordinates.canonical} original=${coordinates.original} ` +
					`measurements=${valuesText(drawable.values)} reason="${drawable.reason ?? (drawable.verdict === 'accepted' ? 'accepted by detector' : 'UNKNOWN')}"`
				);
			})
		),
		'',
		`canvas: ${canvasProvenance}`,
		`coordinate transform: ${input.sourceFrameOffset ? `canonical = original + (${input.sourceFrameOffset.xPx},${input.sourceFrameOffset.yPx}) (source: ${input.sourceFrameOffset.source})` : 'UNKNOWN -- stitched/multi-source frame has no single inverse source mapping'}`,
		baseLine,
		'',
		...(warnings.length > 0 ? ['WARNINGS:', ...warnings.map((w) => `  ${w}`), ''] : []),
		`svg written to:     ${svgPath}`,
		...(pngProofs.length > 0
			? pngProofs.map((proof) => `png proof written [${proof.base.id}]: ${proof.path}`)
			: ['png proof written:  NOT WRITTEN -- no base raster supplied']),
		`truth grounding proof: ${truthProofPath ?? 'NOT WRITTEN -- no truth/grounding evaluation available'}`,
		...(truthProofPath
			? [
					'  colors: yellow=annotation, cyan=as-emitted endpoint, magenta=lowest-residual diagnostic Y hypothesis, red-cross=FP/FN'
				]
			: []),
		`truth grounding crop sheet: ${truthCropSheetPath ?? 'NOT WRITTEN -- no matched truth objects available'}`,
		...(truthCropSheetPath && truthScore
			? [
					`  tiles left-to-right, top-to-bottom: ${(truthScore.objectMatches ?? []).map((match) => match.truthIdentity).join(', ')}`,
					'  each tile: 72x72 canonical pixels enlarged 3x; yellow border is presentation only'
				]
			: []),
		`receipt written to: ${receiptPath}`
	];
	const receiptText = receiptLines.join('\n');

	writeFileSync(svgPath, svg);
	for (const proof of pngProofs) writeRasterProof(plan, proof.base, width, height, proof.path);
	if (truthProofPath && base)
		writeTruthProof(plan, base, truthScore, groundingComparison, width, height, truthProofPath);
	if (truthCropSheetPath && truthProofPath && truthScore)
		writeTruthCropSheet(truthProofPath, truthScore, truthCropSheetPath);
	writeFileSync(receiptPath, `${receiptText}\n`);

	return {
		featureId: feature.id,
		unitId: unit.id,
		gate: unit.gate,
		title: plan.title,
		drawableCount: all.length,
		acceptedCount,
		rejectedCount,
		filesWritten: [
			svgPath,
			...pngProofs.map((proof) => proof.path),
			...(truthProofPath ? [truthProofPath] : []),
			...(truthCropSheetPath ? [truthCropSheetPath] : []),
			receiptPath
		],
		receiptText,
		summary:
			`${feature.id}@${unit.id}: ${acceptedCount} accepted / ${rejectedCount} rejected ` +
			`(both counted on unit '${unit.id}' only)` +
			(crossGateCount > 0 ? ` + ${crossGateCount} cross-gate context drawable(s)` : '') +
			(presentationOnlyCount > 0
				? ` + ${presentationOnlyCount} presentation-only guide drawable(s)`
				: '') +
			` over ${plan.layers.length} layer(s) -> SVG + receipt`,
		warnings
	};
}

/** Prints every receipt in full, then the inventory. The acceptance gate for
 * this repo is that the CLI output alone is self-evident, so nothing is
 * summarized away here. */
export function printFeatureRenders(output: RenderTraceFeaturesOutput): void {
	for (const result of output.results) {
		console.log('');
		console.log(result.receiptText);
	}
	console.log('');
	console.log(`--- Feature-render inventory: ${output.results.length} rendered ---`);
	for (const result of output.results) console.log(`  ${result.summary}`);
	if (output.unrenderedUnits.length > 0) {
		console.log(
			`  units in the trace with no feature render (kind-keyed path still covers their artifacts): ${output.unrenderedUnits.join(', ')}`
		);
	}
	if (output.unmatchedRenders.length > 0) {
		console.log(
			`  WARNING: features declared a render for unit(s) this trace never produced: ${output.unmatchedRenders.join(', ')}`
		);
	}
	const warned = output.results.filter((r) => r.warnings.length > 0);
	if (warned.length > 0) {
		console.log('  WARNINGS (see receipts above):');
		for (const r of warned)
			for (const w of r.warnings) console.log(`    ${r.featureId}@${r.unitId}: ${w}`);
	}
}
