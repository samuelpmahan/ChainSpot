import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import {
	createExecBoard,
	executeCompiledPlan,
	validateOperationOrder,
	withHoleLabels,
	type CompiledExecutionPlan,
	type HoleLabeledAssignment
} from '@chainspot/alg/exec';
import { createNodeSink } from '@chainspot/alg/exec/node-sink';
import {
	buildChainOfCustody,
	canonicalJson,
	sha256Hex,
	type ChainOfCustodyLedger
} from '@chainspot/alg/detectors/threeFactor';
import {
	createTraceContext,
	resolveConfiguredParams
} from '@chainspot/alg/detectors/threeFactor/engine';
import { seedBoard } from '@chainspot/alg/detectors/threeFactor/measure';
import type { EvidenceBoard, RunTrace } from '@chainspot/alg/detectors/threeFactor/features/types';
import type {
	RawPairEvidence,
	RecoveredTeeInput,
	ThreeFactorAssignment,
	ThreeFactorMeasurement
} from '@chainspot/alg/detectors/threeFactor/types';
import type { CanonicalTruth } from '@chainspot/alg/g0/truth';
import type {
	BadgeEvidence,
	BasketEvidence,
	TeeEvidence
} from '@chainspot/alg/detectors/threeFactor/types';
import type { LocatedDetection } from './truthScoring';
import type {
	StraightTestTruthAssistance,
	StraightTestTruthLock
} from '@chainspot/alg/detectors/threeFactor/features/st.straightTest.contract';
import {
	makeTraceRunId,
	sealTrace
} from '@chainspot/alg/detectors/threeFactor/features/traceIdentity';
import { loadConfig } from './configIo';
import { canonicalizeInputs } from './inputShim';
import { associateDetections, compareTruthGrounding, loadTruth, scoreTruth } from './truthScoring';
import { renderArtifact, type ArtifactRenderResult } from './artifactIo';
import { renderRunEndpointReceipt, type RenderTraceFeaturesOutput } from './featureRenders';
import {
	GATE_ORDER,
	THROUGH_CUTOFF_CONTRACTS,
	gateLabel,
	gateRank,
	isSweepThroughGate,
	operationOwnerGate,
	type EngineGateId,
	type SweepThroughGate
} from './gateVocabulary';
import {
	buildRunReceipt,
	compareToPreviousRun,
	writeRunReceiptJson,
	type RunReceipt,
	type RunReceiptSliceInput,
	type RunReceiptSliceOperation,
	type RunReceiptVisualRender,
	type RunPhaseTimings
} from './runReceipt';
import { formatRunReceiptText } from './runReceiptText';
import { formatCustodyReceiptText } from './custodyReceiptText';
import { guardTruthTaint } from '../context/context.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg']);

export function canonicalSweepRunName(inputPaths: readonly string[]): string {
	if (inputPaths.length === 1) return basename(inputPaths[0], extname(inputPaths[0]));
	const first = basename(inputPaths[0], extname(inputPaths[0]));
	return `${first}-plus-${inputPaths.length - 1}-tiles`;
}

export function compileSweepConfig(configPath: string) {
	return loadConfig(configPath);
}

export interface RunSweepOperationInput {
	readonly configPath: string;
	readonly inputPaths: readonly string[];
	readonly truthPath?: string;
	readonly outDir?: string;
	readonly throughGate?: SweepThroughGate;
}

export interface RunSweepOperationResult {
	readonly configPath: string;
	readonly configName: string;
	readonly plan: ReturnType<typeof loadConfig>['plan'];
	readonly receipts: ReturnType<typeof executeCompiledPlan>;
	readonly report: Awaited<ReturnType<typeof canonicalizeInputs>>['report'];
	readonly outDir: string;
	readonly artifactRenders: readonly ArtifactRenderResult[];
	readonly featureRenders: RenderTraceFeaturesOutput;
	readonly trace: RunTrace;
	readonly renderedCount: number;
	readonly stubbedCount: number;
	readonly scoreboard?: ReturnType<typeof scoreTruth>;
	readonly measurement?: ThreeFactorMeasurement;
	readonly groundingComparisons: ReturnType<typeof compareTruthGrounding>;
	readonly truthScoringSkipped: boolean;
	readonly truthScoringReason?: string;
	readonly throughGate?: SweepThroughGate;
	readonly runReceipt: RunReceipt;
	readonly runReceiptPaths: readonly string[];
}

