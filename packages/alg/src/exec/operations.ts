// R2: the real operation universe. A unit stays an ownership/grouping
// label (`OperationSpec.unit`); the operations below are the scheduling
// and debug nodes a step-by-step scrubber walks. Three units get genuine
// substep decomposition (badgeStage, tees, assignment — the ones the
// owner's brief named explicitly); the other nine keep their existing
// EngineUnit body as a single operation — a deliberate cut, defended in
// the Wave 1A report, not "11 units relabeled as 11 operations."
//
// Every decomposed op calls the SAME exported pure functions the
// monolithic unit already called (recoverDarkPlateBadges/
// excludeAndAssembleTees were extracted, not duplicated — see
// badgeStage.ts and measure.ts; rerouteRawPairs/scoreRawPairs/
// rankPairsByBadge/recoveredTee were merely un-privated in assignment.ts).
// Same functions, same order, same arguments — the decomposition changes
// scheduling granularity, not arithmetic, which is what keeps this
// byte-identical to the pre-Wave-1A engine.

import type { OperationKind, OperationSpec, ArtifactKind } from './contract';
import type { ExecBoard } from './board';
import type { OperationImpl } from './gateway';
import type {
	EngineUnit,
	EvidenceBoard,
	FeatureContext
} from '../detectors/threeFactor/features/types';
import { measureUnits } from '../detectors/threeFactor/measure';
import { phantomTeeUnit, phantomTeeFeature } from '../detectors/threeFactor/features/g3.phantomTee';
import { teeFamilyUnit, teeFamilyFeature } from '../detectors/threeFactor/features/g3.teeFamily';
import { teeRecoveryUnit, teeRecoveryFeature } from '../detectors/threeFactor/features/g3.teeRecovery';
import {
	cleanBasketFamilyUnit,
	cleanBasketFamilyFeature
} from '../detectors/threeFactor/features/g2.cleanBasketFamily';
import { g1BadgesFeature } from '../detectors/threeFactor/features/g1.badges';
import { g1DigitsFeature } from '../detectors/threeFactor/features/g1.digits';
import { sharedHsvFeature } from '../detectors/threeFactor/features/shared.hsv';
import { g2SpriteFeature } from '../detectors/threeFactor/features/g2.sprite';
import { g3EndpointsFeature } from '../detectors/threeFactor/features/g3.endpoints';
import { g4ScoringFeature } from '../detectors/threeFactor/features/g4.scoring';
import { g4SearchFeature } from '../detectors/threeFactor/features/g4.search';
import { g5RibbonFeature } from '../detectors/threeFactor/features/g5.ribbon';
import { g5RoutingFeature } from '../detectors/threeFactor/features/g5.routing';
import { zfitFeature } from '../detectors/threeFactor/features/g5.zfit';
import { computeBrightDarkMasks, type HsvKnobs, type Mask } from '../detectors/threeFactor/raster';
import { extractComponents, type ComponentStats } from '../detectors/threeFactor/components';
import {
	detectBadgeFamily,
	recoverDarkPlateBadges,
	type BadgeStageKnobs,
	type BadgeStageResult
} from '../detectors/threeFactor/badgeStage';
import { excludeAndAssembleTees } from '../detectors/threeFactor/measure';
import {
	detectTeeRings,
	type EndpointsKnobs,
	type SpriteMatch,
	type TeeRing
} from '../detectors/threeFactor/endpoints';
import {
	recoveredTee,
	rerouteRawPairs,
	scoreRawPairs,
	rankPairsByBadge,
	selectAssignments,
	DEFAULT_SEARCH_KNOBS,
	type SearchKnobs
} from '../detectors/threeFactor/assignment';
import type { RibbonKnobs } from '../detectors/threeFactor/ribbon';
import type { RoutingKnobs } from '../detectors/threeFactor/routing';
import type { ScoringKnobs, ZfitKnobs } from '../detectors/threeFactor/scoring';
import type {
	AssignmentEvidence,
	RawPairEvidence,
	RecoveredTeeInput,
	RgbaImage,
	ScoredPairEvidence,
	TeeEvidence,
	ThreeFactorAssignment,
	ThreeFactorMeasurement
} from '../detectors/threeFactor/types';

