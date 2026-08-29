import { describe, expect, test } from 'vitest';
import {
	compileABFeatureSet,
	compileExecutionPlan,
	executeCompiledPlan,
	executeABFeatureSet,
	createExecBoard,
	type ABFeatureOperation,
	type ABFeatureSet,
	type ABFeatureSetOperation
} from '@chainspot/alg/exec';
import {
	DEFAULT_EXECUTION,
	GATE_CROSS_GATE_DEPENDENCIES,
	GATE_FEATURE_DECLARATION_DIVERGENCES,
	GATE_OPERATION_DECLARATION_DIVERGENCES,
	GATE_FEATURE_SETS,
	resolveConfig,
	type ThreeFactorConfig
} from '@chainspot/alg/detectors/threeFactor';
import defaultConfig from '@chainspot/alg/detectors/threeFactor/configs/default.json';
import { nullFeatureContext } from '@chainspot/alg/detectors/threeFactor/features/types';
import { seedBoard } from '@chainspot/alg/detectors/threeFactor/measure';
import type { EvidenceBoard } from '@chainspot/alg/detectors/threeFactor/features/types';
import type { RgbaImage } from '@chainspot/alg/detectors/threeFactor/types';
import { ALL_FEATURES } from '@chainspot/alg/detectors/threeFactor/features/registry';
import { THREE_FACTOR_SHARED_SERVICES } from '@chainspot/alg/detectors/threeFactor/shared-services';
import { OPERATION_UNIVERSE } from '@chainspot/alg/exec/operations';

const membership: Record<string, readonly string[]> = {
	'shared-set': ['hsv'],
	'g1-set': ['badges', 'digits', 'badgeGlyphTemplate'],
	'g2-set': ['sprite', 'cleanBasketFamily'],
	'g3-set': ['endpoints', 'teeFamily', 'teeMinAreaPose'],
	'g4-set': ['teeRecovery', 'phantomTee', 'teeBadgeLock', 'teeBadgeCompass'],
	'g5-set': ['fourLaneSensor', 'straightTest', 'ribbon', 'routing'],
	'g6-set': ['scoring', 'search'],
	'g7-set': ['zfit']
};

type PublicSet = ABFeatureSet & {
	/** Set-owned composition is intentionally distinct from feature declarations. */
	readonly operations?: readonly ABFeatureSetOperation[];
	readonly locallyOperationlessFeatureIds?: readonly string[];
};

function operationsOf(set: PublicSet): readonly ABFeatureOperation[] {
	if (set.operations) return set.operations.map((entry) => entry.operation);
	return set.features.flatMap((feature) => feature.operations ?? []);
}

function syntheticImage(): RgbaImage {
	const width = 32;
	const height = 32;
	const data = new Uint8ClampedArray(width * height * 4);
	for (let i = 0; i < data.length; i += 4) {
		data[i] = data[i + 1] = data[i + 2] = 128;
		data[i + 3] = 255;
	}
	return { width, height, data };
}

