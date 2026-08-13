/**
 * The ribbon-mass attribution shadow path's run record: an instrumented,
 * local-only sibling of the Annotate Round correction log
 * (`$lib/correctionLog`). One record per whole-image attribution run —
 * a run exists whether or not the user touches anything, which is exactly
 * why it is NOT a `CorrectionEvent` (one correction-relevant user
 * interaction) and must never be nested inside one. The two schemas share
 * storage/export *plumbing patterns* (IndexedDB, local-only, explicit
 * export, no sync) and the correction log's detector/confidence vocabulary
 * (`CorrectionDetector`), nothing more.
 *
 * Lifecycle (see the handoff design):
 *
 *   Detection ──▶ freeze ShadowRun A (immutable production reality)
 *   User review ──▶ CorrectionEvents (raw interactions, separate log)
 *   Post-review ──▶ B: same frozen detections, ownership-only corrections
 *                   C: review-approved location + ownership
 *   Export ──▶ join ShadowRun + CorrectionEvents + final reviewed geometry
 *
 * A is frozen at detection time, before any review exists, and is never
 * mutated afterward: B and C are pure derivations over the stored record
 * (the connected-component label map depends only on the image and the
 * production badge boxes, never on basket seeds, so re-running B/C needs no
 * re-segmentation). The stored record in IndexedDB is always the pure A
 * snapshot; derived B/C/evaluation live only in the exported JSON.
 *
 * Terminology, deliberate: post-review geometry is `reviewApproved`, never
 * "oracle"/"truth"/"groundTruth" — the reviewed coordinate may itself have
 * been influenced by CV-assisted snapping (`applyLocalSnap`) or user error.
 * It is an upper-bound reference condition, not independent truth. Only the
 * two hand-labeled research fixtures may use the word truth, and only in
 * `scripts/cv-probes/`.
 *
 * This shadow path may assign PROVISIONAL ownership from the existing
 * numbered-badge and basket assignments; it must not change authoritative
 * `AnnotatedHole` geometry, arbitrate shared components, bridge split
 * corridors, or gate any production decision.
 */
import type { CorrectionDetector, CorrectionEvent } from '../correctionLog';
import type { CourseDetectionResult } from './basketDetection';
import {
	DEFAULT_RIBBON_MASS_PARAMS,
	keptAreaPx,
	nearestKeptDistancePx,
	placeSeeds,
	recommendedKeptLabels,
	topologyBuckets
} from './ribbonMass';
import type {
	RibbonMassComponentRecord,
	RibbonMassParams,
	RibbonMassSeed,
	RibbonMassSeedPlacement,
	RibbonMassSegmentation,
	RibbonMassTopology
} from './ribbonMass';

/** Bump when the ported algorithm's behavior changes (params live separately in `params`). */
export const RIBBON_MASS_ALGORITHM_VERSION = 'ribbon-mass-ts-1';

export type RibbonMassParamsSnapshot = RibbonMassParams;

export type FrozenSeedReviewDisposition =
	| 'confirmed'
	| 'ownership-corrected'
	| 'location-rejected'
	| 'unreviewed';

export interface FrozenBadgeSeed {
	readonly seedId: string;
	readonly xPx: number;
	readonly yPx: number;
	readonly detector: CorrectionDetector;
	readonly confidence?: number;
	/** Raw index into `CourseDetectionResult.numberDetection.candidates` when known. */
	readonly candidateIndex?: number;
	readonly productionHoleAssignment: number;
}

/**
 * One production basket detection, frozen at detection time — what the
 * production system actually believed, before any review. Missing
 * detections stay missing; spurious ones stay present. The review fields
 * are populated only on the exported/derived copy, only when review
 * establishes something about THIS EXACT frozen detection — a dragged or
 * replaced basket is `location-rejected`, and its corrected coordinate is
 * never folded back into this seed.
 */
export interface FrozenBasketSeed {
	readonly seedId: string;
	readonly xPx: number;
	readonly yPx: number;
	readonly detector: CorrectionDetector;
	readonly confidence?: number;
	/** Raw index into `CourseDetectionResult.baskets`. */
	readonly candidateIndex: number;
	readonly productionHoleAssignment: number | null;
	/**
	 * Populated later only when review establishes that this exact frozen
	 * detection represents a real basket and only its ownership was wrong.
	 */
	readonly confirmedHoleAssignment?: number;
	readonly reviewDisposition?: FrozenSeedReviewDisposition;
}