/** Cast: ExecBoard (string-keyed) is structurally a superset of the closed-EvidenceSlot EvidenceBoard the legacy unit.run bodies expect. */
function asLegacyBoard(board: ExecBoard): EvidenceBoard {
	return board as unknown as EvidenceBoard;
}

const measureUnitById = new Map(measureUnits.map((unit) => [unit.id, unit]));
function legacyUnit(id: string): EngineUnit {
	const unit = measureUnitById.get(id);
	if (!unit) throw new Error(`exec/operations: no legacy unit '${id}'`);
	return unit;
}

interface OperationDef {
	readonly spec: OperationSpec;
	readonly run: OperationImpl;
}

function wrapLegacy(
	id: string,
	kind: OperationKind,
	gate: string,
	features?: readonly string[],
	note?: string
): OperationDef {
	const unit = legacyUnit(id);
	return {
		spec: {
			id,
			kind,
			gate,
			unit: id,
			consumes: unit.consumes,
			produces: unit.produces,
			...(features ? { features } : {}),
			...(note ? { note } : {})
		},
		run: (board, ctx) => unit.run(asLegacyBoard(board), ctx)
	};
}

// ---------------------------------------------------------------------------
// badgeStage — decomposed per R2's own example: brightMask measure,
// components transform, family compute, badge decide.

interface BadgeStageMasks {
	readonly bright: Mask;
	readonly dark: Mask;
}
interface BadgeStageComponents {
	readonly brightLabels: Int32Array;
	readonly brightComponents: ComponentStats[];
}

const badgeStageOps: OperationDef[] = [
	{
		spec: {
			id: 'badgeStage.masks',
			kind: 'measure',
			gate: 'G1',
			unit: 'badgeStage',
			consumes: ['localImage'],
			produces: ['badgeStage.masks'],
			features: [sharedHsvFeature.id],
			note: 'HSV bright/dark thresholding over the viewport-cropped local image'
		},
		run(board, ctx) {
			const stop = ctx.span('badgeStage');
			const hsvKnobs = ctx.resolve(sharedHsvFeature).knobs as unknown as HsvKnobs;
			const image = board.get<RgbaImage>('localImage');
			board.set(
				'badgeStage.masks',
				computeBrightDarkMasks(
					image as unknown as {
						width: number;
						height: number;
						data: Uint8Array | Uint8ClampedArray;
					},
					hsvKnobs
				)
			);
			stop();
		}
	},
	{
		spec: {
			id: 'badgeStage.components',
			kind: 'transform',
			gate: 'G1',
			unit: 'badgeStage',
			consumes: ['badgeStage.masks'],
			produces: ['badgeStage.components'],
			note: '8-connected component labeling of the bright mask'
		},
		run(board, ctx) {
			const stop = ctx.span('badgeStage');
			const { bright } = board.get<BadgeStageMasks>('badgeStage.masks');
			const { labels, components } = extractComponents(bright);
			board.set('badgeStage.components', {
				brightLabels: labels,
				brightComponents: components
			} satisfies BadgeStageComponents);
			stop();
		}
	},
	{
		spec: {
			id: 'badgeStage.family',
			kind: 'compute',
			gate: 'G1',
			unit: 'badgeStage',
			consumes: ['badgeStage.masks', 'badgeStage.components', 'localImage'],
			produces: ['badgeStage.family'],
			features: [g1BadgesFeature.id],
			note: 'anchored bright-family badge candidates (aspect + dark-interior gates)'
		},
		run(board, ctx) {
			const stop = ctx.span('badgeStage');
			const knobs = ctx.resolve(g1BadgesFeature).knobs as unknown as BadgeStageKnobs;
			const { dark } = board.get<BadgeStageMasks>('badgeStage.masks');
			const { brightComponents } = board.get<BadgeStageComponents>('badgeStage.components');
			const image = board.get<RgbaImage>('localImage');
			board.set('badgeStage.family', detectBadgeFamily(image.width, dark, brightComponents, knobs));
			stop();
		}
	},
	{
		spec: {
			id: 'badgeStage.badges',
			kind: 'decide',
			gate: 'G1',
			unit: 'badgeStage',
			consumes: ['badgeStage.masks', 'badgeStage.components', 'badgeStage.family', 'localImage'],
			produces: ['stage'],
			features: [g1BadgesFeature.id],
			note: 'dark-plate glyph recovery accept/reject, then materialize the BadgeStageResult'
		},
		run(board, ctx) {
			const stop = ctx.span('badgeStage');
			const knobs = ctx.resolve(g1BadgesFeature).knobs as unknown as BadgeStageKnobs;
			const image = board.get<RgbaImage>('localImage');
			const { bright, dark } = board.get<BadgeStageMasks>('badgeStage.masks');
			const { brightLabels, brightComponents } =
				board.get<BadgeStageComponents>('badgeStage.components');
			const family = board.get<ComponentStats[]>('badgeStage.family');
			const badges = [...family];
			const badgeSources: ('bright-family' | 'dark-plate-recovery')[] = badges.map(
				() => 'bright-family'
			);
			const plateBboxes: (readonly [number, number, number, number] | null)[] = badges.map(
				() => null
			);
			recoverDarkPlateBadges(image.width, bright, dark, badges, badgeSources, plateBboxes, knobs);
			const stage: BadgeStageResult = {
				width: image.width,
				height: image.height,
				brightMask: bright,
				darkMask: dark,
				brightLabels,
				brightComponents,
				badges,
				badgeSources,
				plateBboxes,
				badgeCount: badges.length
			};
			board.set('stage', stage);
			stop();
		}
	}
];

