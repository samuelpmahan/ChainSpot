/**
 * Annotation readiness dependency planner + timing harness (CHSPT-80).
 *
 * This module deliberately models the *target* critical path instead of the
 * historical `detect-course` worker request. Today that request is a
 * monolith: it eagerly bootstraps OpenCV + all templates, runs P1→P6, and
 * also runs MiddleOut diagnostics before replying. Source landmark evidence
 * makes several of those steps unnecessary, and keeping the old request as
 * the unit of scheduling would hide that fact.
 *
 * Inputs are CHSPT-79's explicit expected-landmark handoff/resolution plan.
 * No transform logic lives here. The output tells a caller which initial
 * annotation work is still semantically required, which worker assets still
 * deserve prewarming, and what can leave the user-visible critical path.
 */
import {
	canSkipCompositeDetector,
	type SourceLandmarkHandoff,
	type SourceLandmarkResolutionPlan
} from './sourceLandmarkHandoff';

export type AnnotationCriticalWork =
	| 'opencv-runtime'
	| 'number-templates'
	| 'basket-template'
	| 'p1-composite-object-mask'
	| 'p2-number-labeling'
	| 'ribbon-segmentation'
	| 'tee-ownership-p3-p5'
	| 'targeted-basket-fallback'
	| 'global-basket-discovery'
	| 'global-basket-assignment-p6'
	| 'course-grammar';

export type AnnotationDeferredWork = 'middleout-diagnostic' | 'local-snap' | 'corridor-bend-detection';

export type CourseCvBootstrapMode = 'none' | 'number-only' | 'basket-fallback' | 'number-and-basket';
export type BasketResolutionMode = 'source-complete' | 'targeted-fallback' | 'global-discovery';

export interface SourceLandmarkCoverage {
	readonly holeNumbers: boolean;
	readonly tees: boolean;
	readonly baskets: boolean;
}

export interface AnnotationCriticalPathPlan {
	readonly coverage: SourceLandmarkCoverage;
	/** Work required before the initial map can be populated/reviewed. */
	readonly critical: readonly AnnotationCriticalWork[];
	/** Work that should not delay initial annotation readiness. */
	readonly deferred: readonly AnnotationDeferredWork[];
	/** Whole historical work units that the target path can delete. */
	readonly removable: readonly AnnotationCriticalWork[];
	/**
	 * Whether the historical OpenCV/template worker needs speculative warm-up.
	 * `none` means `prewarmBasketDetection` should not run on the readiness path.
	 */
	readonly bootstrap: CourseCvBootstrapMode;
	readonly basketMode: BasketResolutionMode;
	/** Named unresolved baskets to search locally instead of globally assigning a new basket set. */
	readonly basketFallbackIds: readonly string[];
	/** Current-code seams that must be split/injected to realize this target plan. */
	readonly integrationGaps: readonly string[];
}

function completeKind(
	handoff: SourceLandmarkHandoff,
	plan: SourceLandmarkResolutionPlan,
	kind: 'hole-number' | 'tee' | 'basket'
): boolean {
	return canSkipCompositeDetector(handoff, plan, kind);
}

function addUnique<T>(values: T[], value: T): void {
	if (!values.includes(value)) values.push(value);
}

/**
 * Derives the smallest initial annotation CV plan supported by the evidence.
 *
 * Key policy decisions:
 * - named source baskets replace global basket detection + P6 assignment;
 * - a missing *named* basket gets a targeted fallback, not a new global scan;
 * - unknown expected-basket completeness fails closed to global discovery;
 * - P1/P3/P4/P5 remain only while tee evidence is incomplete (or P1/P6 are
 *   needed for fail-closed global basket discovery);
 * - OpenCV/template bootstrap remains only for unresolved number labeling or
 *   targeted basket template fallback. P1/ribbon/ownership are pure-TS work;
 * - MiddleOut is diagnostic and local snap/corridor bends are interactive or
 *   post-population work, so none blocks initial Annotate Course readiness.
 */
