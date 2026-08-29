/**
 * G4 teeBadgeCompass: an opt-in, independent tee<->badge pairing candidate
 * using ONLY tee-local geometry.
 *
 * Owner directive (2026-08-28), verbatim intent: "start with JUST
 * tee->badge. That's the part that carries genuine geometric certainty."
 * This feature pairs each VISIBLE tee to a badge from the pad's own axis
 * and the tee-to-badge bearing alone -- no routing, no corridor support
 * field, no baskets, no assignment output, nothing downstream of G3 tees +
 * G1 badges. It reads exactly one board slot (`measurement`), which at the
 * point this operation runs (see the on.json execution list) already holds
 * the pre-recovery G3 visible-tee list and the G1 badge list, and nothing
 * else -- there is no way for this feature to reach `assignment`,
 * `rawPairs`, `supportField`, or basket evidence even by accident.
 *
 * File layout mirrors g4.teeBadgeLock.ts exactly (feature + Math + Receipt
 * modules, registry entry, gate-sets ownership, default-OFF deviation).
 */

import type { ABFeatureOperation } from '../../../exec/feature-set';
import type { OperationArtifact } from '../../../exec/gateway';
import type { ExecBoard } from '../../../exec/board';
import type { BadgeEvidence, TeeEvidence, ThreeFactorMeasurement } from '../types';
import type { ABFeature, EngineUnit, EvidenceBoard, FeatureContext } from './types';
import {
	buildCompassGeometry,
	buildTeeBadgeCompassEvidence,
	computeCompassPoseQuality,
	deriveCompassSigma,
	exactPositiveHole,
	resolveClaimsByWavePeeling,
	type CompassBadge,
	type CompassGeometryRow,
	type CompassLock,
	type CompassRunnerUp,
	type CompassTee,
	type CompassVerdict,
	type TeeBadgeCompassEvidence,
	type TeeBadgeCompassKnobs,
	type TeeBadgeCompassResult
} from './g4.teeBadgeCompassMath';
import { TEE_BADGE_COMPASS_RENDER } from './g4.teeBadgeCompassReceipt';