// ---------------------------------------------------------------------------
// Visible tees only: hollow-ring measurement followed by exclusion/family
// decision. Component/shard recovery is deliberately a separate phase.

const teesOps: OperationDef[] = [
	{
		spec: {
			id: 'tees.ringMeasure',
			kind: 'measure',
			gate: 'G3',
			unit: 'tees',
			consumes: ['stage'],
			produces: ['tees.rawRings'],
			features: [g3EndpointsFeature.id],
			note: 'enclosed-hole hollow-glyph ring detection over the bright mask, unfiltered'
		},
		run(board, ctx) {
			const stop = ctx.span('tees');
			const stage = board.get<BadgeStageResult>('stage');
			const endpointsKnobs = ctx.resolve(g3EndpointsFeature).knobs as unknown as EndpointsKnobs;
			board.set('tees.rawRings', detectTeeRings(stage.brightMask, endpointsKnobs));
			stop();
		}
	},
	{
		spec: {
			id: 'tees.exclusion',
			kind: 'decide',
			gate: 'G3',
			unit: 'tees',
			consumes: ['tees.rawRings', 'stage', 'sprites', 'viewport'],
			produces: ['tees'],
			features: [g4ScoringFeature.id, g3EndpointsFeature.id, g1BadgesFeature.id],
			note: 'visible hollow-ring candidates only: badge-bbox + screen-chrome exclusion, then sort/assign detIds; shard recovery is separate'
		},
		run(board, ctx) {
			const stop = ctx.span('tees');
			const stage = board.get<BadgeStageResult>('stage');
			const sprites = board.get<readonly SpriteMatch[]>('sprites');
			const { topPx } = board.get<{ topPx: number }>('viewport');
			const rawRings = board.get<readonly TeeRing[]>('tees.rawRings');
			const scoringKnobs = ctx.resolve(g4ScoringFeature).knobs as unknown as ScoringKnobs;
			const endpointsKnobs = ctx.resolve(g3EndpointsFeature).knobs as unknown as EndpointsKnobs;
			const badgeStageKnobs = ctx.resolve(g1BadgesFeature).knobs as unknown as BadgeStageKnobs;
			const tees = excludeAndAssembleTees(
				stage,
				rawRings,
				[],
				sprites,
				topPx,
				ctx,
				scoringKnobs,
				endpointsKnobs,
				badgeStageKnobs
			);
			for (const tee of tees) {
				ctx.overlay('tees', {
					type: 'box',
					bbox: tee.bbox,
					verdict: 'accepted',
					ref: tee.detId,
					values: { fill: tee.fill, area: tee.area }
				});
			}
			board.set('tees', tees);
			stop();
		}
	}
];

// ---------------------------------------------------------------------------
// assignment — decomposed per R2's own example: scoring compute, selection
// decide (plus the pairing/reroute transform and ranking compute the owner
// text elided with "...").

function pairKey(pair: ScoredPairEvidence): string {
	return `${pair.raw.teeId}:${pair.raw.basketId}`;
}

