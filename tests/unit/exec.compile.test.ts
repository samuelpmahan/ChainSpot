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
import { DEFAULT_EXECUTION, resolveConfig, type ThreeFactorConfig } from '@chainspot/alg/detectors/threeFactor';
import { CONFIG_SCHEMA } from '@chainspot/alg/detectors/threeFactor/config';
import defaultConfigJson from '@chainspot/alg/detectors/threeFactor/configs/default.json';
import familyOnConfigJson from '@chainspot/alg/detectors/threeFactor/configs/family-on.json';

const defaultResolved = resolveConfig(defaultConfigJson as ThreeFactorConfig, DEFAULT_EXECUTION);
const familyOnResolved = resolveConfig(familyOnConfigJson as ThreeFactorConfig, DEFAULT_EXECUTION);

describe('operation universe (R2 inventory)', () => {
	test('every unit decomposes into at least one operation, three units decompose further', () => {
		expect(UNIT_OPERATIONS.size).toBe(12); // the 12 legacy EngineUnits
		expect(OPERATION_UNIVERSE.length).toBe(19); // 9 x 1-op units + badgeStage(4) + visible tees(2) + assignment(4)
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

	test('paramsHash rides alongside untouched, never derived by compile', () => {
		const plan: CompiledExecutionPlan = compileExecutionPlan(defaultResolved, 'caller-supplied-hash');
		expect(plan.paramsHash).toBe('caller-supplied-hash');
	});
});

describe('compileExecutionPlan — illegal order is REJECTED, naming the violated dependency', () => {
	test('assignment before badgeStage throws naming the missing slot', () => {
		const illegalExecution = ['assignment', ...DEFAULT_EXECUTION.filter((id) => id !== 'assignment')];
		const illegalConfig: ThreeFactorConfig = {
			schema: CONFIG_SCHEMA,
			name: 'illegal-order-demo',
			execution: illegalExecution,
			gates: {}
		};
		const resolved = resolveConfig(illegalConfig, DEFAULT_EXECUTION);
		expect(() => compileExecutionPlan(resolved)).toThrow(/assignment\.pairs.*consumes 'measurement'.*no earlier operation produces it/s);
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
			{ schema: CONFIG_SCHEMA, name: 'dup-unit', execution: [...DEFAULT_EXECUTION, 'badgeStage'], gates: {} },
			DEFAULT_EXECUTION
		);
		expect(() => compileExecutionPlan(resolved)).toThrow(/lists unit 'badgeStage' twice/);
	});
});