export interface TruthScoringDecision {
	readonly eligible: boolean;
	readonly provenanceTrusted: boolean;
	readonly reason?: string;
}

function teeDetections(tees: readonly TeeEvidence[]): LocatedDetection[] {
	return tees.map((tee) => ({
		id: tee.detId,
		spriteType: 'tee',
		identity: tee.detId,
		xPx: tee.xPx,
		yPx: tee.yPx,
		measurements: { tier: tee.tier }
	}));
}

function basketDetections(baskets: readonly BasketEvidence[]): LocatedDetection[] {
	return baskets.map((basket) => ({
		id: basket.detId,
		spriteType: 'basket',
		identity: basket.detId,
		xPx: basket.tipXPx,
		yPx: basket.tipYPx,
		measurements: { tier: basket.tier ?? 'unknown' }
	}));
}

/** Build the explicit comparison-only payload after the detector prefix has
 * run. Canonical endpoint coordinates are retained verbatim, while IDs name
 * matched detector evidence where it exists (or an annotation-only ref for
 * an absent endpoint). Nothing is written back to detector slots. */
export function buildStraightTestTruthAssistance(
	truth: CanonicalTruth,
	badges: readonly BadgeEvidence[],
	tees: readonly TeeEvidence[],
	baskets: readonly BasketEvidence[],
	provenance = 'verified canonical truth match'
): StraightTestTruthAssistance {
	const teeMatches =
		associateDetections(
			truth.holes.map((hole) => ({ identity: `H${hole.number}`, point: hole.tee })),
			teeDetections(tees)
		).objectMatches ?? [];
	const basketMatches =
		associateDetections(
			truth.holes.map((hole) => ({ identity: `H${hole.number}`, point: hole.basket })),
			basketDetections(baskets)
		).objectMatches ?? [];
	const teesByHole = new Map(teeMatches.map((match) => [match.truthIdentity, match.detection.id]));
	const basketsByHole = new Map(
		basketMatches.map((match) => [match.truthIdentity, match.detection.id])
	);
	const locks: StraightTestTruthLock[] = [];
	for (const hole of [...truth.holes].sort((a, b) => a.number - b.number)) {
		const badge = badges.find((candidate) => candidate.label === String(hole.number));
		if (!badge) continue;
		const teeId = teesByHole.get(`H${hole.number}`) ?? `truth:H${hole.number}:tee`;
		const basketId = basketsByHole.get(`H${hole.number}`) ?? `truth:H${hole.number}:basket`;
		locks.push({
			holeNumber: hole.number,
			badgeId: badge.detId,
			teeId,
			basketId,
			teeReference: teesByHole.has(`H${hole.number}`) ? 'detector' : 'canonical-annotation',
			basketReference: basketsByHole.has(`H${hole.number}`) ? 'detector' : 'canonical-annotation',
			canonicalTee: { ...hole.tee, provenance: 'canonical-annotation-tee' },
			canonicalBasket: { ...hole.basket, provenance: 'canonical-annotation-basket' },
			provenance: 'canonical-annotation-endpoint-lock'
		});
	}
	return { mode: 'verified-canonical', taint: 'TRUTH-TAINT', provenance, locks };
}

/** Decide whether a supplied truth file can support an authoritative
 * scoreboard in the canonical execution frame. Diagnostic grounding may
 * still run with provenanceTrusted=false when canonical coordinates exist. */
export function decideTruthScoring(
	report: Awaited<ReturnType<typeof canonicalizeInputs>>['report'],
	canonicalTruth: CanonicalTruth | undefined
): TruthScoringDecision {
	if (!report.truthMatch) {
		return {
			eligible: false,
			provenanceTrusted: false,
			reason: 'Supplied truth does not correspond to the canonical raster.'
		};
	}
	if (report.truthMatch.level === 'dims-only') {
		return {
			eligible: false,
			provenanceTrusted: false,
			reason:
				'Dimensions-only truth correspondence is unverified and cannot produce an official scoreboard.'
		};
	}
	if (!canonicalTruth) {
		return {
			eligible: false,
			provenanceTrusted: false,
			reason:
				'Truth coordinates were not mapped into the canonical raster; multi-input truth requires an explicit composite-frame mapping.'
		};
	}
	return { eligible: true, provenanceTrusted: true };
}

/** What a `--through` cutoff scheduled, what it pulled in as prerequisites,
 * and what it left out — the receipt prints this verbatim. The shape is the
 * receipt's (runReceipt.ts) so the two files cannot drift. */