const assignmentOps: OperationDef[] = [
	{
		spec: {
			id: 'assignment.pairs',
			kind: 'transform',
			gate: 'G6',
			unit: 'assignment',
			consumes: ['measurement', 'recoveredTees'],
			produces: ['assignment.tees', 'assignment.rawPairs'],
			features: [g4ScoringFeature.id, g4SearchFeature.id, g5RibbonFeature.id, g5RoutingFeature.id],
			note: 'merge deduped recovered tees, reroute raw pairs when any were accepted'
		},
		run(board, ctx) {
			const stop = ctx.span('assignment');
			const measurement = board.get<ThreeFactorMeasurement>('measurement');
			const recoveredTees = board.get<readonly RecoveredTeeInput[]>('recoveredTees');
			const scoringKnobs = ctx.resolve(g4ScoringFeature).knobs as unknown as ScoringKnobs;
			const searchKnobs = ctx.resolve(g4SearchFeature).knobs as unknown as SearchKnobs;
			const ribbonKnobs = ctx.resolve(g5RibbonFeature).knobs as unknown as RibbonKnobs;
			const routingKnobs = ctx.resolve(g5RoutingFeature).knobs as unknown as RoutingKnobs;
			const sortedRecovered = [...recoveredTees].sort(
				(a, b) =>
					a.yPx - b.yPx || a.xPx - b.xPx || a.provenance.note.localeCompare(b.provenance.note)
			);
			const tees: TeeEvidence[] = [...measurement.tees];
			let acceptedRecovered = 0;
			for (const input of sortedRecovered) {
				if (
					tees.some(
						(tee) =>
							Math.hypot(tee.xPx - input.xPx, tee.yPx - input.yPx) <
							searchKnobs.recoveredTeeDedupeDistance
					)
				)
					continue;
				tees.push(recoveredTee(input, acceptedRecovered++, measurement.baskets, scoringKnobs));
			}
			tees.sort((a, b) => a.yPx - b.yPx || a.xPx - b.xPx || a.detId.localeCompare(b.detId));
			const rawPairs =
				acceptedRecovered > 0
					? rerouteRawPairs(measurement, tees, ribbonKnobs, routingKnobs, scoringKnobs)
					: measurement.rawPairs;
			board.set('assignment.tees', tees);
			board.set('assignment.rawPairs', rawPairs);
			stop();
		}
	},
	{
		spec: {
			id: 'assignment.scoring',
			kind: 'compute',
			gate: 'G6',
			unit: 'assignment',
			consumes: ['measurement', 'assignment.tees', 'assignment.rawPairs'],
			produces: ['assignment.scoredPairs'],
			features: [g4ScoringFeature.id],
			note: 'score every pair on the straight-route evidence; bent-path salvage belongs to G7'
		},
		run(board, ctx) {
			const stop = ctx.span('assignment');
			const measurement = board.get<ThreeFactorMeasurement>('measurement');
			const tees = board.get<TeeEvidence[]>('assignment.tees');
			const rawPairs = board.get<readonly RawPairEvidence[]>('assignment.rawPairs');
			const scoringKnobs = ctx.resolve(g4ScoringFeature).knobs as unknown as ScoringKnobs;
			const straightMeasurement = measurement.parameters.zfit
				? { ...measurement, parameters: { ...measurement.parameters, zfit: false } }
				: measurement;
			board.set(
				'assignment.scoredPairs',
				scoreRawPairs(straightMeasurement, tees, rawPairs, undefined, scoringKnobs)
			);
			stop();
		}
	},
	{
		spec: {
			id: 'assignment.ranking',
			kind: 'compute',
			gate: 'G6',
			unit: 'assignment',
			consumes: ['assignment.scoredPairs'],
			produces: ['assignment.rankedByBadge'],
			note: 'rank scored pairs within each badge'
		},
		run(board, ctx) {
			const stop = ctx.span('assignment');
			const scored = board.get<ScoredPairEvidence[]>('assignment.scoredPairs');
			board.set('assignment.rankedByBadge', rankPairsByBadge(scored));
			stop();
		}
	},
	{
		spec: {
			id: 'assignment.selection',
			kind: 'decide',
			gate: 'G6',
			unit: 'assignment',
			consumes: ['assignment.rankedByBadge', 'measurement', 'assignment.tees'],
			produces: ['assignment'],
			features: [g4SearchFeature.id],
			note: 'global one-to-one ownership search, then materialize the ThreeFactorAssignment'
		},
		run(board, ctx) {
			const stop = ctx.span('assignment');
			const measurement = board.get<ThreeFactorMeasurement>('measurement');
			const tees = board.get<readonly TeeEvidence[]>('assignment.tees');
			const byBadge = board.get<Map<string, ScoredPairEvidence[]>>('assignment.rankedByBadge');
			const searchKnobs =
				(ctx.resolve(g4SearchFeature).knobs as unknown as SearchKnobs) ?? DEFAULT_SEARCH_KNOBS;
			const scoredPairs = [...byBadge.values()].flat();
			const selected = selectAssignments(byBadge, searchKnobs);
			const assignments: AssignmentEvidence[] = [...selected.entries()]
				.filter((entry): entry is [string, ScoredPairEvidence] => entry[1] !== null)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([badgeId, pair]) => ({
					badgeId,
					teeId: pair.raw.teeId,
					basketId: pair.raw.basketId,
					score: pair.score,
					rank: pair.rank,
					ownership: 'selected' as const,
					alternatives: (byBadge.get(badgeId) ?? [])
						.filter((candidate) => pairKey(candidate) !== pairKey(pair))
						.slice(0, 3)
						.map((candidate) => ({
							teeId: candidate.raw.teeId,
							basketId: candidate.raw.basketId,
							score: candidate.score
						}))
				}));
			const result: ThreeFactorAssignment = { measurement, tees, scoredPairs, assignments };
			for (const own of result.assignments) ctx.measure('assignment', 'score', own.score);
			board.set('assignment', result);
			stop();
		}
	}
];