export function planAnnotationCriticalPath(
	handoff: SourceLandmarkHandoff,
	resolution: SourceLandmarkResolutionPlan
): AnnotationCriticalPathPlan {
	if (handoff.compositeIdentity !== resolution.compositeIdentity) {
		throw new Error(
			`planAnnotationCriticalPath: landmark evidence is for ${handoff.compositeIdentity}, resolution is for ${resolution.compositeIdentity}`
		);
	}

	const coverage: SourceLandmarkCoverage = {
		holeNumbers: completeKind(handoff, resolution, 'hole-number'),
		tees: completeKind(handoff, resolution, 'tee'),
		baskets: completeKind(handoff, resolution, 'basket')
	};
	const expectedBasketIds = handoff.expected
		.filter((landmark) => landmark.kind === 'basket')
		.map((landmark) => landmark.id);
	const basketFallbackIds = resolution.fallback
		.filter((item) => item.landmark.kind === 'basket')
		.map((item) => item.landmark.id);
	const basketMode: BasketResolutionMode = coverage.baskets
		? 'source-complete'
		: expectedBasketIds.length > 0
			? 'targeted-fallback'
			: 'global-discovery';

	const critical: AnnotationCriticalWork[] = [];
	const removable: AnnotationCriticalWork[] = [];
	const integrationGaps: string[] = [];

	const needsNumberCv = !coverage.holeNumbers;
	const needsTeeCv = !coverage.tees;
	const needsTargetedBasketFallback = basketMode === 'targeted-fallback';
	const needsGlobalBasketDiscovery = basketMode === 'global-discovery';

	let bootstrap: CourseCvBootstrapMode = 'none';
	if (needsNumberCv && needsTargetedBasketFallback) bootstrap = 'number-and-basket';
	else if (needsNumberCv) bootstrap = 'number-only';
	else if (needsTargetedBasketFallback) bootstrap = 'basket-fallback';

	if (bootstrap !== 'none') addUnique(critical, 'opencv-runtime');
	else addUnique(removable, 'opencv-runtime');

	if (needsNumberCv) {
		addUnique(critical, 'number-templates');
		addUnique(critical, 'p2-number-labeling');
	} else {
		addUnique(removable, 'number-templates');
		addUnique(removable, 'p2-number-labeling');
	}

	if (needsTargetedBasketFallback) {
		addUnique(critical, 'basket-template');
		addUnique(critical, 'targeted-basket-fallback');
	} else {
		addUnique(removable, 'basket-template');
		addUnique(removable, 'targeted-basket-fallback');
	}

	if (needsGlobalBasketDiscovery) {
		addUnique(critical, 'global-basket-discovery');
		addUnique(critical, 'global-basket-assignment-p6');
	} else {
		addUnique(removable, 'global-basket-discovery');
		addUnique(removable, 'global-basket-assignment-p6');
	}

	// P1 is still the current tee/global-basket candidate generator. Its
	// badge/basket materialization is internally coupled today; when source
	// landmarks are complete, the remaining P1 purpose is tee localization
	// only and that internal coupling is an integration gap rather than a
	// reason to treat composite baskets as fresh semantic evidence.
	if (needsTeeCv || needsGlobalBasketDiscovery) addUnique(critical, 'p1-composite-object-mask');
	else addUnique(removable, 'p1-composite-object-mask');

	if (needsTeeCv) addUnique(critical, 'tee-ownership-p3-p5');
	else addUnique(removable, 'tee-ownership-p3-p5');

	// Ribbon evidence is useful for unresolved tee ownership and today's
	// global P6 fallback, but not for a named targeted basket search.
	if (needsTeeCv || needsGlobalBasketDiscovery) addUnique(critical, 'ribbon-segmentation');
	else addUnique(removable, 'ribbon-segmentation');

	addUnique(critical, 'course-grammar');

	if ((needsTeeCv || needsGlobalBasketDiscovery) && (coverage.holeNumbers || coverage.baskets || coverage.tees)) {
		integrationGaps.push(
			'P1 currently localizes badges/baskets/tees together; inject propagated source landmarks as scale/ownership evidence so incidental P1 components are not treated as fresh semantic detections.'
		);
	}
	if (bootstrap !== 'number-and-basket') {
		integrationGaps.push(
			'The current worker prewarm loads OpenCV plus the complete number and basket template pack as one unit; split bootstrap assets so only residual dependencies are loaded.'
		);
	}
	if (coverage.baskets || needsTargetedBasketFallback) {
		integrationGaps.push(
			'Current P3/P4/P6 consume composite raw-mask baskets; inject CHSPT-79 fused named baskets and bypass basket-membership/P6 assignment for resolved or named-fallback holes.'
		);
	}
	if (bootstrap === 'none') {
		integrationGaps.push(
			'AnnotationWorkspace currently calls prewarmBasketDetection and monolithic detectCourseCandidates for every source image; gate/remove both when the residual plan is pure TypeScript.'
		);
	}

	return {
		coverage,
		critical,
		deferred: ['middleout-diagnostic', 'local-snap', 'corridor-bend-detection'],
		removable,
		bootstrap,
		basketMode,
		basketFallbackIds,
		integrationGaps
	};
}