export interface RibbonMassMaskSummary {
	readonly keptLabels: readonly number[];
	readonly maskAreaPx: number;
}

export interface RibbonMassExperimentResult {
	/** The seed identities in effect for this variant (coordinates always come from the frozen snapshot except in C). */
	readonly seedAssignments: readonly RibbonMassSeedPlacement[];
	readonly recommended: RibbonMassMaskSummary;
	readonly topology: RibbonMassTopology;
}

export interface RibbonMassEndpointDistances {
	readonly holeNumber: number;
	readonly teeDistPx: number | null;
	readonly basketDistPx: number | null;
}

export interface RibbonMassExperimentEvaluation {
	readonly perHole: readonly RibbonMassEndpointDistances[];
	readonly teeWithin30: number;
	readonly basketWithin30: number;
}

export interface RibbonMassEvaluation {
	/** Distances are measured against review-approved geometry — see the module doc for why that is not "truth". */
	readonly reviewApprovedGeometry: readonly ReviewApprovedHole[];
	readonly production?: RibbonMassExperimentEvaluation;
	readonly ownershipCorrected?: RibbonMassExperimentEvaluation;
	readonly reviewApproved?: RibbonMassExperimentEvaluation;
	/** The anchor-independent segmentation baseline (`texture_mask`) — no seed connectivity involved. */
	readonly textureBaseline?: RibbonMassExperimentEvaluation;
}

/** Run-length-encoded label map: [value, count, value, count, ...], row-major. */
export interface RleLabelMap {
	readonly widthEv: number;
	readonly heightEv: number;
	readonly scale: number;
	readonly rle: readonly number[];
}

/**
 * Manual per-component confuser annotations, the optional research-data
 * field the topology findings doc anticipated ("a separate optional
 * confuserLabel can be added to exported research data"). These are HUMAN
 * labels attached after looking at the overlay — there is still no
 * ring/powerline/road classifier anywhere in the pipeline, and nothing
 * reads these labels at inference time. `'ring-graphic'` covers C1/C2
 * putting-circle glyphs regardless of whose basket they belong to:
 * observed directly (2026-08) that a hole's OWN ring tears its corridor
 * before the basket just as foreign rings do, so own-vs-foreign is not an
 * intrinsic property of the component and is not encoded here.
 */
export type RibbonMassConfuserLabel =
	| 'ring-graphic'
	| 'powerline'
	| 'tee-marker-graphic'
	| 'road'
	| 'other';

export const RIBBON_MASS_CONFUSER_LABELS: readonly RibbonMassConfuserLabel[] = [
	'ring-graphic',
	'powerline',
	'tee-marker-graphic',
	'road',
	'other'
];

export interface RibbonMassComponentAnnotation {
	readonly confuserLabel: RibbonMassConfuserLabel;
	readonly note?: string;
}

export interface RibbonMassShadowRun {
	readonly schemaVersion: 1;
	readonly runId: string;
	readonly timestamp: string;
	readonly projectId: string;
	readonly imageId: string;
	readonly imageSha256: string | null;
	readonly algorithmVersion: string;
	readonly params: RibbonMassParamsSnapshot;
	/** Immutable production-time state — never rewritten by review. */
	readonly productionSnapshot: {
		readonly badges: readonly FrozenBadgeSeed[];
		readonly baskets: readonly FrozenBasketSeed[];
	};
	/** Component label map; depends only on the image + badge boxes, so B/C derive from it without re-segmentation. */
	readonly labelMap: RleLabelMap;
	readonly components: readonly RibbonMassComponentRecord[];
	/** Anchor-independent texture baseline (`texture_mask`) — always logged alongside A/B/C. */
	readonly textureBaseline: RibbonMassMaskSummary;
	readonly experiments: {
		/** A: production anchors + production ownership, frozen at detection time. */
		readonly production?: RibbonMassExperimentResult;
		/** B: same frozen detections, ownership-only corrections. */
		readonly ownershipCorrected?: RibbonMassExperimentResult;
		/** C: review-approved basket location + ownership (changes both, relative to A/B). */
		readonly reviewApproved?: RibbonMassExperimentResult;
	};
	readonly evaluation?: RibbonMassEvaluation;
	/**
	 * Manual confuser labels keyed by component label. The ONE post-hoc
	 * mutation the stored record admits — additive human research metadata
	 * that never touches `productionSnapshot`, `labelMap`, `components`, or
	 * `experiments`. Always update through `withComponentAnnotations` so
	 * that boundary stays explicit.
	 */
	readonly componentAnnotations?: Readonly<Record<number, RibbonMassComponentAnnotation>>;
}