const zfitOps: OperationDef[] = [
	{
		spec: {
			id: 'zfit',
			kind: 'compute',
			gate: 'G7',
			unit: 'zfit',
			consumes: ['measurement', 'assignment.tees', 'assignment.rawPairs', 'assignment'],
			produces: ['assignment'],
			features: [zfitFeature.id, g4ScoringFeature.id, g4SearchFeature.id],
			note: 'when enabled, rescore the top-K weak straight routes with bent-path Z-fit and reselect ownership'
		},
		run(board, ctx) {
			const stop = ctx.span('zfit');
			const state = ctx.resolve(zfitFeature);
			const measurement = board.get<ThreeFactorMeasurement>('measurement');
			const tees = board.get<readonly TeeEvidence[]>('assignment.tees');
			const rawPairs = board.get<readonly RawPairEvidence[]>('assignment.rawPairs');
			const prior = board.get<ThreeFactorAssignment>('assignment');
			if (!state.enabled) {
				board.set('assignment', prior);
				stop();
				return;
			}
			const zfitKnobs = state.knobs as unknown as ZfitKnobs;
			const scoringKnobs = ctx.resolve(g4ScoringFeature).knobs as unknown as ScoringKnobs;
			const searchKnobs =
				(ctx.resolve(g4SearchFeature).knobs as unknown as SearchKnobs) ?? DEFAULT_SEARCH_KNOBS;
			const scored = scoreRawPairs(measurement, tees, rawPairs, zfitKnobs, scoringKnobs);
			const byBadge = rankPairsByBadge(scored);
			const selected = selectAssignments(byBadge, searchKnobs);
			const assignments: AssignmentEvidence[] = [...selected.entries()]
				.filter((entry): entry is [string, ScoredPairEvidence] => entry[1] !== null)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([badgeId, pair]) => ({
					badgeId,
					teeId: pair.raw.teeId,
					basketId: pair.raw.basketId,
					score: pair.score,
					rank: pair.rank,
					ownership: 'selected' as const,
					alternatives: (byBadge.get(badgeId) ?? [])
						.filter((candidate) => pairKey(candidate) !== pairKey(pair))
						.slice(0, 3)
						.map((candidate) => ({
							teeId: candidate.raw.teeId,
							basketId: candidate.raw.basketId,
							score: candidate.score
						}))
				}));
			for (const own of assignments) ctx.measure('zfit', 'score', own.score);
			board.set('assignment', {
				measurement,
				tees,
				scoredPairs: [...byBadge.values()].flat(),
				assignments
			});
			stop();
		}
	}
];

// ---------------------------------------------------------------------------
// The nine units that keep a single operation — real DAG nodes, just not
// decomposed further (R2: "your judgment on the exact cut").