// ---------------------------------------------------------------------------
// Timing / concurrency harness
// ---------------------------------------------------------------------------

export interface TimedStage {
	readonly id: string;
	readonly durationMs: number;
	readonly dependsOn?: readonly string[];
	readonly enabled?: boolean;
}

export interface CriticalPathResult {
	readonly totalMs: number;
	readonly path: readonly string[];
	readonly finishMsByStage: Readonly<Record<string, number>>;
}

/**
 * Computes wall-clock critical path for a dependency DAG. Independent stages
 * overlap by construction; this intentionally does NOT sum all work.
 */
export function analyzeCriticalPath(stages: readonly TimedStage[]): CriticalPathResult {
	const byId = new Map<string, TimedStage>();
	for (const stage of stages) {
		if (!stage.id) throw new Error('analyzeCriticalPath: stage id must be non-empty');
		if (byId.has(stage.id)) throw new Error(`analyzeCriticalPath: duplicate stage ${stage.id}`);
		if (!Number.isFinite(stage.durationMs) || stage.durationMs < 0) {
			throw new Error(`analyzeCriticalPath: ${stage.id} duration must be >= 0`);
		}
		byId.set(stage.id, stage);
	}

	const visiting = new Set<string>();
	const memo = new Map<string, { finishMs: number; path: string[] }>();
	function finish(id: string): { finishMs: number; path: string[] } {
		const cached = memo.get(id);
		if (cached) return cached;
		const stage = byId.get(id);
		if (!stage) throw new Error(`analyzeCriticalPath: unknown dependency ${id}`);
		if (stage.enabled === false) {
			const skipped = { finishMs: 0, path: [] as string[] };
			memo.set(id, skipped);
			return skipped;
		}
		if (visiting.has(id)) throw new Error(`analyzeCriticalPath: dependency cycle at ${id}`);
		visiting.add(id);

		let slowestDependency = { finishMs: 0, path: [] as string[] };
		for (const dependencyId of stage.dependsOn ?? []) {
			if (!byId.has(dependencyId)) {
				throw new Error(`analyzeCriticalPath: ${id} depends on unknown stage ${dependencyId}`);
			}
			const candidate = finish(dependencyId);
			if (candidate.finishMs > slowestDependency.finishMs) slowestDependency = candidate;
		}
		visiting.delete(id);
		const result = {
			finishMs: slowestDependency.finishMs + stage.durationMs,
			path: [...slowestDependency.path, id]
		};
		memo.set(id, result);
		return result;
	}

	let critical = { finishMs: 0, path: [] as string[] };
	for (const stage of stages) {
		const candidate = finish(stage.id);
		if (candidate.finishMs > critical.finishMs) critical = candidate;
	}
	const finishMsByStage: Record<string, number> = {};
	for (const [id, result] of memo) finishMsByStage[id] = result.finishMs;
	return { totalMs: critical.finishMs, path: critical.path, finishMsByStage };
}