export type PlanSliceOperationNote = RunReceiptSliceOperation;
export type PlanSlice = RunReceiptSliceInput;

export interface SlicedExecutionPlan extends CompiledExecutionPlan {
	readonly slice: PlanSlice;
}

/**
 * Dependency-complete cutoff semantics (design note: gateVocabulary.ts).
 *
 * The slice is the contiguous chronological PREFIX of the compiled plan
 * ending at the last scheduled operation semantically owned by any gate of
 * the cutoff's cumulative phase (gates at or below the cutoff, plus the
 * phase's declared forward reach: G5 folds in the G6-owned straight-hole
 * assignment, G6 folds in the terminal G7 zfit slot). A prefix of a
 * dependency-validated order is dependency-complete by construction, and —
 * unlike any non-contiguous subset — leaves every operation's board input
 * byte-identical to the full run, because in-place slot rewriters
 * (badgeOcclusionPatch, teeFamily, teeRecovery) are never skipped over.
 */
export async function slicePlanThroughGate(
	plan: CompiledExecutionPlan,
	throughGate: SweepThroughGate
): Promise<SlicedExecutionPlan> {
	if (!isSweepThroughGate(throughGate)) {
		throw new Error(
			`lab sweep: --through supports only the dependency-complete cutoffs ${GATE_ORDER.join(', ')}.`
		);
	}
	const contract = THROUGH_CUTOFF_CONTRACTS[throughGate];
	const cutoffRank = gateRank(throughGate);
	const includedGates = new Set<EngineGateId>(
		GATE_ORDER.filter((gate) => gateRank(gate) <= cutoffRank)
	);
	for (const gate of contract.ownGates) includedGates.add(gate);

	const scheduledIds = new Set(plan.ops.map((op) => op.id));
	if (!contract.demonstratedBy.some((id) => scheduledIds.has(id))) {
		throw new Error(
			`lab sweep: --through ${throughGate} (${gateLabel(throughGate)}) selects no scheduled operation: ` +
				`this config schedules none of ${contract.demonstratedBy.join(', ')}, ` +
				`so the phase '${contract.phase}' cannot be demonstrated. Use an earlier cutoff.`
		);
	}

	let lastIndex = -1;
	plan.ops.forEach((op, index) => {
		const owner = operationOwnerGate(op.id);
		if (owner !== 'shared' && includedGates.has(owner)) lastIndex = index;
	});
	const ops = plan.ops.slice(0, lastIndex + 1);
	try {
		validateOperationOrder(ops);
	} catch (error) {
		throw new Error(
			`lab sweep: --through ${throughGate} cannot form a dependency-complete gate slice: ${(error as Error).message}`,
			{ cause: error }
		);
	}

	const prerequisites: PlanSliceOperationNote[] = [];
	ops.forEach((op, index) => {
		const owner = operationOwnerGate(op.id);
		if (owner === 'shared' || includedGates.has(owner)) return;
		let reason = 'scheduled between cutoff-owned operations in the frozen chronological plan';
		for (let later = index + 1; later < ops.length; later++) {
			const consumer = ops[later];
			const slot = op.produces.find((produced) => consumer.consumes.includes(produced));
			if (slot) {
				reason = `produces '${slot}' consumed by '${consumer.id}'`;
				break;
			}
		}
		prerequisites.push({ id: op.id, ownerGate: owner, reason });
	});
	const notScheduled: PlanSliceOperationNote[] = plan.ops.slice(lastIndex + 1).map((op) => ({
		id: op.id,
		ownerGate: operationOwnerGate(op.id),
		reason: `not scheduled (--through ${throughGate})`
	}));

	const planFingerprint = await sha256Hex(
		canonicalJson({ parentPlanFingerprint: plan.planFingerprint, throughGate, ops })
	);
	return {
		...plan,
		ops,
		planFingerprint,
		slice: {
			throughGate,
			phase: contract.phase,
			parentOperationCount: plan.ops.length,
			prerequisites,
			notScheduled
		}
	};
}

