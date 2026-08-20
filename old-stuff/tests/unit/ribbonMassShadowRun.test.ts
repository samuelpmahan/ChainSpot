import { describe, expect, it } from 'vitest';
import type { CorrectionEvent } from '../../src/lib/correctionLog';
import type { RibbonMassSegmentation } from '../../src/lib/autoAnnotation/ribbonMass';
import {
	buildShadowRunA,
	decodeLabelMap,
	deriveBasketDispositions,
	deriveShadowRunExperiments,
	encodeLabelMap,
	freezeProductionSnapshot,
	shadowRunsToExportBlob,
	withComponentAnnotations
} from '../../src/lib/autoAnnotation/ribbonMassShadowRun';
import type {
	FrozenBasketSeed,
	RibbonMassShadowRun
} from '../../src/lib/autoAnnotation/ribbonMassShadowRun';
import type { CourseDetectionResult } from '../../src/lib/autoAnnotation/basketDetection';

describe('label-map RLE codec', () => {
	it('round-trips a label map exactly', () => {
		const labels = new Int32Array([0, 0, 0, 1, 1, 2, 0, 2, 2, 2, 0, 0]);
		const map = encodeLabelMap({ labels, widthEv: 4, heightEv: 3, scale: 3 });
		expect(decodeLabelMap(map)).toEqual(labels);
	});

	it('rejects a map that does not cover its declared dimensions', () => {
		expect(() =>
			decodeLabelMap({ widthEv: 2, heightEv: 2, scale: 3, rle: [1, 3] })
		).toThrow();
	});
});

/**
 * Segmentation fixture used throughout: a 6×2 evidence map at scale 3 with
 * two components. Component 1 spans evidence x 0..2 (source x 0..8),
 * component 2 spans evidence x 4..5 (source x 12..17). Component 2 is
 * texture-admitted; component 1 is not.
 */
function fixtureSegmentation(): RibbonMassSegmentation {
	const labels = new Int32Array([1, 1, 1, 0, 2, 2, 1, 1, 1, 0, 2, 2]);
	return {
		widthEv: 6,
		heightEv: 2,
		scale: 3,
		labels,
		components: [
			{
				label: 1,
				areaPx: 6,
				elongation: 3,
				lStd: 5,
				centroidSrcPx: { xPx: 3, yPx: 1.5 },
				admittedByTexture: false
			},
			{
				label: 2,
				areaPx: 4,
				elongation: 2,
				lStd: 20,
				centroidSrcPx: { xPx: 13.5, yPx: 1.5 },
				admittedByTexture: true
			}
		],
		textureKeptLabels: new Set([2])
	};
}

function fixtureRun(baskets: readonly FrozenBasketSeed[]): RibbonMassShadowRun {
	return buildShadowRunA(
		{
			projectId: 'project-1',
			imageId: 'image-1',
			imageSha256: 'sha',
			segmentation: fixtureSegmentation(),
			snapshot: {
				badges: [
					{
						seedId: 'badge-0',
						xPx: 1,
						yPx: 1,
						detector: 'number-badge',
						productionHoleAssignment: 1
					}
				],
				baskets
			}
		},
		{ createId: () => 'run-1', now: () => new Date('2026-08-12T00:00:00Z') }
	);
}

const FROZEN_BASKET: FrozenBasketSeed = {
	seedId: 'basket-0',
	xPx: 7,
	yPx: 1,
	detector: 'courseGrammar-hungarian',
	confidence: 0.9,
	candidateIndex: 0,
	productionHoleAssignment: 1
};

function basketEvent(
	overrides: Partial<{
		holeNumber: number;
		userAction: CorrectionEvent['userAction'];
		finalValue: { xPx: number; yPx: number } | null;
		priorProposal: CorrectionEvent['priorProposal'];
		timestamp: string;
	}>
): CorrectionEvent {
	return {
		schemaVersion: 1,
		eventId: `event-${Math.random()}`,
		timestamp: overrides.timestamp ?? '2026-08-12T01:00:00Z',
		appVersion: 'test',
		projectId: 'project-1',
		imageId: 'image-1',
		imageSha256: 'sha',
		holeNumber: overrides.holeNumber ?? 1,
		endpoint: 'basket',
		priorProposal:
			overrides.priorProposal !== undefined
				? overrides.priorProposal
				: {
						xPx: FROZEN_BASKET.xPx,
						yPx: FROZEN_BASKET.yPx,
						confidence: 0.9,
						detector: 'courseGrammar-hungarian',
						gateDecision: 'auto-accepted'
					},
		userAction: overrides.userAction ?? 'confirm',
		finalValue:
			overrides.finalValue !== undefined
				? overrides.finalValue
				: { xPx: FROZEN_BASKET.xPx, yPx: FROZEN_BASKET.yPx }
	};
}