/**
 * Returns a copy of `run` with the given component annotations merged in —
 * the only sanctioned way to update a stored run after freezing. Everything
 * except `componentAnnotations` is carried over untouched.
 */
export function withComponentAnnotations(
	run: RibbonMassShadowRun,
	annotations: Readonly<Record<number, RibbonMassComponentAnnotation | null>>
): RibbonMassShadowRun {
	const merged: Record<number, RibbonMassComponentAnnotation> = { ...run.componentAnnotations };
	for (const [key, annotation] of Object.entries(annotations)) {
		if (annotation === null) delete merged[Number(key)];
		else merged[Number(key)] = annotation;
	}
	return { ...run, componentAnnotations: merged };
}

// ---------------------------------------------------------------------------
// Label-map codec
// ---------------------------------------------------------------------------

export function encodeLabelMap(
	segmentation: Pick<RibbonMassSegmentation, 'labels' | 'widthEv' | 'heightEv' | 'scale'>
): RleLabelMap {
	const { labels } = segmentation;
	const rle: number[] = [];
	let i = 0;
	while (i < labels.length) {
		const value = labels[i];
		let count = 1;
		while (i + count < labels.length && labels[i + count] === value) count += 1;
		rle.push(value, count);
		i += count;
	}
	return { widthEv: segmentation.widthEv, heightEv: segmentation.heightEv, scale: segmentation.scale, rle };
}

export function decodeLabelMap(map: RleLabelMap): Int32Array {
	const labels = new Int32Array(map.widthEv * map.heightEv);
	let out = 0;
	for (let i = 0; i < map.rle.length; i += 2) {
		const value = map.rle[i];
		const count = map.rle[i + 1];
		labels.fill(value, out, out + count);
		out += count;
	}
	if (out !== labels.length) throw new Error('RLE label map does not cover its declared dimensions');
	return labels;
}

// ---------------------------------------------------------------------------
// Freezing A
// ---------------------------------------------------------------------------

/**
 * Freeze the production snapshot from a just-completed detection result —
 * exactly what the pipeline believed, before any review: grammar-assigned
 * badges, and every raw basket candidate with the grammar's hole assignment
 * where one exists (null otherwise; spurious candidates stay present,
 * missing ones stay missing — nothing is repaired here).
 *
 * Detector attribution reuses `CorrectionDetector` (the correction log's
 * vocabulary): badge assignments are `'number-badge'` detections, basket
 * candidates are surfaced through the `'courseGrammar-hungarian'` pipeline
 * the correction log already attributes basket proposals to.
 */
export function freezeProductionSnapshot(detection: CourseDetectionResult): {
	badges: FrozenBadgeSeed[];
	baskets: FrozenBasketSeed[];
} {
	const badges: FrozenBadgeSeed[] = [];
	const assignedBasketByCandidate = new Map<number, { holeNumber: number; confidence: number }>();
	for (const hole of detection.grammar.holes) {
		if (hole.numberBadge) {
			badges.push({
				seedId: `badge-${hole.numberBadge.candidateIndex}`,
				xPx: hole.numberBadge.xPx,
				yPx: hole.numberBadge.yPx,
				detector: 'number-badge',
				confidence: hole.numberBadge.confidence,
				candidateIndex: hole.numberBadge.candidateIndex,
				productionHoleAssignment: hole.number
			});
		}
		if (hole.basket) {
			assignedBasketByCandidate.set(hole.basket.candidateIndex, {
				holeNumber: hole.number,
				confidence: hole.basket.detectorConfidence
			});
		}
	}
	const baskets: FrozenBasketSeed[] = detection.baskets.map((candidate, index) => {
		const assignment = assignedBasketByCandidate.get(index);
		return {
			seedId: `basket-${index}`,
			xPx: candidate.xPx,
			yPx: candidate.yPx,
			detector: 'courseGrammar-hungarian',
			...(typeof candidate.score === 'number' ? { confidence: candidate.score } : {}),
			candidateIndex: index,
			productionHoleAssignment: assignment?.holeNumber ?? null
		};
	});
	return { badges, baskets };
}