const reusedOps: OperationDef[] = [
	wrapLegacy('badges', 'compute', 'G1', [g1DigitsFeature.id]),
	wrapLegacy('supportField', 'measure', 'G5', [g5RibbonFeature.id]),
	wrapLegacy('badgeOcclusionPatch', 'transform', 'G5', [g5RibbonFeature.id]),
	wrapLegacy('baskets', 'compute', 'G2', [g2SpriteFeature.id]),
	wrapLegacy('rawPairs', 'compute', 'G5', [
		g5RibbonFeature.id,
		g5RoutingFeature.id,
		g4ScoringFeature.id
	]),
	wrapLegacy('measurement', 'materialize', 'G5'),
	{
		spec: {
			id: 'phantomTee',
			kind: 'decide',
			gate: 'G4',
			unit: 'phantomTee',
			consumes: phantomTeeUnit.consumes,
			produces: phantomTeeUnit.produces,
			features: [
				phantomTeeFeature.id,
				zfitFeature.id,
				g4ScoringFeature.id,
				g4SearchFeature.id,
				g5RibbonFeature.id,
				g5RoutingFeature.id
			],
			note: phantomTeeUnit.note
		},
		run: (board, ctx) => phantomTeeUnit.run(asLegacyBoard(board), ctx)
	},
	{
		spec: {
			id: 'teeFamily',
			kind: 'decide',
			gate: 'G3',
			unit: 'teeFamily',
			consumes: teeFamilyUnit.consumes,
			produces: teeFamilyUnit.produces,
			features: [teeFamilyFeature.id],
			note: teeFamilyUnit.note
		},
		run: (board, ctx) => teeFamilyUnit.run(asLegacyBoard(board), ctx)
	},
	{
		spec: {
			id: 'teeRecovery',
			kind: 'decide',
			gate: 'G4',
			unit: 'teeRecovery',
			consumes: teeRecoveryUnit.consumes,
			produces: teeRecoveryUnit.produces,
			features: [teeRecoveryFeature.id],
			note: teeRecoveryUnit.note
		},
		run: (board, ctx) => teeRecoveryUnit.run(asLegacyBoard(board), ctx)
	},
	{
		spec: {
			id: 'cleanBasketFamily',
			kind: 'decide',
			gate: 'G2',
			unit: 'cleanBasketFamily',
			consumes: cleanBasketFamilyUnit.consumes,
			produces: cleanBasketFamilyUnit.produces,
			features: [cleanBasketFamilyFeature.id],
			note: cleanBasketFamilyUnit.note
		},
		run: (board, ctx) => cleanBasketFamilyUnit.run(asLegacyBoard(board), ctx)
	}
];

const allOpDefs: readonly OperationDef[] = [
	...badgeStageOps,
	...teesOps,
	...assignmentOps,
	...zfitOps,
	...reusedOps
];
const opDefById = new Map(allOpDefs.map((def) => [def.spec.id, def]));

/**
 * Unit id -> its fixed-order operation id list. Config `execution` arrays
 * are still authored at unit granularity (R3: no schema bump); compile.ts
 * expands each unit id through this table to build the op-level plan.
 * Intra-unit order is NOT configurable — it is the unit's own internal
 * dependency chain, fixed at registration time. Map insertion order below
 * is also the canonical (default.json) unit order, used only to make
 * OPERATION_UNIVERSE's iteration order readable — compile.ts's actual
 * scheduling always follows the RESOLVED config's execution list, never
 * this map's key order.
 */
export const UNIT_OPERATIONS: ReadonlyMap<string, readonly string[]> = new Map([
	['badgeStage', badgeStageOps.map((op) => op.spec.id)],
	['badges', ['badges']],
	['supportField', ['supportField']],
	['badgeOcclusionPatch', ['badgeOcclusionPatch']],
	['baskets', ['baskets']],
	['tees', teesOps.map((op) => op.spec.id)],
	['rawPairs', ['rawPairs']],
	['measurement', ['measurement']],
	['assignment', assignmentOps.map((op) => op.spec.id)],
	['zfit', zfitOps.map((op) => op.spec.id)],
	['phantomTee', ['phantomTee']],
	['teeFamily', ['teeFamily']],
	['teeRecovery', ['teeRecovery']],
	['cleanBasketFamily', ['cleanBasketFamily']]
]);