function finite(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function fractionKnob(name: string): (value: unknown) => string | null {
	return (value: unknown) =>
		typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 1
			? null
			: `${name} must be a number in (0, 1)`;
}

function positiveIntegerKnob(name: string): (value: unknown) => string | null {
	return (value: unknown) =>
		typeof value === 'number' && Number.isInteger(value) && value >= 1
			? null
			: `${name} must be a positive integer`;
}

function positiveNumberKnob(name: string): (value: unknown) => string | null {
	return (value: unknown) =>
		typeof value === 'number' && Number.isFinite(value) && value > 0
			? null
			: `${name} must be a positive number`;
}

function toleranceFactorKnob(name: string): (value: unknown) => string | null {
	return (value: unknown) =>
		typeof value === 'number' && Number.isFinite(value) && value > 1
			? null
			: `${name} must be a number > 1`;
}

/** Default-OFF G4 deviation. Every knob is a statistical/raster-geometry
 * parameter measured PER COURSE from confidently-read evidence -- never a
 * hardcoded degree constant presented as physics (footgun law). */
export const teeBadgeCompassFeature = {
	id: 'teeBadgeCompass',
	gate: 'G4',
	kind: 'deviation',
	defaultEnabled: false,
	resolveOnlyWhenConfigured: true,
	note:
		'tee-local-only compass: pairs each visible tee to a badge from the pad axis vs the tee-badge ' +
		'bearing alone (S2 -- the tee is the compass, the badge is what it points at). Reads only ' +
		"measurement.badges/measurement.tees; no routing, corridor, basket, or assignment evidence " +
		'is read. sigma is derived per-course from the tees actually on the board, floored at raster ' +
		'quantization, with a loud UNKNOWN fallback when a course gives too few tees to trust a ' +
		'quantile. Pose-quality-aware: a tee whose pad is a course-relative outlier on fill or size ' +
		"cannot silently win a confident 'locked' verdict (owner mid-build amendment).",
	render: TEE_BADGE_COMPASS_RENDER,
	knobs: {
		quantileFraction: {
			default: 0.9,
			note:
				'robust upper quantile (P90) applied to each eligible tee\'s best-badge angular error to ' +
				'derive sigma -- a statistical parameter, not a physics constant.',
			validate: fractionKnob('quantileFraction')
		},
		minimumSampleSize: {
			default: 3,
			note:
				'below this many non-degraded eligible tees, the quantile is not trusted at all -- sigma ' +
				'falls back loudly to the raster-quantization floor (isFallback: true), never silently.',
			validate: positiveIntegerKnob('minimumSampleSize')
		},
		rasterTolerancePx: {
			default: 1.25,
			note:
				'half a raster cell plus its diagonal quantization allowance, in source pixels -- the ' +
				'same value and rationale as g3.teeRecovery.ts\'s RASTER_TOLERANCE_PX. Converted to a ' +
				"degree-domain floor via THIS course's own measured tee-to-badge distances; never an " +
				'imported degree constant.',
			validate: positiveNumberKnob('rasterTolerancePx')
		},
		fillToleranceFactor: {
			default: 1.25,
			note:
				"reuses g3.teeFamily's own intactness-tolerance convention (fillRatioToleranceFactor, " +
				"also 1.25 there): a pad whose fill sits more than this factor below the course's own " +
				'median fill is flagged a weak/partial fit (owner mid-build amendment).',
			validate: toleranceFactorKnob('fillToleranceFactor')
		},
		areaToleranceFactor: {
			default: 1.25,
			note:
				"a pad whose area sits more than this factor away from the course's own median area, " +
				'in either direction (S8 uniformity), is flagged a weak/degraded fit.',
			validate: toleranceFactorKnob('areaToleranceFactor')
		}
	}
} satisfies ABFeature;

function knobsFrom(ctx: FeatureContext): TeeBadgeCompassKnobs {
	const state = ctx.resolve(teeBadgeCompassFeature).knobs as Record<string, unknown>;
	const { quantileFraction, minimumSampleSize, rasterTolerancePx, fillToleranceFactor, areaToleranceFactor } =
		state;
	if (
		!finite(quantileFraction) ||
		!finite(minimumSampleSize) ||
		!finite(rasterTolerancePx) ||
		!finite(fillToleranceFactor) ||
		!finite(areaToleranceFactor)
	) {
		throw new Error('teeBadgeCompass: resolved knobs must all be finite numbers.');
	}
	return { quantileFraction, minimumSampleSize, rasterTolerancePx, fillToleranceFactor, areaToleranceFactor };
}

function asCompassTees(tees: readonly TeeEvidence[]): readonly CompassTee[] {
	return tees.map((tee) => ({
		detId: tee.detId,
		xPx: tee.xPx,
		yPx: tee.yPx,
		...(tee.pad
			? {
					pad: {
						angleRad: tee.pad.angleRad,
						majorPx: tee.pad.majorPx,
						minorPx: tee.pad.minorPx,
						area: tee.pad.area,
						fill: tee.pad.fill
					}
				}
			: {})
	}));
}

function asCompassBadges(badges: readonly BadgeEvidence[]): readonly CompassBadge[] {
	return badges.map((badge) => ({
		detId: badge.detId,
		label: badge.label,
		cxPx: badge.cxPx,
		cyPx: badge.cyPx
	}));
}

/**
 * Build edges for wave-peeling: per tee, include its best badge plus every
 * runner-up whose angular error gap is within the resolution bound (the same
 * bound used to classify locked vs ambiguous in the existing max-weight code).
 */
function buildWavePeelingEdges(
	geometry: ReturnType<typeof buildCompassGeometry>,
	resolutionBoundDeg: number
): { teeId: string; badgeId: string; angularErrorDeg: number }[] {
	const bestByTee = new Map<string, CompassGeometryRow>();
	for (const row of geometry.rows) {
		const best = bestByTee.get(row.teeId);
		if (!best || row.angularErrorDeg < best.angularErrorDeg) {
			bestByTee.set(row.teeId, row);
		}
	}

	const edges: { teeId: string; badgeId: string; angularErrorDeg: number }[] = [];
	for (const row of geometry.rows) {
		const bestRow = bestByTee.get(row.teeId);
		if (!bestRow) continue;

		// Include best and any runner-up within resolution bound
		if (row.badgeId === bestRow.badgeId || row.angularErrorDeg - bestRow.angularErrorDeg <= resolutionBoundDeg) {
			edges.push({ teeId: row.teeId, badgeId: row.badgeId, angularErrorDeg: row.angularErrorDeg });
		}
	}
	return edges;
}

function emptyResult(badgeIds: readonly string[]): TeeBadgeCompassResult {
	return {
		geometry: { rows: [], eligibleTeeIds: [], noPadTeeIds: [], badgeIds: [...badgeIds] },
		poseQuality: [],
		sigma: {
			sigmaDeg: NaN,
			floorDeg: 'UNKNOWN',
			quantileFraction: NaN,
			quantileValueDeg: 'UNKNOWN',
			totalEligibleTees: 0,
			excludedForPoseQuality: 0,
			sampleSize: 0,
			minimumSampleSize: NaN,
			representativeDistancePx: 'UNKNOWN',
			isFallback: true,
			provenance: 'teeBadgeCompass feature is OFF; no geometry was computed.'
		},
		resolutionBoundDeg: 0,
		locks: [],
		unmatchedBadges: [],
		unusedTeeIds: [],
		noPadTeeIds: []
	};
}

function badgeLabelText(label: string | null | undefined): string {
	return typeof label === 'string' && label.length > 0 ? label : 'UNREAD';
}

function sigmaDrawableValues(sigma: TeeBadgeCompassResult['sigma']): Record<string, number> {
	const values: Record<string, number> = {
		quantileFraction: sigma.quantileFraction,
		totalEligibleTees: sigma.totalEligibleTees,
		excludedForPoseQuality: sigma.excludedForPoseQuality,
		sampleSize: sigma.sampleSize,
		minimumSampleSize: sigma.minimumSampleSize
	};
	if (typeof sigma.sigmaDeg === 'number' && Number.isFinite(sigma.sigmaDeg)) values.sigmaDeg = sigma.sigmaDeg;
	if (typeof sigma.floorDeg === 'number') values.floorDeg = sigma.floorDeg;
	if (typeof sigma.quantileValueDeg === 'number') values.quantileValueDeg = sigma.quantileValueDeg;
	if (typeof sigma.representativeDistancePx === 'number') {
		values.representativeDistancePx = sigma.representativeDistancePx;
	}
	return values;
}

function unmatchedWhyText(reason: 'no-tee-left' | 'all-candidates-ambiguous'): string {
	return reason === 'no-tee-left'
		? 'no tee left (structural: fewer confident tee candidates than badges on this course)'
		: "all candidates ambiguous (the matching's only tee candidate for this badge had a runner-up " +
			'gap under the resolution bound, so the pairing does not count as a confident claim)';
}

function lockValues(lock: CompassLock, hole: number | undefined): Record<string, number> {
	const values: Record<string, number> = {
		angularErrorDeg: lock.angularErrorDeg,
		distancePx: lock.distancePx,
		weight: lock.weight
	};
	if (hole !== undefined) values.hole = hole;
	return values;
}

function emitDrawables(
	ctx: FeatureContext,
	result: TeeBadgeCompassResult,
	tees: readonly CompassTee[],
	badges: readonly CompassBadge[]
): void {
	const teeById = new Map(tees.map((tee) => [tee.detId, tee]));
	const badgeById = new Map(badges.map((badge) => [badge.detId, badge]));
	const poseByTeeId = new Map(result.poseQuality.map((quality) => [quality.teeId, quality]));

	ctx.overlay('teeBadgeCompass', {
		type: 'point',
		xPx: 0,
		yPx: 0,
		verdict: 'info',
		ref: 'teeBadgeCompass:sigma',
		reason: result.sigma.provenance,
		values: sigmaDrawableValues(result.sigma),
		metadata: { role: 'sigma', isFallback: String(result.sigma.isFallback) }
	});

	for (const teeId of result.noPadTeeIds) {
		const tee = teeById.get(teeId);
		ctx.overlay('teeBadgeCompass', {
			type: 'point',
			xPx: tee?.xPx ?? 0,
			yPx: tee?.yPx ?? 0,
			verdict: 'rejected',
			visualRole: 'tee-rejection',
			ref: teeId,
			reason:
				'teeBadgeCompass: tee excluded -- no pad geometry (TeeEvidence.pad is undefined); cannot ' +
				'read an axis for this tee. Excluded, never silently dropped.',
			metadata: { role: 'no-pad' }
		});
	}

	for (const lock of result.locks) {
		const verdict = lock.verdict;
		if (verdict === 'abstained-contested') {
			// Contested cluster tees: emit point instead of path
			const tee = teeById.get(lock.teeId);
			const clusterBadgeIds = lock.clusterBadgeIds ?? [];
			const clusterBadgeLabels = clusterBadgeIds.map((bid) => badgeLabelText(badgeById.get(bid)?.label)).join(', ');
			ctx.overlay('teeBadgeCompass', {
				type: 'point',
				xPx: tee?.xPx ?? 0,
				yPx: tee?.yPx ?? 0,
				verdict: 'rejected',
				visualRole: 'tee-rejection',
				ref: `teeBadgeCompass:contested:${encodeURIComponent(lock.teeId)}`,
				reason: `teeBadgeCompass: tee in contested cluster (wave-peeling abstention). Cluster badges: ${clusterBadgeLabels}`,
				metadata: {
					role: 'contested-tee',
					teeId: lock.teeId,
					verdict,
					clusterIndex: String(lock.clusterIndex ?? -1),
					clusterBadgeIds: clusterBadgeIds.join(','),
					clusterBadgeLabels
				}
			});
		} else {
			// Regular locked or locked-weak-pose
			const badge = badgeById.get(lock.badgeId);
			const runnerUpBadge = lock.runnerUp ? badgeById.get(lock.runnerUp.badgeId) : undefined;
			const quality = poseByTeeId.get(lock.teeId);
			const hole = exactPositiveHole(badge?.label);
			const values = lockValues(lock, hole);
			if (lock.runnerUp) {
				values.runnerUpAngularErrorDeg = lock.runnerUp.angularErrorDeg;
				values.gapDeg = lock.runnerUp.gapDeg;
				const runnerUpHole = exactPositiveHole(runnerUpBadge?.label);
				if (runnerUpHole !== undefined) values.runnerUpHole = runnerUpHole;
			}
			if (quality) {
				values.supportPx = quality.supportPx;
				values.fill = quality.fill;
				values.majorPx = quality.majorPx;
				values.minorPx = quality.minorPx;
				values.courseMedianSupportPx = quality.courseMedianSupportPx;
				values.courseMedianFill = quality.courseMedianFill;
			}

			// Add wave information
			const waveNumber = lock.waveNumber ?? 0;
			const forcedBy = lock.forcedBy ?? [];
			const waveNote = waveNumber > 0 ? `wave ${waveNumber}; ` : '';
			const forcedNote =
				waveNumber > 1 && forcedBy.length > 0 ? `forced after locks: ${forcedBy.join(',')}; ` : '';

			const holeNote = hole !== undefined ? `hole=H${hole}; ` : '';
			const runnerUpNote = lock.runnerUp
				? `runner-up=${badgeLabelText(runnerUpBadge?.label)} gap=${lock.runnerUp.gapDeg.toFixed(3)}deg; `
				: 'runner-up=none (only one candidate badge on this course); ';
			const poseNote = quality?.degraded ? `POSE DEGRADED (${quality.degradedReason}); ` : '';
			ctx.overlay('teeBadgeCompass', {
				type: 'polyline',
				path: [
					[lock.teeXPx, lock.teeYPx],
					lock.axisEndpointPx
				],
				verdict: 'accepted',
				visualRole: 'tee-badge-path',
				ref: `teeBadgeCompass:${encodeURIComponent(lock.teeId)}:${encodeURIComponent(lock.badgeId)}`,
				reason:
					`${waveNote}${forcedNote}${holeNote}verdict=${verdict}; angularErrorDeg=${lock.angularErrorDeg.toFixed(3)}; ` +
					`distancePx=${lock.distancePx.toFixed(1)}; ${runnerUpNote}${poseNote}` +
					'tee-local geometry only (no routing, no baskets, no assignment)',
				values,
				metadata: {
					role: 'tee-lock',
					teeId: lock.teeId,
					badgeId: lock.badgeId,
					badgeLabel: badgeLabelText(badge?.label),
					runnerUpBadgeLabel: lock.runnerUp ? badgeLabelText(runnerUpBadge?.label) : 'none',
					verdict,
					poseDegraded: String(quality?.degraded ?? false),
					poseDegradedReason: quality?.degradedReason ?? 'n/a',
					waveNumber: String(waveNumber),
					forcedBy: forcedBy.join(',')
				}
			});
		}
	}

	for (const entry of result.unmatchedBadges) {
		const badge = badgeById.get(entry.badgeId);
		const hole = exactPositiveHole(badge?.label);
		const why = unmatchedWhyText(entry.reason);
		ctx.overlay('teeBadgeCompass', {
			type: 'point',
			xPx: badge?.cxPx ?? 0,
			yPx: badge?.cyPx ?? 0,
			verdict: 'info',
			ref: `teeBadgeCompass:unmatched:${encodeURIComponent(entry.badgeId)}`,
			reason: `UNMATCHED: ${why}`,
			values: hole !== undefined ? { hole } : {},
			metadata: { role: 'unmatched-badge', badgeId: entry.badgeId, badgeLabel: badgeLabelText(badge?.label), why }
		});
	}
}

function executeTeeBadgeCompass(
	board: ExecBoard,
	ctx: FeatureContext,
	measurement: ThreeFactorMeasurement
): void {
	const stop = ctx.span('teeBadgeCompass');
	const state = ctx.resolve(teeBadgeCompassFeature);
	const compassTees = asCompassTees(measurement.tees);
	const compassBadges = asCompassBadges(measurement.badges);

	const result = state.enabled
		? (() => {
				const knobs = knobsFrom(ctx);
				const geometry = buildCompassGeometry(compassTees, compassBadges);
				const poseQuality = computeCompassPoseQuality(compassTees, knobs);
				const degradedTeeIds = new Set(
					poseQuality.filter((quality) => quality.degraded).map((quality) => quality.teeId)
				);
				const sigma = deriveCompassSigma(geometry, knobs, degradedTeeIds);
				const resolutionBoundDeg = typeof sigma.floorDeg === 'number' ? sigma.floorDeg : 0;

				if (geometry.eligibleTeeIds.length === 0 || geometry.badgeIds.length === 0) {
					return {
						geometry,
						poseQuality,
						sigma,
						resolutionBoundDeg,
						locks: [],
						unmatchedBadges: geometry.badgeIds.map((badgeId) => ({
							badgeId,
							reason: 'no-tee-left' as const
						})),
						unusedTeeIds: [...geometry.eligibleTeeIds],
						noPadTeeIds: geometry.noPadTeeIds
					};
				}

				const edges = buildWavePeelingEdges(geometry, resolutionBoundDeg);
				const wavePeelResult = resolveClaimsByWavePeeling(edges);

				// Create row lookup
				const rowByPair = new Map<string, CompassGeometryRow>();
				for (const row of geometry.rows) {
					rowByPair.set(`${row.teeId} ${row.badgeId}`, row);
				}

				// Map WavePeelLock to CompassLock with full geometry
				const locks: CompassLock[] = wavePeelResult.locks
					.map((lock) => {
						const row = rowByPair.get(`${lock.teeId} ${lock.badgeId}`);
						if (!row) throw new Error(`teeBadgeCompass: missing geometry row for ${lock.teeId}/${lock.badgeId}`);

						// Build runnerUp from the tee's remaining edges (second-best by angular error)
						const teeBadges = edges
							.filter((e) => e.teeId === lock.teeId && e.badgeId !== lock.badgeId)
							.sort((a, b) => a.angularErrorDeg - b.angularErrorDeg);

						const runnerUpEdge = teeBadges[0];
						const runnerUpRow = runnerUpEdge ? rowByPair.get(`${lock.teeId} ${runnerUpEdge.badgeId}`) : null;
						const runnerUp: CompassRunnerUp | null = runnerUpRow
							? {
									badgeId: runnerUpRow.badgeId,
									angularErrorDeg: runnerUpRow.angularErrorDeg,
									distancePx: runnerUpRow.distancePx,
									weight: Math.exp(-((runnerUpRow.angularErrorDeg / sigma.sigmaDeg) ** 2)),
									gapDeg: runnerUpRow.angularErrorDeg - row.angularErrorDeg
								}
							: null;

						const verdict: CompassVerdict = degradedTeeIds.has(lock.teeId)
							? 'locked-weak-pose'
							: 'locked';

						const compassLock: CompassLock = {
							...row,
							weight: Math.exp(-((row.angularErrorDeg / sigma.sigmaDeg) ** 2)),
							runnerUp,
							verdict,
							axisEndpointPx: [
								row.teeXPx + row.distancePx * Math.cos(row.aimRad),
								row.teeYPx + row.distancePx * Math.sin(row.aimRad)
							] as const,
							waveNumber: lock.wave,
							forcedBy: lock.forcedBy
						};
						return compassLock;
					})
					.concat(
						// Add abstained-contested locks for cluster tees
						wavePeelResult.contestedClusters.flatMap((cluster, clusterIdx) =>
							cluster.teeIds.map((teeId) => {
								// Find a geometry row for this tee from the cluster
								const row = geometry.rows.find(
									(r) => r.teeId === teeId && cluster.badgeIds.includes(r.badgeId)
								);
								if (!row) throw new Error(`teeBadgeCompass: no geometry for contested tee ${teeId}`);

								const contestedLock: CompassLock = {
									...row,
									weight: 0,
									runnerUp: null,
									verdict: 'abstained-contested',
									axisEndpointPx: [row.teeXPx, row.teeYPx] as const,
									clusterBadgeIds: cluster.badgeIds,
									clusterIndex: clusterIdx
								};
								return contestedLock;
							})
						)
					);

				// Unmatched badges: badges not in locks, plus cluster badges
				const lockedBadgeIds = new Set(
					locks.filter((lock) => lock.verdict !== 'abstained-contested').map((lock) => lock.badgeId)
				);
				const clusterBadgeIds = new Set(
					wavePeelResult.contestedClusters.flatMap((cluster) => cluster.badgeIds)
				);
				const unmatchedBadges = geometry.badgeIds
					.filter((badgeId) => !lockedBadgeIds.has(badgeId) && !clusterBadgeIds.has(badgeId))
					.map((badgeId) => ({
						badgeId,
						reason: 'no-tee-left' as const
					}));

				// Unused tees: eligible tees not in locks or clusters
				const usedTeeIds = new Set(locks.map((lock) => lock.teeId));
				const unusedTeeIds = geometry.eligibleTeeIds.filter((id) => !usedTeeIds.has(id));

				return {
					geometry,
					poseQuality,
					sigma,
					resolutionBoundDeg,
					locks,
					unmatchedBadges,
					unusedTeeIds,
					noPadTeeIds: geometry.noPadTeeIds
				};
			})()
		: emptyResult(compassBadges.map((badge) => badge.detId));
	if (state.enabled) emitDrawables(ctx, result, compassTees, compassBadges);

	const evidence: TeeBadgeCompassEvidence = buildTeeBadgeCompassEvidence(result, compassBadges);
	ctx.measure('teeBadgeCompass', 'eligibleTees', evidence.geometry.eligibleTeeIds.length);
	ctx.measure('teeBadgeCompass', 'noPadTees', evidence.noPadTeeIds.length);
	ctx.measure(
		'teeBadgeCompass',
		'locked',
		evidence.locks.filter((lock) => lock.verdict === 'locked').length
	);
	ctx.measure(
		'teeBadgeCompass',
		'lockedWeakPose',
		evidence.locks.filter((lock) => lock.verdict === 'locked-weak-pose').length
	);
	ctx.measure(
		'teeBadgeCompass',
		'abstainedContested',
		evidence.locks.filter((lock) => lock.verdict === 'abstained-contested').length
	);
	ctx.measure('teeBadgeCompass', 'unmatchedBadges', evidence.unmatchedBadges.length);
	ctx.measure('teeBadgeCompass', 'unusedTees', evidence.unusedTeeIds.length);
	board.set('teeBadgeCompass', evidence);
	stop();
}

function measurementTable(board: ExecBoard): readonly OperationArtifact[] {
	const evidence = board.get<TeeBadgeCompassEvidence>('teeBadgeCompass');
	return [
		{
			kind: 'measurementTable',
			id: 'teeBadgeCompass.evidence',
			bytes: new TextEncoder().encode(JSON.stringify(evidence))
		}
	];
}

/** Legacy engine descriptor used by the chronology seam / schema generation.
 * Production ABFeature sets use teeBadgeCompassOperation below. */
export const teeBadgeCompassUnit: EngineUnit = {
	id: 'teeBadgeCompass',
	gate: 'G4',
	consumes: ['measurement'],
	produces: ['teeBadgeCompass'],
	note:
		'tee-local-only tee<->badge compass candidate; production custody is owned by ' +
		'teeBadgeCompassOperation',
	run(board: EvidenceBoard, ctx: FeatureContext) {
		const measurement = board.get<ThreeFactorMeasurement>('measurement');
		executeTeeBadgeCompass(board as unknown as ExecBoard, ctx, measurement);
	}
};

/** Semantic-set operation. Reads only `measurement`, including while OFF, so
 * the gateway receipt can prove OFF custody rather than hiding a missing
 * dependency. Writes only `teeBadgeCompass`. */
export const teeBadgeCompassOperation: ABFeatureOperation = {
	spec: {
		id: 'teeBadgeCompass',
		kind: 'decide',
		gate: 'G4',
		unit: 'teeBadgeCompass',
		consumes: ['measurement'],
		produces: ['teeBadgeCompass'],
		features: ['teeBadgeCompass'],
		note:
			'tee-local-only compass: pad axis vs tee-badge bearing, one-to-one max-weight matching over ' +
			'tees x badges; no routing, basket, or assignment evidence is read'
	},
	run(board, ctx) {
		const measurement = board.get<ThreeFactorMeasurement>('measurement');
		executeTeeBadgeCompass(board, ctx, measurement);
	},
	extractArtifacts: measurementTable
};