export async function runSweepOperation(
	input: RunSweepOperationInput
): Promise<RunSweepOperationResult> {
	const runStartedAtMs = performance.now();
	const configStartedAtMs = performance.now();
	if (!input.configPath) throw new Error('lab sweep: configPath is required.');
	if (input.inputPaths.length === 0) throw new Error('lab sweep: no input image given.');
	const inputPaths = input.inputPaths.map((path) => resolve(path));
	for (const path of inputPaths) {
		if (!IMAGE_EXTENSIONS.has(extname(path).toLowerCase())) {
			throw new Error(`lab sweep: input '${path}' is not .png/.jpg/.jpeg.`);
		}
	}
	const truthPath = input.truthPath ? resolve(input.truthPath) : undefined;
	const configPath = resolve(input.configPath);
	const firstLoad = loadConfig(configPath);
	const paramsHash = await sha256Hex(canonicalJson(firstLoad.resolved));
	const loaded = loadConfig(configPath, paramsHash);
	const slicedPlan = input.throughGate
		? await slicePlanThroughGate(loaded.plan, input.throughGate)
		: undefined;
	const plan = slicedPlan ?? loaded.plan;
	const straightState = loaded.resolved.features['straightTest'];
	const truthAssisted =
		straightState?.enabled === true && straightState.knobs['truthAssisted'] === true;
	if (truthAssisted && !truthPath) {
		throw new Error(
			'lab sweep: truth-assisted Straight Test requires a supplied verified canonical truth file.'
		);
	}
	if (truthAssisted) guardTruthTaint(['lab', 'sweep', configPath, ...inputPaths, truthPath!]);
	// The taint/config firewall is intentionally before this read. A blind or
	// automated test invocation must refuse before it can inspect annotation
	// bytes, even when the supplied path is malformed or unreadable.
	const truth = truthPath ? loadTruth(truthPath) : undefined;
	const configMs = performance.now() - configStartedAtMs;
	const intakeStartedAtMs = performance.now();
	const { report, image, canonicalTruth } = await canonicalizeInputs(inputPaths, truth);
	const intakeMs = performance.now() - intakeStartedAtMs;
	// A sliced run gets its own deterministic directory so stale full-run
	// artifacts can never sit beside a --through receipt and masquerade as
	// part of the sliced run.
	const outDir = input.outDir
		? resolve(input.outDir)
		: resolve(
				REPO_ROOT,
				'artifacts',
				'sweep',
				loaded.resolved.name,
				input.throughGate
					? `${canonicalSweepRunName(inputPaths)}-through-${input.throughGate}`
					: canonicalSweepRunName(inputPaths)
			);
	mkdirSync(outDir, { recursive: true });
	// Runs reuse a deterministic output directory. Remove only the obsolete
	// semantic-poster directory so a previous multi-poster run cannot masquerade
	// as part of this run's single VisualRender receipt.
	rmSync(resolve(outDir, 'renders', 'features'), { recursive: true, force: true });
	const canonicalWriteStartedAtMs = performance.now();
	const canonicalPngPath = resolve(outDir, 'renders', 'input', 'g0.canonical.png');
	mkdirSync(dirname(canonicalPngPath), { recursive: true });
	const canonicalPng = new PNG({ width: image.width, height: image.height });
	canonicalPng.data.set(image.data);
	writeFileSync(canonicalPngPath, PNG.sync.write(canonicalPng));
	const canonicalWriteMs = performance.now() - canonicalWriteStartedAtMs;

	const board = createExecBoard();
	seedBoard(
		board as unknown as EvidenceBoard,
		image,
		resolveConfiguredParams(undefined, loaded.resolved)
	);
	board.set('paramsHash', plan.paramsHash ?? plan.planFingerprint);
	board.set('recoveredTees', []);
	// Every production run receives an explicit blind payload. The tainted
	// comparison payload is installed only after the detector prefix has
	// produced the IDs it records; it never mutates those slots.
	board.set('straightTestTruthAssistance', { mode: 'blind', locks: [] });
	const sink = createNodeSink(outDir);
	const traceResolved = input.throughGate
		? {
				...loaded.resolved,
				execution: [...new Set(plan.ops.map((op) => op.unit))]
			}
		: loaded.resolved;
	const { ctx, trace } = createTraceContext(traceResolved, plan.paramsHash ?? '', plan.ops, {
		imageId: report.imageId,
		canonicalFrame: 'G0 canonical detector-input pixels'
	});
	const gatewayStartedAtMs = performance.now();
	let receipts: ReturnType<typeof executeCompiledPlan> = [];
	const straightIndex = plan.ops.findIndex((operation) => operation.id === 'straightTest');
	if (truthAssisted && straightIndex < 0) {
		throw new Error(
			'lab sweep: truth-assisted Straight Test is enabled but no straightTest operation is scheduled.'
		);
	}
	if (truthAssisted && straightIndex >= 0) {
		// Run the dependency-complete detector prefix through the same gateway,
		// then issue verified canonical locks before the S0 operation itself.
		const prefix = plan.ops.slice(0, straightIndex);
		const suffix = plan.ops.slice(straightIndex);
		const prefixReceipts = executeCompiledPlan({ ...plan, ops: prefix }, board, ctx, sink);
		const teeEvidence = board.has('tees') ? board.get<readonly TeeEvidence[]>('tees') : [];
		const basketEvidence = board.has('baskets')
			? board.get<readonly BasketEvidence[]>('baskets')
			: [];
		const badgeEvidence = board.has('badges') ? board.get<readonly BadgeEvidence[]>('badges') : [];
		const decision = decideTruthScoring(report, canonicalTruth);
		if (!decision.eligible || !canonicalTruth) {
			throw new Error(
				`lab sweep: truth-assisted Straight Test refused: ${decision.reason ?? 'verified canonical truth is unavailable.'}`
			);
		}
		const assistance = buildStraightTestTruthAssistance(
			canonicalTruth,
			badgeEvidence,
			teeEvidence,
			basketEvidence,
			`verified canonical truth match (${report.truthMatch?.level ?? 'unknown'})`
		);
		if (assistance.locks.length === 0)
			throw new Error(
				'lab sweep: truth-assisted Straight Test refused: no identified badge received a verified endpoint lock.'
			);
		board.set('straightTestTruthAssistance', assistance);
		const suffixReceipts = executeCompiledPlan({ ...plan, ops: suffix }, board, ctx, sink);
		receipts = [...prefixReceipts, ...suffixReceipts];
	} else {
		receipts = executeCompiledPlan(plan, board, ctx, sink);
	}
	const gatewayMs = performance.now() - gatewayStartedAtMs;
	const operationBodyMs = receipts.reduce((sum, receipt) => sum + receipt.durationMs, 0);
	const gateByOpId = new Map(plan.ops.map((op) => [op.id, op.gate]));
	const artifactRenders: ArtifactRenderResult[] = [];
	const artifactRenderOwners: { readonly opId: string; readonly gate: string }[] = [];
	const artifactRenderStartedAtMs = performance.now();
	for (const receipt of receipts) {
		for (const artifactRef of receipt.artifacts) {
			const gate = gateByOpId.get(receipt.opId) ?? 'shared';
			artifactRenders.push(renderArtifact(outDir, receipt.opId, gate, artifactRef));
			artifactRenderOwners.push({ opId: receipt.opId, gate });
		}
	}
	const artifactRenderMs = performance.now() - artifactRenderStartedAtMs;
	const truthEvaluationStartedAtMs = performance.now();
	let scoreboard: ReturnType<typeof scoreTruth> | undefined;
	let truthScoringSkipped = false;
	let truthScoringReason: string | undefined;
	const truthDecision = decideTruthScoring(report, canonicalTruth);
	if (truth) {
		if (!truthDecision.eligible) {
			truthScoringSkipped = true;
			truthScoringReason = truthDecision.reason;
		} else {
			scoreboard = scoreTruth(board, canonicalTruth!, report.singleSourceOffset, {
				recoveryRan: plan.ops.some((operation) => operation.gate === 'G4')
			});
		}
	} else {
		// "Not attempted" is a different line from "attempted and skipped for
		// cause". Without this, the receipt reads skipped=false + no scoreboard
		// with no reason, which is exactly the silence the receipt rule forbids.
		truthScoringSkipped = true;
		truthScoringReason =
			'no truth annotation was supplied to this run; truth evaluation was not attempted';
	}
	const groundingComparisons = canonicalTruth
		? compareTruthGrounding(
				board,
				canonicalTruth,
				report.singleSourceOffset,
				truthDecision.provenanceTrusted
			)
		: [];
	const truthEvaluationMs = performance.now() - truthEvaluationStartedAtMs;
	const measurement = board.has('measurement')
		? board.get<ThreeFactorMeasurement>('measurement')
		: undefined;
	const runId = makeTraceRunId(report.imageId, plan.paramsHash ?? '', plan.planFingerprint);
	const sealedTrace = sealTrace(trace, { runId, imageId: report.imageId });
	// Scheduling is read off the sliced plan, never off board slot presence:
	// LAB itself seeds board defaults before the gateway, so a board read
	// alone cannot distinguish "ran and found nothing" from "never scheduled".
	const scheduledUnits = new Set(plan.ops.map((op) => op.unit));
	const assignmentScheduled = scheduledUnits.has('assignment');
	// The receipt's per-badge assignment listing (RunReceipt.assignments, and
	// the endpoint receipt's HOLE ASSIGNMENTS section): empty when
	// assignment.selection never ran, otherwise the exact board rows with the
	// G1-read hole label attached via the same withHoleLabels() mapping the
	// assignment.selection.table/zfit.finalAssignment.table artifacts use, so
	// no two surfaces can ever disagree on a hole.
	const assignmentRows: readonly HoleLabeledAssignment[] =
		assignmentScheduled && board.has('assignment') && board.has('measurement')
			? withHoleLabels(
					board.get<ThreeFactorAssignment>('assignment').assignments,
					board.get<ThreeFactorMeasurement>('measurement').badges
				)
			: [];
	// Canonical endpoint positions for the hole-number annotation layer: the
	// final assignment slot's own tee inventory (visible + recovered) and the
	// measurement's basket tips -- the exact objects the assignment rows name.
	const endpointPositions =
		assignmentScheduled && board.has('assignment') && board.has('measurement')
			? {
					tees: board
						.get<ThreeFactorAssignment>('assignment')
						.tees.map((tee) => ({ id: tee.detId, xPx: tee.xPx, yPx: tee.yPx })),
					baskets: board.get<ThreeFactorMeasurement>('measurement').baskets.map((basket) => ({
						id: basket.detId,
						xPx: basket.tipXPx,
						yPx: basket.tipYPx
					}))
				}
			: undefined;
	const featureRenderStartedAtMs = performance.now();
	const featureRenders = renderRunEndpointReceipt({
		run: sealedTrace,
		outDir: resolve(outDir, 'renders', 'run'),
		assignmentRows: assignmentScheduled ? assignmentRows : undefined,
		endpointPositions,
		canvas: {
			widthPx: image.width,
			heightPx: image.height,
			source: 'LAB G0 canonical raster; the exact image executed by this sweep'
		},
		...(report.singleSourceOffset
			? {
					sourceFrameOffset: {
						...report.singleSourceOffset,
						source: 'G0 CoordinateTransformLedger inverse for the single source'
					}
				}
			: {}),
		bases: [
			{
				id: 'original',
				pngPath: canonicalPngPath,
				offsetXPx: 0,
				offsetYPx: 0,
				source: 'exact G0 canonical RGBA raster seeded into the production engine'
			}
		],
		truthEvaluation: { scoreboard, groundingComparisons }
	});
	const featureRenderMs = performance.now() - featureRenderStartedAtMs;

	const acceptedByUnit = (unitId: string) =>
		sealedTrace.units
			.find((unit) => unit.id === unitId)
			?.drawables.filter((drawable) => drawable.verdict === 'accepted').length;
	// scheduledUnits: computed above (before renderRunEndpointReceipt), reused
	// here. LAB itself seeds 'recoveredTees' with [] before the gateway, so a
	// board read alone cannot distinguish "G4 ran and recovered nothing" from
	// "G4 was never in this run's plan". A count is only claimed for work
	// that was actually scheduled; everything else gets a reason instead.
	const cutoffNote = input.throughGate ? ` (--through ${input.throughGate})` : '';
	const notScheduled = (unitId: string, gate: string) =>
		`not-scheduled: no '${unitId}' operation (${gate}) is in this run's plan${cutoffNote}; ` +
		`'never ran' is a different fact from 'ran and found 0'`;

	const teeRecoveryScheduled = scheduledUnits.has('teeRecovery');
	const recoveredTees =
		teeRecoveryScheduled && board.has('recoveredTees')
			? board.get<readonly RecoveredTeeInput[]>('recoveredTees').length
			: undefined;
	const phantomEnabled = loaded.resolved.features['phantomTee']?.enabled === true;
	const phantomScheduled = scheduledUnits.has('phantomTee');
	const phantomTees = phantomScheduled ? acceptedByUnit('phantomTee') : undefined;
	const teeFamilyAccepted = acceptedByUnit('teeFamily');
	const visibleTees =
		teeFamilyAccepted ??
		(board.has('tees') ? board.get<readonly unknown[]>('tees').length : undefined);
	// assignmentScheduled/assignmentRows: computed above, reused here.
	const assignmentCount =
		assignmentScheduled && board.has('assignment')
			? board.get<ThreeFactorAssignment>('assignment').assignments.length
			: undefined;
	const rawPairsScheduled = scheduledUnits.has('rawPairs');
	const rawPairCount =
		rawPairsScheduled && board.has('rawPairs')
			? board.get<readonly RawPairEvidence[]>('rawPairs').length
			: undefined;
	const resultsProvenance = {
		badges: scheduledUnits.has('badges')
			? "accepted drawables in trace unit 'badges'"
			: notScheduled('badges', 'G1'),
		baskets: scheduledUnits.has('baskets')
			? "accepted drawables in trace unit 'baskets'"
			: notScheduled('baskets', 'G2'),
		visibleTees:
			teeFamilyAccepted !== undefined
				? "accepted drawables in trace unit 'teeFamily'"
				: visibleTees !== undefined
					? "board slot 'tees' length; trace unit 'teeFamily' absent from this run"
					: notScheduled('teeFamily', 'G3'),
		recoveredTees: teeRecoveryScheduled
			? "board slot 'recoveredTees' length after the scheduled G4 teeRecovery operation ran"
			: notScheduled('teeRecovery', 'G4'),
		phantomTees: !phantomEnabled
			? "not-enabled: feature 'phantomTee' is disabled in this config; phantom completion never ran"
			: phantomScheduled
				? "accepted drawables in trace unit 'phantomTee'"
				: notScheduled('phantomTee', 'G4'),
		totalTees:
			visibleTees !== undefined && recoveredTees !== undefined
				? 'visibleTees + recoveredTees'
				: teeRecoveryScheduled
					? 'not-computable: visibleTees is unavailable'
					: `not-computable: no 'teeRecovery' operation (G4) is in this run's plan${cutoffNote}` +
						(visibleTees !== undefined ? `; visible tees alone = ${visibleTees}` : ''),
		assignments: assignmentScheduled
			? "final board slot 'assignment' rows (includes any re-assignment written by a scheduled " +
				"post-G6 recovery/phantom operation; the 'assignment.selection.table' artifact is the " +
				'pre-recovery G6 table)'
			: notScheduled('assignment', 'G6'),
		rawPairs: rawPairsScheduled
			? "board slot 'rawPairs' length produced by the G5 rawPairs operation"
			: notScheduled('rawPairs', 'G5')
	};
	const timings: RunPhaseTimings = {
		configMs,
		intakeMs,
		canonicalWriteMs,
		gatewayMs,
		operationBodyMs,
		artifactPersistenceMs: Math.max(0, gatewayMs - operationBodyMs),
		artifactRenderMs,
		truthEvaluationMs,
		featureRenderMs,
		observedTotalMs: performance.now() - runStartedAtMs
	};
	const runRelativePath = (path: string) => relative(outDir, path).split('\\').join('/');
	// The inventory lists EVERY render file this run wrote: the canonical
	// input raster, each kind-keyed artifact render (with a truthful
	// rendered/stub status), and the feature-owned endpoint receipt. A file
	// on disk that the inventory does not name is a silent absence.
	const canonicalVisualRender: RunReceiptVisualRender = {
		kind: 'canonical',
		gate: 'G0',
		id: 'g0.canonical',
		owner: 'G0 intake (StripChrome + AutoStitch)',
		status: 'rendered',
		summary: `exact ${image.width}x${image.height} canonical raster executed by this run`,
		files: [runRelativePath(canonicalPngPath)]
	};
	const artifactVisualRenders: RunReceiptVisualRender[] = artifactRenders.map(
		(render, index): RunReceiptVisualRender => ({
			kind: 'artifact',
			gate: artifactRenderOwners[index]?.gate ?? 'shared',
			id: render.artifactRef.id,
			owner: `${render.artifactRef.kind}@${artifactRenderOwners[index]?.opId ?? 'UNKNOWN'}`,
			status: render.rendered ? 'rendered' : 'stub',
			summary: render.summary,
			files: render.filesWritten.map(runRelativePath)
		})
	);
	const visualRenders: RunReceiptVisualRender[] = [
		canonicalVisualRender,
		...artifactVisualRenders,
		...featureRenders.results.map((render): RunReceiptVisualRender => ({
			kind: 'feature',
			gate: render.gate,
			// PR #61 adds per-feature sidecar renders beside the endpoint
			// poster; only the endpoint receipt keeps the run-level id.
			id:
				render.featureId === 'endpointReceipt'
					? 'run.endpoint-summary'
					: `${render.featureId}.${render.unitId}`,
			owner: `${render.featureId}@${render.unitId}`,
			status: 'rendered',
			summary: render.summary,
			files: render.filesWritten.map(runRelativePath)
		}))
	];
	const renderWarnings = featureRenders.results.flatMap((render) =>
		render.warnings.map(
			(warning) => `visual render ${render.featureId}@${render.unitId}: ${warning}`
		)
	);
	let revision = 'UNKNOWN';
	try {
		const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
			cwd: REPO_ROOT,
			encoding: 'utf8'
		}).trim();
		const dirty = execFileSync('git', ['status', '--porcelain'], {
			cwd: REPO_ROOT,
			encoding: 'utf8'
		}).trim();
		revision = `${sha}${dirty ? '+dirty' : ''}`;
	} catch {
		// A source archive may not have Git metadata; UNKNOWN is honest provenance.
	}
	const runReceipt = buildRunReceipt({
		generatedAt: new Date().toISOString(),
		revision,
		configName: loaded.resolved.name,
		configPath,
		...(input.throughGate ? { throughGate: input.throughGate } : {}),
		...(slicedPlan ? { slice: slicedPlan.slice } : {}),
		plan,
		receipts,
		report,
		trace: sealedTrace,
		timings,
		results: {
			badges: acceptedByUnit('badges'),
			baskets: acceptedByUnit('baskets'),
			visibleTees,
			recoveredTees,
			phantomTees,
			totalTees:
				visibleTees === undefined || recoveredTees === undefined
					? undefined
					: visibleTees + recoveredTees,
			assignments: assignmentCount,
			rawPairs: rawPairCount
		},
		assignments: assignmentRows,
		resultsProvenance,
		visualRenders,
		renderWarnings,
		truthSupplied: Boolean(truthPath),
		truthScoringSkipped,
		...(truthScoringReason ? { truthScoringReason } : {}),
		...(scoreboard ? { scoreboard } : {})
	});
	// Read the previous run's receipt from this same output slot BEFORE
	// overwriting it, so the new receipt can state per-hole what changed vs
	// the previous run -- or "no change", explicitly (receipt contract item
	// 6; a flipped HOLE ASSIGNMENTS row must never be silent across runs).
	let previousReceiptRaw: unknown;
	try {
		previousReceiptRaw = JSON.parse(readFileSync(resolve(outDir, 'run.receipt.json'), 'utf8'));
	} catch {
		previousReceiptRaw = undefined;
	}
	const previousRun =
		previousReceiptRaw === undefined
			? undefined
			: compareToPreviousRun(previousReceiptRaw, runReceipt);
	const finalRunReceipt: RunReceipt = { ...runReceipt, ...(previousRun ? { previousRun } : {}) };
	const runReceiptJsonPath = writeRunReceiptJson(outDir, finalRunReceipt);
	const runReceiptTextPath = resolve(outDir, 'run.receipt.txt');
	writeFileSync(runReceiptTextPath, formatRunReceiptText(finalRunReceipt));
	const runReceiptPaths = [runReceiptJsonPath, runReceiptTextPath];
	// Chain-of-custody is observability derived from the same final assignment
	// + sealed trace every other receipt reads. When a sliced run never
	// scheduled 'assignment' (or the board slot is absent for any other
	// reason), there is nothing honest to join, so the file is skipped —
	// silently, the same way other results already distinguish "not
	// scheduled" from "ran and found nothing" without emitting a stub.
	if (assignmentScheduled && board.has('assignment')) {
		const custody: ChainOfCustodyLedger = buildChainOfCustody(
			board.get<ThreeFactorAssignment>('assignment'),
			sealedTrace
		);
		const custodyReceiptPath = resolve(outDir, 'run.custody.receipt.txt');
		writeFileSync(
			custodyReceiptPath,
			formatCustodyReceiptText(custody, canonicalSweepRunName(inputPaths))
		);
		runReceiptPaths.push(custodyReceiptPath);
	}

	return {
		configPath: loaded.path,
		configName: loaded.resolved.name,
		plan,
		receipts,
		report,
		outDir,
		artifactRenders,
		featureRenders,
		trace: sealedTrace,
		renderedCount: artifactRenders.filter((result) => result.rendered).length,
		stubbedCount: artifactRenders.filter((result) => !result.rendered).length,
		scoreboard,
		...(measurement ? { measurement } : {}),
		groundingComparisons,
		truthScoringSkipped,
		...(truthScoringReason ? { truthScoringReason } : {}),
		...(input.throughGate ? { throughGate: input.throughGate } : {}),
		runReceipt,
		runReceiptPaths
	};
}
