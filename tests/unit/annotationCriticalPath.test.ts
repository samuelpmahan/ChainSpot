import { describe, expect, it } from 'vitest';
import {
	analyzeCriticalPath,
	classifyRemovableObservedWork,
	planAnnotationCriticalPath
} from '../../src/lib/autoAnnotation/annotationCriticalPath';
import {
	resolveSourceLandmarkHandoff,
	sourceLandmarkObservation,
	type SemanticLandmarkRef,
	type SourceLandmarkHandoff
} from '../../src/lib/autoAnnotation/sourceLandmarkHandoff';

const number1: SemanticLandmarkRef = { kind: 'hole-number', id: 'hole-1:number' };
const tee1: SemanticLandmarkRef = { kind: 'tee', id: 'hole-1:tee' };
const basket1: SemanticLandmarkRef = { kind: 'basket', id: 'hole-1:basket' };

function observation(landmark: SemanticLandmarkRef, sourceId = 'source-a') {
	return sourceLandmarkObservation(landmark, {
		sourceId,
		sourceCandidate: { xPx: 10, yPx: 20, score: 0.95 },
		compositePoint: { xPx: 110, yPx: 220 }
	});
}

function handoff(observed: readonly SemanticLandmarkRef[]): SourceLandmarkHandoff {
	return {
		schemaVersion: 1,
		compositeIdentity: 'fixture-composite',
		expected: [number1, tee1, basket1],
		observations: observed.map((landmark) => observation(landmark))
	};
}

describe('planAnnotationCriticalPath', () => {
	it('removes OpenCV/template prewarm from initial readiness when source numbers+baskets are complete even if pure-TS tee work remains', () => {
		const evidence = handoff([number1, basket1]);
		const resolution = resolveSourceLandmarkHandoff(evidence);
		const plan = planAnnotationCriticalPath(evidence, resolution);

		expect(plan.coverage).toEqual({ holeNumbers: true, tees: false, baskets: true });
		expect(plan.bootstrap).toBe('none');
		expect(plan.basketMode).toBe('source-complete');
		expect(plan.critical).toContain('p1-composite-object-mask');
		expect(plan.critical).toContain('tee-ownership-p3-p5');
		expect(plan.critical).not.toContain('opencv-runtime');
		expect(plan.removable).toContain('global-basket-assignment-p6');
		expect(plan.deferred).toContain('middleout-diagnostic');
	});

	it('uses named targeted basket fallback instead of restoring a global basket assignment problem', () => {
		const evidence = handoff([number1, tee1]);
		const resolution = resolveSourceLandmarkHandoff(evidence);
		const plan = planAnnotationCriticalPath(evidence, resolution);

		expect(plan.bootstrap).toBe('basket-fallback');
		expect(plan.basketMode).toBe('targeted-fallback');
		expect(plan.basketFallbackIds).toEqual(['hole-1:basket']);
		expect(plan.critical).toContain('targeted-basket-fallback');
		expect(plan.critical).not.toContain('p1-composite-object-mask');
		expect(plan.removable).toContain('global-basket-assignment-p6');
	});

	it('fails closed to global basket discovery when expected-basket completeness is unknown', () => {
		const evidence: SourceLandmarkHandoff = {
			schemaVersion: 1,
			compositeIdentity: 'fixture-composite',
			expected: [number1, tee1],
			observations: [observation(number1), observation(tee1)]
		};
		const plan = planAnnotationCriticalPath(evidence, resolveSourceLandmarkHandoff(evidence));
		expect(plan.basketMode).toBe('global-discovery');
		expect(plan.critical).toContain('global-basket-discovery');
		expect(plan.critical).toContain('global-basket-assignment-p6');
		expect(plan.removable).not.toContain('global-basket-assignment-p6');
	});

	it('can remove the entire initial course-CV worker path when all semantic landmarks are propagated', () => {
		const evidence = handoff([number1, tee1, basket1]);
		const resolution = resolveSourceLandmarkHandoff(evidence);
		const plan = planAnnotationCriticalPath(evidence, resolution);

		expect(plan.bootstrap).toBe('none');
		expect(plan.critical).toEqual(['course-grammar']);
		expect(plan.removable).toEqual(expect.arrayContaining([
			'opencv-runtime',
			'number-templates',
			'basket-template',
			'p1-composite-object-mask',
			'p2-number-labeling',
			'ribbon-segmentation',
			'tee-ownership-p3-p5',
			'global-basket-discovery',
			'global-basket-assignment-p6'
		]));
	});

	it('fails closed if handoff and resolution belong to different composites', () => {
		const evidence = handoff([number1, basket1]);
		const resolution = { ...resolveSourceLandmarkHandoff(evidence), compositeIdentity: 'other' };
		expect(() => planAnnotationCriticalPath(evidence, resolution)).toThrow(/different|resolution is for/);
	});
});

describe('analyzeCriticalPath', () => {
	it('models independent source landmark work and render work as concurrent instead of summing them', () => {
		const result = analyzeCriticalPath([
			{ id: 'decode', durationMs: 10 },
			{ id: 'semantic-local-verify', durationMs: 15, dependsOn: ['decode'] },
			{ id: 'source-landmarks', durationMs: 40, dependsOn: ['decode'] },
			{ id: 'render-composite', durationMs: 20, dependsOn: ['semantic-local-verify'] },
			{ id: 'fuse-landmarks', durationMs: 3, dependsOn: ['semantic-local-verify', 'source-landmarks'] },
			{ id: 'annotate-ready', durationMs: 0, dependsOn: ['render-composite', 'fuse-landmarks'] }
		]);
		expect(result.totalMs).toBe(53);
		// The zero-duration sink ties its slowest dependency, so the analyzer's
		// representative critical path ends at the last positive-duration stage.
		expect(result.path).toEqual(['decode', 'source-landmarks', 'fuse-landmarks']);
		expect(result.finishMsByStage['annotate-ready']).toBe(53);
	});

	it('detects invalid timing DAGs instead of producing plausible garbage', () => {
		expect(() => analyzeCriticalPath([
			{ id: 'a', durationMs: 1, dependsOn: ['b'] },
			{ id: 'b', durationMs: 1, dependsOn: ['a'] }
		])).toThrow(/cycle/);
	});
});

describe('classifyRemovableObservedWork', () => {
	it('keeps wall-clock claims separate from fully deleted measured work', () => {
		const evidence = handoff([number1, basket1]);
		const plan = planAnnotationCriticalPath(evidence, resolveSourceLandmarkHandoff(evidence));
		const removable = classifyRemovableObservedWork(plan, {
			bootstrapMs: 120,
			p1MaskMs: 80,
			p2BadgeLabelMs: 30,
			ribbonSegmentationMs: 50,
			p3Ms: 10,
			p4Ms: 20,
			p5Ms: 5,
			p6Ms: 45,
			middleOutMs: 70,
			basketCandidatesMs: 25
		});

		// Source number+basket completeness deletes bootstrap, P2, P6 and
		// MiddleOut from readiness. P1/P3/P4/P5 stay because tee work remains;
		// basket work embedded inside them is deliberately not guessed at.
		expect(removable.fullyRemovableWorkMs).toBe(290);
		expect(removable.stages.map((stage) => stage.id)).toEqual([
			'bootstrap',
			'p2-number-labeling',
			'p6-global-basket-assignment',
			'middleout-diagnostic',
			'basket-candidates'
		]);
		expect(removable.unmeasuredEmbeddedWork).toHaveLength(1);
	});
});