function badgeSeeds(badges: readonly FrozenBadgeSeed[]): RibbonMassSeed[] {
	return badges.map((badge) => ({
		seedId: badge.seedId,
		kind: 'badge',
		holeNumber: badge.productionHoleAssignment,
		xPx: badge.xPx,
		yPx: badge.yPx
	}));
}

/**
 * The basket seeds a given experiment grows from. Mirrors the research
 * probes: only hole-assigned baskets seed the mask (`baskets_by_n`), so a
 * frozen candidate with a null assignment is recorded in the snapshot but
 * seeds nothing until some derivation gives it an identity.
 */
function basketSeeds(
	baskets: readonly FrozenBasketSeed[],
	holeAssignment: (basket: FrozenBasketSeed) => number | null
): RibbonMassSeed[] {
	const seeds: RibbonMassSeed[] = [];
	for (const basket of baskets) {
		const holeNumber = holeAssignment(basket);
		if (holeNumber === null) continue;
		seeds.push({ seedId: basket.seedId, kind: 'basket', holeNumber, xPx: basket.xPx, yPx: basket.yPx });
	}
	return seeds;
}

function runExperiment(
	labels: Int32Array,
	labelMap: RleLabelMap,
	textureKeptLabels: ReadonlySet<number>,
	seeds: readonly RibbonMassSeed[],
	holeNumbers: readonly number[],
	params: RibbonMassParams
): RibbonMassExperimentResult {
	const segmentationView = {
		labels,
		widthEv: labelMap.widthEv,
		heightEv: labelMap.heightEv,
		scale: labelMap.scale
	};
	const placements = placeSeeds(segmentationView, seeds, params.seedRadiusPx);
	const kept = recommendedKeptLabels({ textureKeptLabels }, placements);
	return {
		seedAssignments: placements,
		recommended: {
			keptLabels: [...kept].sort((a, b) => a - b),
			maskAreaPx: keptAreaPx(labels, kept)
		},
		topology: topologyBuckets(placements, holeNumbers)
	};
}

export interface BuildShadowRunInput {
	readonly projectId: string;
	readonly imageId: string;
	readonly imageSha256: string | null;
	readonly segmentation: RibbonMassSegmentation;
	readonly snapshot: { readonly badges: readonly FrozenBadgeSeed[]; readonly baskets: readonly FrozenBasketSeed[] };
	readonly params?: RibbonMassParams;
}

export interface BuildShadowRunOptions {
	readonly createId?: () => string;
	readonly now?: () => Date;
}

/** The hole numbers an experiment classifies: every hole production assigned a badge or basket to. */
function snapshotHoleNumbers(snapshot: BuildShadowRunInput['snapshot']): number[] {
	const holes = new Set<number>();
	for (const badge of snapshot.badges) holes.add(badge.productionHoleAssignment);
	for (const basket of snapshot.baskets) {
		if (basket.productionHoleAssignment !== null) holes.add(basket.productionHoleAssignment);
	}
	return [...holes].sort((a, b) => a - b);
}

/**
 * Freeze ShadowRun A: the immutable production-reality record, including
 * experiment A (production anchors + production ownership) and the
 * anchor-independent texture baseline. Runs at detection time, before any
 * review exists — never call this with post-review state.
 */
export function buildShadowRunA(
	input: BuildShadowRunInput,
	options: BuildShadowRunOptions = {}
): RibbonMassShadowRun {
	const { createId = () => globalThis.crypto.randomUUID(), now = () => new Date() } = options;
	const params = input.params ?? DEFAULT_RIBBON_MASS_PARAMS;
	const { segmentation, snapshot } = input;
	const labelMap = encodeLabelMap(segmentation);
	const holeNumbers = snapshotHoleNumbers(snapshot);
	const seeds = [
		...badgeSeeds(snapshot.badges),
		...basketSeeds(snapshot.baskets, (basket) => basket.productionHoleAssignment)
	];
	return {
		schemaVersion: 1,
		runId: createId(),
		timestamp: now().toISOString(),
		projectId: input.projectId,
		imageId: input.imageId,
		imageSha256: input.imageSha256,
		algorithmVersion: RIBBON_MASS_ALGORITHM_VERSION,
		params,
		productionSnapshot: snapshot,
		labelMap,
		components: segmentation.components,
		textureBaseline: {
			keptLabels: [...segmentation.textureKeptLabels].sort((a, b) => a - b),
			maskAreaPx: keptAreaPx(segmentation.labels, segmentation.textureKeptLabels)
		},
		experiments: {
			production: runExperiment(
				segmentation.labels,
				labelMap,
				segmentation.textureKeptLabels,
				seeds,
				holeNumbers,
				params
			)
		}
	};
}