describe('production gate ABFeatureSet receipts', () => {
	test('public inventory is exact, ordered, and excludes parked supportRoi', () => {
		expect(Object.keys(GATE_FEATURE_SETS).sort()).toEqual(Object.keys(membership).sort());
		for (const [id, expected] of Object.entries(membership)) {
			const set = GATE_FEATURE_SETS[id as keyof typeof GATE_FEATURE_SETS] as PublicSet;
			expect(set.id).toBe(id);
			expect(set.features.map((feature) => feature.id)).toEqual(expected);
			expect(set.features.map((feature) => feature.id)).not.toContain('supportRoi');
		}
		expect(
			Object.values(GATE_FEATURE_SETS)
				.flatMap((set) => set.features.map((feature) => feature.id))
				.sort()
		).toEqual(ALL_FEATURES.map((feature) => feature.id).sort());
		expect(GATE_FEATURE_SETS['shared-set'].services?.map((service) => service.id)).toEqual([
			'occlusion'
		]);
		const ownedServiceIds = Object.values(GATE_FEATURE_SETS).flatMap((set) =>
			(set.services ?? []).map((service) => service.id)
		);
		expect(new Set(ownedServiceIds).size).toBe(ownedServiceIds.length);
		expect(ownedServiceIds.sort()).toEqual(
			THREE_FACTOR_SHARED_SERVICES.map((service) => service.id).sort()
		);
	});

	test('set composition covers each operation exactly once and preserves explicit feature reads', () => {
		const all = Object.values(GATE_FEATURE_SETS).flatMap((set) => operationsOf(set as PublicSet));
		const ids = all.map((operation) => operation.spec.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(new Set(ids)).toEqual(new Set(OPERATION_UNIVERSE.map((operation) => operation.id)));

		const byId = new Map(all.map((operation) => [operation.spec.id, operation.spec]));
		for (const spec of OPERATION_UNIVERSE) {
			expect(byId.get(spec.id)).toBeDefined();
			expect(byId.get(spec.id)?.features ?? []).toEqual(spec.features ?? []);
		}
		// These are intentionally cross-gate reads, not inferred ownership.
		expect(byId.get('tees.exclusion')?.features).toEqual(['scoring', 'endpoints', 'badges']);
		expect(byId.get('assignment.pairs')?.features).toEqual([
			'scoring',
			'search',
			'ribbon',
			'routing'
		]);
		expect(byId.get('phantomTee')?.features).toContain('zfit');
		expect(GATE_CROSS_GATE_DEPENDENCIES['tees.exclusion']).toEqual(['scoring', 'badges']);
		expect(GATE_CROSS_GATE_DEPENDENCIES['assignment.pairs']).toEqual(['ribbon', 'routing']);
		expect(GATE_CROSS_GATE_DEPENDENCIES.phantomTee).toEqual([
			'zfit',
			'scoring',
			'search',
			'ribbon',
			'routing'
		]);
		// The canonical vocabulary is shared by feature and operation
		// declarations and semantic set ownership; no aliases remain.
		expect(GATE_OPERATION_DECLARATION_DIVERGENCES).toEqual({});
		expect(GATE_FEATURE_DECLARATION_DIVERGENCES).toEqual({});
		expect(GATE_FEATURE_SETS['g4-set'].operations?.map(({ operation }) => operation.spec.id)).toEqual([
			'teeRecovery',
			'phantomTee',
			'teeBadgeLock',
			'teeBadgeCompass'
		]);
		for (const set of Object.values(GATE_FEATURE_SETS)) {
			const owned = new Set(set.features.map((feature) => feature.id));
			const crossGateReads = new Set(
				(set.operations ?? []).flatMap(({ operation }) =>
					(operation.spec.features ?? []).filter((featureId) => !owned.has(featureId))
				)
			);
			expect(new Set(set.imports ?? [])).toEqual(crossGateReads);
		}
		// These cards are locally operationless; other gates may still consume
		// their configuration through explicit imports.
		expect((GATE_FEATURE_SETS['shared-set'] as PublicSet).locallyOperationlessFeatureIds).toContain(
			'hsv'
		);
		expect((GATE_FEATURE_SETS['g7-set'] as PublicSet).locallyOperationlessFeatureIds).toBeUndefined();
		expect((GATE_FEATURE_SETS['g5-set'] as PublicSet).locallyOperationlessFeatureIds).toContain(
			'fourLaneSensor'
		);
	});

	test('each public set compiles and receipts through the production gateway', async () => {
		const defaultResolved = resolveConfig(defaultConfig as ThreeFactorConfig, DEFAULT_EXECUTION);
		const defaultPlan = compileExecutionPlan(defaultResolved);
		for (const set of Object.values(GATE_FEATURE_SETS) as PublicSet[]) {
			const composed = operationsOf(set);
			const compiled = compileABFeatureSet(set);
			expect(compiled.plan.ops.map((operation) => operation.id)).toEqual(
				composed.map((operation) => operation.spec.id)
			);
			const board = createExecBoard();
			seedBoard(board as unknown as EvidenceBoard, syntheticImage(), undefined);
			board.set('recoveredTees', []);
			executeCompiledPlan(defaultPlan, board, nullFeatureContext);
			const receipt = await executeABFeatureSet(compiled, board, nullFeatureContext, {
				runId: `receipt-${set.id}`,
				invocation: 'vitest gateFeatureSetsReceipt'
			});
			expect(receipt.operations.length).toBe(compiled.plan.ops.length);
			expect(receipt.durationMs).toBeGreaterThanOrEqual(0);
			expect(receipt.manifestHash).toMatch(/^[0-9a-f]{64}$/);
		}
		const g5 = compileABFeatureSet(GATE_FEATURE_SETS['g5-set']);
		expect(g5.plan.ops.map((operation) => operation.id)).toEqual([
			'straightTest',
			'supportField',
			'badgeOcclusionPatch',
			'rawPairs',
			'measurement'
		]);
		const g7 = compileABFeatureSet(GATE_FEATURE_SETS['g7-set'], { zfit: { enabled: true } });
		expect(g7.plan.ops.map((operation) => operation.id)).toEqual(['zfit']);
		expect(g7.enabledFeatureIds).toContain('zfit');
	});

	// 2026-08-29: teeRecovery moved before assignment (gate reorg; owner-measured
	// ray work, cd77412 lineage) -- teeRecovery now runs right after teeFamily,
	// ahead of assignment, not "ending at" it. The test title and body below
	// are updated to describe the new order.
	test('default config execution follows the canonical operation order, ending at assignment.selection', () => {
		const resolved = resolveConfig(defaultConfig as ThreeFactorConfig, DEFAULT_EXECUTION);
		// zfit left the default schedule by owner directive (2026-08-28); the
		// engine-level DEFAULT_EXECUTION fallback still ends with it.
		expect(resolved.execution).toEqual(DEFAULT_EXECUTION.filter((id) => id !== 'zfit'));
		const plan = compileExecutionPlan(resolved);
		expect(plan.ops.map((operation) => operation.id)).toEqual([
			'badgeStage.masks',
			'badgeStage.components',
			'badgeStage.family',
			'badgeStage.badges',
			'badges',
			'baskets',
			'tees.ringMeasure',
			'tees.exclusion',
			'teeFamily',
			'teeRecovery',
			'supportField',
			'badgeOcclusionPatch',
			'rawPairs',
			'measurement',
			'assignment.pairs',
			'assignment.scoring',
			'assignment.ranking',
			'assignment.selection'
		]);
	});
});
