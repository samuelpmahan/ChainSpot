// CHSPT-82 Wave 1A — compileExecutionPlan unit coverage:
//   - op inventory shape (R2's defense: real decomposition, not 11
//     relabeled units)
//   - C1 ordering semantics (default vs family-on produce different,
//     deterministic plans)
//   - an illegal-order config is REJECTED, naming the violated dependency
//
// Deliberately does not re-run the parity pin or the dev72 sweeps (those
// stay exactly where they already live); this file is scoped to the
// compiler itself.

import { describe, expect, test } from 'vitest';
import {
	OPERATION_UNIVERSE,
	UNIT_OPERATIONS,
	compileExecutionPlan,
	type CompiledExecutionPlan
} from '@chainspot/alg/exec';
import {
	DEFAULT_EXECUTION,
	resolveConfig,
	type ThreeFactorConfig
} from '@chainspot/alg/detectors/threeFactor';
import { CONFIG_SCHEMA } from '@chainspot/alg/detectors/threeFactor/config';
import defaultConfigJson from '@chainspot/alg/detectors/threeFactor/configs/default.json';
import familyOnConfigJson from '@chainspot/alg/detectors/threeFactor/configs/family-on.json';
import straightTestOnConfigJson from '@chainspot/alg/detectors/threeFactor/configs/straight-test-on.json';

const defaultResolved = resolveConfig(defaultConfigJson as ThreeFactorConfig, DEFAULT_EXECUTION);
const familyOnResolved = resolveConfig(familyOnConfigJson as ThreeFactorConfig, DEFAULT_EXECUTION);
const straightTestOnResolved = resolveConfig(
	straightTestOnConfigJson as ThreeFactorConfig,
	DEFAULT_EXECUTION
);
// 2026-08-28: two deliberate baseline evolutions meet in this pin. zfit was
// dropped from the default schedule by owner directive (the 19-operation
// fingerprint was fdff6359...; the zfit-free one was 1bd2666c...), and
// teeRecovery now republishes its final assignment tee/route inventory for
// downstream G7 custody (PR #61). The default-OFF straightTest,
// teeMinAreaPose, and teeBadgeLock operations remain excluded from this
// fingerprint until explicitly configured. 2026-08-28: teeRecovery's new
// axisToleranceDeg knob (soft ceiling, default 3 -- the strict target itself:
// see g3.teeRecovery.ts for the null-result empirical finding on the
// post-dc96000 corpus) moves this pin again. 2026-08-28: phantomTee's
// maxCompletions knob (owner one-hole budget) moves it once more. 2026-08-28:
// the G1 OCR fix contract (docs/seven-whys/g1-badge-digit-garbage.md) adds
// g1.badges' plateFrameTolerancePx (C1 frame-exclusion provenance) and
// g1.digits' confidenceFloorDivisor/labelAmbiguityMargin (C4 derived-floor/
// ambiguity provenance) -- new knobs move this pin again, consciously.
// 2026-08-29: the badgeGlyphTemplate ABFeature lands (docs/CLAIMS-LEDGER.md
// row 23's whole-glyph Dice-template classifier, ported into a default-OFF
// G1 ABFeature per the owner's "put the thing in an ABFeature and test it"
// directive) -- it is a NEW default-OFF single-operation unit, so
// UNIT_OPERATIONS/OPERATION_UNIVERSE counts move (17->18, 24->25), but it is
// absent from default.json's execution list (same "absence, not merely
// disabled" contract as teeMinAreaPose/teeBadgeLock), so the FROZEN default
// plan fingerprint itself does NOT move and is intentionally left unchanged
// below -- verified by re-running this suite after the change.
// 2026-08-29: teeRecovery moved before assignment (gate reorg; owner-measured
// ray work, cd77412 lineage) -- teeRecovery's G5/G6 dependency on assignment
// output is removed, and it now runs right after teeFamily in
// DEFAULT_EXECUTION instead of just before zfit. The compiled plan's op
// order changes, moving this pin again (1649c2b1... -> 0ceb1ed0...).
// 2026-08-29: a concurrent sibling lane's phantomTee whitelist knob
// (owner-curated hole whitelist for phantom injection) landed on this branch
// (merge 8fdf6cf) while this file was being updated for the teeRecovery
// reorder above -- unrelated to this task's own change, but it moves the
// operation universe's fingerprint content again (0ceb1ed0... -> f3e705aa...).
const FROZEN_DEFAULT_PLAN_FINGERPRINT =
	'f3e705aa36d9ba7c8f25a7e4e0e36b7dd3a99f0b77be611c9b5faf096b039659';