// ---------------------------------------------------------------------------
// Review joining: dispositions for the frozen basket seeds
// ---------------------------------------------------------------------------

/**
 * How close (source px) an event coordinate must be to a frozen seed
 * coordinate to be "the same point". Confirm events echo the proposal
 * coordinate exactly; the tolerance only absorbs float round-tripping, not
 * snap distances — a snapped/dragged coordinate near-but-not-at a frozen
 * detection is deliberately NOT matched back to it (nearest-neighbor
 * matching of later geometry onto frozen seeds is exactly what experiment B
 * must never do).
 */
const SAME_POINT_EPS_PX = 0.5;

function samePoint(ax: number, ay: number, bx: number, by: number): boolean {
	return Math.hypot(ax - bx, ay - by) <= SAME_POINT_EPS_PX;
}

/**
 * Join the frozen basket seeds against the correction log, producing the
 * derived per-seed review dispositions:
 *
 * - `confirmed`: review kept this exact frozen coordinate for its
 *   production hole (a `confirm`, or a final value identical to the seed).
 * - `ownership-corrected`: review established this exact frozen coordinate
 *   is a real basket belonging to a DIFFERENT hole (the final value of some
 *   other hole's basket review lands exactly on the frozen detection).
 * - `location-rejected`: review moved/replaced the proposal made from this
 *   seed — the frozen detection did not survive as a location. Its
 *   corrected coordinate is never used by experiment B.
 * - `unreviewed`: no correction event says anything about this seed.
 *
 * Events are processed in timestamp order; the latest relevant interaction
 * wins, matching the append-only log's semantics.
 */
export function deriveBasketDispositions(
	baskets: readonly FrozenBasketSeed[],
	events: readonly CorrectionEvent[]
): FrozenBasketSeed[] {
	const basketEvents = events
		.filter((event) => event.endpoint === 'basket')
		.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
	return baskets.map((seed) => {
		let disposition: FrozenSeedReviewDisposition = 'unreviewed';
		let confirmedHole: number | undefined;
		for (const event of basketEvents) {
			const proposalIsSeed =
				event.priorProposal !== null &&
				samePoint(event.priorProposal.xPx, event.priorProposal.yPx, seed.xPx, seed.yPx);
			const finalIsSeed =
				event.finalValue !== null &&
				samePoint(event.finalValue.xPx, event.finalValue.yPx, seed.xPx, seed.yPx);
			if (finalIsSeed) {
				// Review ended with a basket exactly at this frozen detection.
				if (event.holeNumber === seed.productionHoleAssignment) {
					disposition = 'confirmed';
					confirmedHole = undefined;
				} else {
					disposition = 'ownership-corrected';
					confirmedHole = event.holeNumber;
				}
			} else if (proposalIsSeed && event.userAction !== 'skip') {
				// The proposal under review was this seed and the final value
				// moved off it (or was placed elsewhere).
				disposition = 'location-rejected';
				confirmedHole = undefined;
			}
		}
		if (disposition === 'unreviewed') return seed;
		return {
			...seed,
			reviewDisposition: disposition,
			...(confirmedHole !== undefined ? { confirmedHoleAssignment: confirmedHole } : {})
		};
	});
}

// ---------------------------------------------------------------------------
// Deriving B and C
// ---------------------------------------------------------------------------

export interface ReviewApprovedHole {
	readonly holeNumber: number;
	readonly tee?: { readonly xPx: number; readonly yPx: number };
	readonly basket?: { readonly xPx: number; readonly yPx: number };
}

/**
 * Experiment B: the exact frozen seed coordinates and seedIds from A; the
 * only permitted counterfactual change is `productionHoleAssignment` →
 * `confirmedHoleAssignment` for seeds whose review disposition is
 * `ownership-corrected`. Location-rejected and unreviewed seeds keep their
 * production assignment (a spurious detection stays present, a missing one
 * stays missing) — A→B stays a genuine ownership-only experiment.
 */