describe('freezeProductionSnapshot', () => {
	it('keeps spurious (unassigned) basket candidates with a null assignment', () => {
		const detection = {
			numberDetection: { candidates: [] },
			tees: [],
			baskets: [
				{ xPx: 10, yPx: 10, score: 0.8 },
				{ xPx: 50, yPx: 50, score: 0.4 }
			],
			grammar: {
				holes: [
					{
						number: 3,
						numberBadge: { candidateIndex: 7, xPx: 5, yPx: 5, confidence: 0.95, cost: 0.05 },
						basket: {
							candidateIndex: 0,
							xPx: 10,
							yPx: 10,
							detectorConfidence: 0.8,
							confidence: 0.7,
							distancePx: 12,
							polarityCosine: -1,
							cost: 12
						},
						confidence: 0.7,
						status: 'ready',
						failures: []
					}
				],
				failures: [],
				unassigned: { numberBadgeCandidateIndexes: [], teeCandidateIndexes: [], basketCandidateIndexes: [1] }
			}
		} as unknown as CourseDetectionResult;
		const snapshot = freezeProductionSnapshot(detection);
		expect(snapshot.badges).toEqual([
			{
				seedId: 'badge-7',
				xPx: 5,
				yPx: 5,
				detector: 'number-badge',
				confidence: 0.95,
				candidateIndex: 7,
				productionHoleAssignment: 3
			}
		]);
		expect(snapshot.baskets).toHaveLength(2);
		expect(snapshot.baskets[0].productionHoleAssignment).toBe(3);
		expect(snapshot.baskets[1].productionHoleAssignment).toBeNull();
		expect(snapshot.baskets[1].seedId).toBe('basket-1');
	});
});

describe('deriveBasketDispositions', () => {
	it('marks a confirm at the frozen coordinate for the production hole as confirmed', () => {
		const [seed] = deriveBasketDispositions([FROZEN_BASKET], [basketEvent({})]);
		expect(seed.reviewDisposition).toBe('confirmed');
		expect(seed.confirmedHoleAssignment).toBeUndefined();
	});

	it('marks a final value at the frozen coordinate for a DIFFERENT hole as ownership-corrected', () => {
		const [seed] = deriveBasketDispositions(
			[FROZEN_BASKET],
			[basketEvent({ holeNumber: 2, userAction: 'place' })]
		);
		expect(seed.reviewDisposition).toBe('ownership-corrected');
		expect(seed.confirmedHoleAssignment).toBe(2);
	});

	it('marks a proposal moved off the frozen coordinate as location-rejected', () => {
		const [seed] = deriveBasketDispositions(
			[FROZEN_BASKET],
			[basketEvent({ userAction: 'move', finalValue: { xPx: 40, yPx: 9 } })]
		);
		expect(seed.reviewDisposition).toBe('location-rejected');
	});

	it('does NOT nearest-neighbor match a nearby-but-not-identical final value onto the seed', () => {
		const [seed] = deriveBasketDispositions(
			[FROZEN_BASKET],
			[
				basketEvent({
					holeNumber: 2,
					userAction: 'place',
					priorProposal: null,
					finalValue: { xPx: FROZEN_BASKET.xPx + 3, yPx: FROZEN_BASKET.yPx }
				})
			]
		);
		expect(seed.reviewDisposition).toBeUndefined();
	});

	it('leaves untouched seeds unreviewed and lets the latest event win', () => {
		const [seed] = deriveBasketDispositions(
			[FROZEN_BASKET],
			[
				basketEvent({ timestamp: '2026-08-12T01:00:00Z' }),
				basketEvent({
					timestamp: '2026-08-12T02:00:00Z',
					userAction: 'move',
					finalValue: { xPx: 90, yPx: 90 }
				})
			]
		);
		expect(seed.reviewDisposition).toBe('location-rejected');
		const [untouched] = deriveBasketDispositions([FROZEN_BASKET], []);
		expect(untouched.reviewDisposition).toBeUndefined();
	});
});