describe('operation universe (R2 inventory)', () => {
	test('every unit decomposes into at least one operation, three units decompose further', () => {
		expect(UNIT_OPERATIONS.size).toBe(18); // prior inventory + straightTest + teeMinAreaPose + teeBadgeLock + badgeGlyphTemplate
		expect(OPERATION_UNIVERSE.length).toBe(25); // prior universe + four single-operation units
		expect(UNIT_OPERATIONS.get('badgeStage')).toEqual([
			'badgeStage.masks',
			'badgeStage.components',
			'badgeStage.family',
			'badgeStage.badges'
		]);
		expect(UNIT_OPERATIONS.get('tees')).toEqual(['tees.ringMeasure', 'tees.exclusion']);
		expect(UNIT_OPERATIONS.get('assignment')).toEqual([
			'assignment.pairs',
			'assignment.scoring',
			'assignment.ranking',
			'assignment.selection'
		]);
		expect(UNIT_OPERATIONS.get('zfit')).toEqual(['zfit']);
		expect(UNIT_OPERATIONS.get('straightTest')).toEqual(['straightTest']);
	});

	test('all five OperationKinds are represented', () => {
		const kinds = new Set(OPERATION_UNIVERSE.map((op) => op.kind));
		expect([...kinds].sort()).toEqual(['compute', 'decide', 'materialize', 'measure', 'transform']);
	});

	test('every operation id is unique', () => {
		const ids = OPERATION_UNIVERSE.map((op) => op.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});

describe('compileExecutionPlan — C1 ordering', () => {
	test('default.json compiles visible tee family after ring detection', () => {
		const plan = compileExecutionPlan(defaultResolved);
		expect(plan.ops.map((op) => op.id).slice(0, 4)).toEqual([
			'badgeStage.masks',
			'badgeStage.components',
			'badgeStage.family',
			'badgeStage.badges'
		]);
		expect(plan.ops.map((op) => op.id)).not.toContain('cleanBasketFamily');
		expect(plan.ops.map((op) => op.id)).toContain('teeFamily');
	});

	test('family-on.json differs by inserting cleanBasketFamily while retaining baseline teeFamily', () => {
		const plan = compileExecutionPlan(familyOnResolved);
		const ids = plan.ops.map((op) => op.id);
		expect(ids).toContain('cleanBasketFamily');
		expect(ids).toContain('teeFamily');
		expect(plan.ops.length).toBeGreaterThan(compileExecutionPlan(defaultResolved).ops.length);
	});

	test('planFingerprint is deterministic and differs between default and family-on', () => {
		const a = compileExecutionPlan(defaultResolved);
		const b = compileExecutionPlan(defaultResolved);
		const c = compileExecutionPlan(familyOnResolved);
		expect(a.planFingerprint).toBe(b.planFingerprint);
		expect(a.planFingerprint).not.toBe(c.planFingerprint);
		expect(a.planFingerprint).toMatch(/^[0-9a-f]{64}$/);
	});

	test('an unconfigured resolve-only default-OFF feature cannot perturb the frozen default plan fingerprint', () => {
		const baseline = compileExecutionPlan(defaultResolved);
		expect(baseline.planFingerprint).toBe(FROZEN_DEFAULT_PLAN_FINGERPRINT);

		const onA = compileExecutionPlan(straightTestOnResolved);
		const onB = compileExecutionPlan(straightTestOnResolved);
		expect(onA.planFingerprint).toBe(onB.planFingerprint);
		expect(onA.planFingerprint).not.toBe(baseline.planFingerprint);
		expect(onA.ops.map((operation) => operation.id)).toContain('straightTest');
	});

	test('paramsHash rides alongside untouched, never derived by compile', () => {
		const plan: CompiledExecutionPlan = compileExecutionPlan(
			defaultResolved,
			'caller-supplied-hash'
		);
		expect(plan.paramsHash).toBe('caller-supplied-hash');
	});
});

describe('compileExecutionPlan — illegal order is REJECTED, naming the violated dependency', () => {
	test('assignment before badgeStage throws naming the missing slot', () => {
		const illegalExecution = [
			'assignment',
			...DEFAULT_EXECUTION.filter((id) => id !== 'assignment')
		];
		const illegalConfig: ThreeFactorConfig = {
			schema: CONFIG_SCHEMA,
			name: 'illegal-order-demo',
			execution: illegalExecution,
			gates: {}
		};
		const resolved = resolveConfig(illegalConfig, DEFAULT_EXECUTION);
		expect(() => compileExecutionPlan(resolved)).toThrow(
			/assignment\.pairs.*consumes 'measurement'.*no earlier operation produces it/s
		);
	});

	test('an unknown unit id throws', () => {
		const resolved = resolveConfig(
			{ schema: CONFIG_SCHEMA, name: 'unknown-unit', execution: ['nope'], gates: {} },
			DEFAULT_EXECUTION
		);
		expect(() => compileExecutionPlan(resolved)).toThrow(/unknown unit 'nope'/);
	});

	test('a duplicated unit id throws', () => {
		const resolved = resolveConfig(
			{
				schema: CONFIG_SCHEMA,
				name: 'dup-unit',
				execution: [...DEFAULT_EXECUTION, 'badgeStage'],
				gates: {}
			},
			DEFAULT_EXECUTION
		);
		expect(() => compileExecutionPlan(resolved)).toThrow(/lists unit 'badgeStage' twice/);
	});
});