/** Structural subset of the worker's CourseDetectionPerformance.stages. */
export interface ObservedCourseStageTimes {
	readonly bootstrapMs?: number;
	readonly p1MaskMs?: number;
	readonly p2BadgeLabelMs?: number;
	readonly ribbonSegmentationMs?: number;
	readonly p3Ms?: number;
	readonly p4Ms?: number;
	readonly p5Ms?: number;
	readonly p6Ms?: number;
	/** Runtime worker report currently carries this even though the main-thread public type does not. */
	readonly middleOutMs?: number;
	readonly basketRasterMs?: number;
	readonly basketAnchorMs?: number;
	readonly basketCandidatesMs?: number;
	readonly basketFallbackMs?: number;
	readonly teeRasterMs?: number;
	readonly teeDetectionMs?: number;
}

export interface RemovableObservedWork {
	/** Sum of whole measured stages that disappear; NOT a wall-clock speedup claim. */
	readonly fullyRemovableWorkMs: number;
	readonly stages: readonly { readonly id: string; readonly durationMs: number }[];
	/** Mixed stages containing avoidable basket work that cannot be timed separately with today's instrumentation. */
	readonly unmeasuredEmbeddedWork: readonly string[];
}

function measured(value: number | undefined): number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Classifies an observed worker timing snapshot against a target plan. This
 * reports deleted CPU/work, not latency: use `analyzeCriticalPath` with the
 * real cross-stage DAG to measure wall-clock after concurrency is introduced.
 */
export function classifyRemovableObservedWork(
	plan: AnnotationCriticalPathPlan,
	timing: ObservedCourseStageTimes
): RemovableObservedWork {
	const stages: { id: string; durationMs: number }[] = [];
	const add = (id: string, durationMs: number | undefined) => {
		const duration = measured(durationMs);
		if (duration > 0) stages.push({ id, durationMs: duration });
	};

	if (plan.bootstrap === 'none') add('bootstrap', timing.bootstrapMs);
	if (plan.coverage.holeNumbers) add('p2-number-labeling', timing.p2BadgeLabelMs);
	if (plan.coverage.tees) {
		add('p1-object-mask', timing.p1MaskMs);
		add('ribbon-segmentation', timing.ribbonSegmentationMs);
		add('p3', timing.p3Ms);
		add('p4', timing.p4Ms);
		add('p5', timing.p5Ms);
		add('tee-raster', timing.teeRasterMs);
		add('tee-detection', timing.teeDetectionMs);
	}
	if (plan.basketMode !== 'global-discovery') add('p6-global-basket-assignment', timing.p6Ms);
	// Diagnostics should never block first useful annotation state.
	add('middleout-diagnostic', timing.middleOutMs);
	if (plan.coverage.baskets) {
		add('basket-raster', timing.basketRasterMs);
		add('basket-anchor', timing.basketAnchorMs);
		add('basket-candidates', timing.basketCandidatesMs);
		add('basket-occlusion-fallback', timing.basketFallbackMs);
	}

	const unmeasuredEmbeddedWork: string[] = [];
	if (plan.coverage.baskets && !plan.coverage.tees) {
		unmeasuredEmbeddedWork.push(
			'P1/P3/P4 currently mix tee and basket responsibilities; basket-only work inside those stages needs finer instrumentation before assigning a millisecond saving.'
		);
	}

	return {
		fullyRemovableWorkMs: stages.reduce((sum, stage) => sum + stage.durationMs, 0),
		stages,
		unmeasuredEmbeddedWork
	};
}