export const OPERATION_DEFS: readonly OperationDef[] = [...UNIT_OPERATIONS.values()].flatMap(
	(opIds) =>
		opIds.map((opId) => {
			const def = opDefById.get(opId);
			if (!def) throw new Error(`exec/operations: missing OperationDef for '${opId}'`);
			return def;
		})
);

export const OPERATION_UNIVERSE: readonly OperationSpec[] = OPERATION_DEFS.map((def) => def.spec);

export const operationImpls: ReadonlyMap<string, OperationImpl> = new Map(
	OPERATION_DEFS.map((def) => [def.spec.id, def.run])
);

/** The unit ids compile.ts's inherited validateExecution already understands (unchanged, unit-granularity legality check). */
export const KNOWN_UNIT_IDS: readonly string[] = [...UNIT_OPERATIONS.keys()];

// ---------------------------------------------------------------------------
// Artifact extraction — a representative, not exhaustive, slice of each
// ArtifactKind so the evidence chain exercises every kind the contract
// declares. Kept separate from OperationSpec (contract.ts stays minimal).

function jsonBytes(value: unknown): Uint8Array {
	return new TextEncoder().encode(JSON.stringify(value));
}

function maskBytes(mask: Mask): Uint8Array {
	return mask.data;
}

function floatBytes(data: Float32Array): Uint8Array {
	return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

export interface ArtifactExtraction {
	readonly kind: ArtifactKind;
	readonly id: string;
	readonly bytes: Uint8Array;
	/** Shape for raster kinds. maskBytes()/floatBytes() drop width+height from
	 * the payload, so the extractor -- the only place that still has them --
	 * forwards them here. See rendererContract.ts GAP note. */
	readonly dims?: { readonly width: number; readonly height: number };
}

export const ARTIFACT_EXTRACTORS: Readonly<
	Record<string, (board: ExecBoard) => ArtifactExtraction[]>
> = {
	'badgeStage.masks'(board) {
		const image = board.get<RgbaImage>('localImage');
		const { bright, dark } = board.get<BadgeStageMasks>('badgeStage.masks');
		return [
			{
				kind: 'rgba',
				id: 'badgeStage.masks.localImage',
				bytes: Uint8Array.from(image.data),
				dims: { width: image.width, height: image.height }
			},
			{
				kind: 'mask',
				id: 'badgeStage.masks.bright',
				bytes: maskBytes(bright),
				dims: { width: bright.width, height: bright.height }
			},
			{
				kind: 'mask',
				id: 'badgeStage.masks.dark',
				bytes: maskBytes(dark),
				dims: { width: dark.width, height: dark.height }
			}
		];
	},
	'badgeStage.components'(board) {
		const { brightComponents } = board.get<BadgeStageComponents>('badgeStage.components');
		return [
			{
				kind: 'componentSet',
				id: 'badgeStage.components.bright',
				bytes: jsonBytes(brightComponents)
			}
		];
	},
	'tees.exclusion'(board) {
		const tees = board.get<readonly TeeEvidence[]>('tees');
		return [{ kind: 'candidateSet', id: 'tees.exclusion.kept', bytes: jsonBytes(tees) }];
	},
	supportField(board) {
		const field = board.get<{ support: Float32Array; bestTheta: Float32Array }>('supportField');
		return [
			{ kind: 'scalarField', id: 'supportField.support', bytes: floatBytes(field.support) },
			{ kind: 'orientationField', id: 'supportField.bestTheta', bytes: floatBytes(field.bestTheta) }
		];
	},
	rawPairs(board) {
		const rawPairs = board.get<readonly RawPairEvidence[]>('rawPairs');
		const sample = rawPairs[0];
		if (!sample) return [];
		return [
			{ kind: 'polyline', id: 'rawPairs.sampleTeeLeg', bytes: jsonBytes(sample.teeLeg.path) }
		];
	},
	'assignment.selection'(board) {
		const assignment = board.get<ThreeFactorAssignment>('assignment');
		return [
			{
				kind: 'measurementTable',
				id: 'assignment.selection.table',
				bytes: jsonBytes(assignment.assignments)
			}
		];
	},
	zfit(board) {
		const assignment = board.get<ThreeFactorAssignment>('assignment');
		return [
			{
				kind: 'measurementTable',
				id: 'zfit.finalAssignment.table',
				bytes: jsonBytes(assignment.assignments)
			}
		];
	}
};