export function deriveExperimentB(
	run: RibbonMassShadowRun,
	dispositionedBaskets: readonly FrozenBasketSeed[]
): RibbonMassExperimentResult {
	const labels = decodeLabelMap(run.labelMap);
	const holeNumbers = new Set<number>(snapshotHoleNumbers(run.productionSnapshot));
	for (const basket of dispositionedBaskets) {
		if (basket.confirmedHoleAssignment !== undefined) holeNumbers.add(basket.confirmedHoleAssignment);
	}
	const seeds = [
		...badgeSeeds(run.productionSnapshot.badges),
		...basketSeeds(dispositionedBaskets, (basket) =>
			basket.reviewDisposition === 'ownership-corrected' && basket.confirmedHoleAssignment !== undefined
				? basket.confirmedHoleAssignment
				: basket.productionHoleAssignment
		)
	];
	return runExperiment(
		labels,
		run.labelMap,
		new Set(run.textureBaseline.keptLabels),
		seeds,
		[...holeNumbers].sort((a, b) => a - b),
		run.params
	);
}

/**
 * Experiment C: review-approved basket location + ownership. This
 * intentionally changes both coordinate and identity relative to A/B, so
 * B→C is NOT a single-variable comparison — `textureBaseline` is the
 * anchor-independent segmentation reference, not C. Badges stay frozen
 * (badges are not reviewed by this flow).
 */
export function deriveExperimentC(
	run: RibbonMassShadowRun,
	reviewApproved: readonly ReviewApprovedHole[]
): RibbonMassExperimentResult {
	const labels = decodeLabelMap(run.labelMap);
	const holeNumbers = new Set<number>(snapshotHoleNumbers(run.productionSnapshot));
	const seeds: RibbonMassSeed[] = [...badgeSeeds(run.productionSnapshot.badges)];
	for (const hole of reviewApproved) {
		if (!hole.basket) continue;
		holeNumbers.add(hole.holeNumber);
		seeds.push({
			seedId: `review-basket-${hole.holeNumber}`,
			kind: 'basket',
			holeNumber: hole.holeNumber,
			xPx: hole.basket.xPx,
			yPx: hole.basket.yPx
		});
	}
	return runExperiment(
		labels,
		run.labelMap,
		new Set(run.textureBaseline.keptLabels),
		seeds,
		[...holeNumbers].sort((a, b) => a - b),
		run.params
	);
}

function evaluateKeptSet(
	labels: Int32Array,
	map: RleLabelMap,
	kept: ReadonlySet<number>,
	reviewApproved: readonly ReviewApprovedHole[]
): RibbonMassExperimentEvaluation {
	const perHole: RibbonMassEndpointDistances[] = [];
	let teeWithin30 = 0;
	let basketWithin30 = 0;
	for (const hole of reviewApproved) {
		const teeDistPx = hole.tee
			? nearestKeptDistancePx(labels, map.widthEv, map.heightEv, map.scale, kept, hole.tee.xPx, hole.tee.yPx)
			: null;
		const basketDistPx = hole.basket
			? nearestKeptDistancePx(
					labels,
					map.widthEv,
					map.heightEv,
					map.scale,
					kept,
					hole.basket.xPx,
					hole.basket.yPx
				)
			: null;
		if (teeDistPx !== null && teeDistPx <= 30) teeWithin30 += 1;
		if (basketDistPx !== null && basketDistPx <= 30) basketWithin30 += 1;
		perHole.push({
			holeNumber: hole.holeNumber,
			teeDistPx: teeDistPx === null ? null : Number.isFinite(teeDistPx) ? teeDistPx : null,
			basketDistPx: basketDistPx === null ? null : Number.isFinite(basketDistPx) ? basketDistPx : null
		});
	}
	return { perHole, teeWithin30, basketWithin30 };
}

/**
 * Post-review derivation: joins one stored ShadowRun A with the correction
 * log and the final review-approved geometry, returning a NEW record with
 * experiments B/C, the per-seed dispositions, and endpoint-coverage
 * evaluation filled in. The input run (and the stored copy it came from) is
 * never mutated — the stored record stays pure production reality.
 */