describe('buildShadowRunA / experiment derivation', () => {
	it('freezes A with the production topology and the texture baseline', () => {
		const run = fixtureRun([FROZEN_BASKET]);
		expect(run.runId).toBe('run-1');
		expect(run.algorithmVersion).toBeTruthy();
		expect(run.textureBaseline.keptLabels).toEqual([2]);
		const production = run.experiments.production;
		expect(production).toBeDefined();
		// Badge (source 1,1 → evidence 0,0 → label 1) and basket (source 7,1 →
		// evidence 2,0 → label 1) share component 1 exclusively.
		expect(production?.topology.perHole).toEqual([
			{ holeNumber: 1, bucket: 'exclusiveSameComponent', badgeComponentLabel: 1, basketComponentLabel: 1 }
		]);
		// recommended = seed(1) ∪ texture(2).
		expect(production?.recommended.keptLabels).toEqual([1, 2]);
		expect(production?.recommended.maskAreaPx).toBe(10);
	});

	it('B changes ownership only: frozen coordinates stay, corrected identity applies', () => {
		const run = fixtureRun([FROZEN_BASKET]);
		const corrected = deriveShadowRunExperiments(
			run,
			[basketEvent({ holeNumber: 2, userAction: 'place' })],
			[]
		);
		const b = corrected.experiments.ownershipCorrected;
		expect(b).toBeDefined();
		const basketPlacement = b?.seedAssignments.find((seed) => seed.seedId === 'basket-0');
		// Same frozen coordinate → same component; only the hole identity moved.
		expect(basketPlacement?.componentLabel).toBe(1);
		expect(basketPlacement?.holeNumber).toBe(2);
		// Hole 1 keeps its badge but lost its basket to hole 2 → split/noSeedHit territory.
		const holeOne = b?.topology.perHole.find((hole) => hole.holeNumber === 1);
		expect(holeOne?.bucket).toBe('noSeedHit');
		// The stored A record is untouched.
		expect(run.experiments.ownershipCorrected).toBeUndefined();
		expect(run.productionSnapshot.baskets[0].reviewDisposition).toBeUndefined();
		expect(corrected.productionSnapshot.baskets[0].reviewDisposition).toBe('ownership-corrected');
	});

	it('B keeps a location-rejected seed at its production assignment (never the corrected coordinate)', () => {
		const run = fixtureRun([FROZEN_BASKET]);
		const corrected = deriveShadowRunExperiments(
			run,
			[basketEvent({ userAction: 'move', finalValue: { xPx: 13, yPx: 4 } })],
			[]
		);
		const b = corrected.experiments.ownershipCorrected;
		const basketPlacement = b?.seedAssignments.find((seed) => seed.seedId === 'basket-0');
		expect(basketPlacement?.holeNumber).toBe(1);
		// Still the frozen coordinate's component, not the dragged target's.
		expect(basketPlacement?.componentLabel).toBe(1);
	});

	it('C uses review-approved coordinates and evaluates endpoint coverage', () => {
		const run = fixtureRun([FROZEN_BASKET]);
		const derived = deriveShadowRunExperiments(
			run,
			[],
			[{ holeNumber: 1, tee: { xPx: 1, yPx: 1 }, basket: { xPx: 13, yPx: 4 } }]
		);
		const c = derived.experiments.reviewApproved;
		const reviewBasket = c?.seedAssignments.find((seed) => seed.seedId === 'review-basket-1');
		// Source (13,4) → evidence (4,1) → component 2: C's basket moved components.
		expect(reviewBasket?.componentLabel).toBe(2);
		const holeOne = c?.topology.perHole.find((hole) => hole.holeNumber === 1);
		expect(holeOne?.bucket).toBe('split');
		expect(derived.evaluation?.production?.perHole[0].teeDistPx).toBe(0);
		expect(derived.evaluation?.textureBaseline).toBeDefined();
	});
});

describe('withComponentAnnotations', () => {
	it('merges, replaces, and removes labels without touching anything else', async () => {
		const run = fixtureRun([FROZEN_BASKET]);
		const labeled = withComponentAnnotations(run, { 1: { confuserLabel: 'ring-graphic' } });
		expect(labeled.componentAnnotations).toEqual({ 1: { confuserLabel: 'ring-graphic' } });
		expect(labeled.productionSnapshot).toBe(run.productionSnapshot);
		expect(labeled.labelMap).toBe(run.labelMap);
		expect(run.componentAnnotations).toBeUndefined();

		const relabeled = withComponentAnnotations(labeled, {
			1: { confuserLabel: 'powerline' },
			2: { confuserLabel: 'road' }
		});
		expect(relabeled.componentAnnotations).toEqual({
			1: { confuserLabel: 'powerline' },
			2: { confuserLabel: 'road' }
		});
		const cleared = withComponentAnnotations(relabeled, { 2: null });
		expect(cleared.componentAnnotations).toEqual({ 1: { confuserLabel: 'powerline' } });

		// Annotations survive export.
		const exported = JSON.parse(await shadowRunsToExportBlob([relabeled]).text());
		expect(exported[0].componentAnnotations[2].confuserLabel).toBe('road');
	});
});

describe('shadowRunsToExportBlob', () => {
	it('strips the label map payload by default but keeps its dimensions', async () => {
		const run = fixtureRun([FROZEN_BASKET]);
		const blob = shadowRunsToExportBlob([run]);
		const parsed = JSON.parse(await blob.text());
		expect(parsed[0].labelMap.rle).toEqual([]);
		expect(parsed[0].labelMap.widthEv).toBe(6);
		const withMap = JSON.parse(await shadowRunsToExportBlob([run], { includeLabelMap: true }).text());
		expect(withMap[0].labelMap.rle.length).toBeGreaterThan(0);
	});
});