export function deriveShadowRunExperiments(
	run: RibbonMassShadowRun,
	events: readonly CorrectionEvent[],
	reviewApproved: readonly ReviewApprovedHole[]
): RibbonMassShadowRun {
	const dispositionedBaskets = deriveBasketDispositions(run.productionSnapshot.baskets, events);
	const ownershipCorrected = deriveExperimentB(run, dispositionedBaskets);
	const reviewApprovedResult = deriveExperimentC(run, reviewApproved);
	const labels = decodeLabelMap(run.labelMap);
	const evaluate = (kept: readonly number[]) =>
		evaluateKeptSet(labels, run.labelMap, new Set(kept), reviewApproved);
	return {
		...run,
		productionSnapshot: {
			badges: run.productionSnapshot.badges,
			baskets: dispositionedBaskets
		},
		experiments: {
			...run.experiments,
			ownershipCorrected,
			reviewApproved: reviewApprovedResult
		},
		evaluation: {
			reviewApprovedGeometry: reviewApproved,
			...(run.experiments.production
				? { production: evaluate(run.experiments.production.recommended.keptLabels) }
				: {}),
			ownershipCorrected: evaluate(ownershipCorrected.recommended.keptLabels),
			reviewApproved: evaluate(reviewApprovedResult.recommended.keptLabels),
			textureBaseline: evaluate(run.textureBaseline.keptLabels)
		}
	};
}

// ---------------------------------------------------------------------------
// Persistence: own IndexedDB database, sibling to (not inside) the
// correction log's — same pattern, separate lifecycle.
// ---------------------------------------------------------------------------

export interface RibbonMassShadowRunStore {
	append(run: RibbonMassShadowRun): Promise<void>;
	getAll(): Promise<readonly RibbonMassShadowRun[]>;
}

export const RIBBON_MASS_SHADOW_DB_NAME = 'chainspot-ribbon-mass-shadow';
export const RIBBON_MASS_SHADOW_DB_VERSION = 1;
export const RIBBON_MASS_SHADOW_STORE_NAME = 'runs';

function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
	});
}

function promisifyTransaction(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
		transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
	});
}

export class IndexedDbRibbonMassShadowRunStore implements RibbonMassShadowRunStore {
	readonly #factory: IDBFactory;

	constructor(factory: IDBFactory = globalThis.indexedDB) {
		this.#factory = factory;
	}

	#open(): Promise<IDBDatabase> {
		return new Promise((resolve, reject) => {
			const request = this.#factory.open(RIBBON_MASS_SHADOW_DB_NAME, RIBBON_MASS_SHADOW_DB_VERSION);
			request.onupgradeneeded = () => {
				const db = request.result;
				if (!db.objectStoreNames.contains(RIBBON_MASS_SHADOW_STORE_NAME)) {
					db.createObjectStore(RIBBON_MASS_SHADOW_STORE_NAME, { keyPath: 'runId' });
				}
			};
			request.onsuccess = () => resolve(request.result);
			request.onerror = () =>
				reject(request.error ?? new Error('failed to open the ribbon-mass shadow-run database'));
		});
	}

	async append(run: RibbonMassShadowRun): Promise<void> {
		const db = await this.#open();
		try {
			const transaction = db.transaction(RIBBON_MASS_SHADOW_STORE_NAME, 'readwrite');
			transaction.objectStore(RIBBON_MASS_SHADOW_STORE_NAME).put(run);
			await promisifyTransaction(transaction);
		} finally {
			db.close();
		}
	}

	async getAll(): Promise<readonly RibbonMassShadowRun[]> {
		const db = await this.#open();
		try {
			const store = db
				.transaction(RIBBON_MASS_SHADOW_STORE_NAME, 'readonly')
				.objectStore(RIBBON_MASS_SHADOW_STORE_NAME);
			return await promisifyRequest(store.getAll());
		} finally {
			db.close();
		}
	}
}

let defaultStore: RibbonMassShadowRunStore | null = null;

export function getDefaultRibbonMassShadowRunStore(): RibbonMassShadowRunStore {
	defaultStore ??= new IndexedDbRibbonMassShadowRunStore();
	return defaultStore;
}

/**
 * Plain JSON export of derived shadow runs — exported alongside, but
 * separately from, correction events (two files, two schemas; they join on
 * projectId/imageId/holeNumber/seedId). The label map is stripped by
 * default: it exists to make B/C derivable, and once they are derived it is
 * bulky raster provenance the analysis side rarely needs.
 */
export function shadowRunsToExportBlob(
	runs: readonly RibbonMassShadowRun[],
	options: { readonly includeLabelMap?: boolean } = {}
): Blob {
	const exported = options.includeLabelMap
		? runs
		: runs.map((run) => {
				const { labelMap, ...rest } = run;
				return { ...rest, labelMap: { widthEv: labelMap.widthEv, heightEv: labelMap.heightEv, scale: labelMap.scale, rle: [] } };
			});
	return new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' });
}
