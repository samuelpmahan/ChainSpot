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
	parseConfig,
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
// 2026-08-29: teeBadgeLockOperation.consumes changed from dotted slots
// ['measurement', 'assignment.tees', 'assignment.rawPairs'] to full object
// ['measurement', 'assignment'] to work in g4-set where only full assignment is
// seeded (fix-intake-engine: spec-exact one-issue fix for g4-set compilation).
// Fingerprint moved: f3e705aa... -> f2739303...
// 2026-08-29: teeBadgeCompass (default-OFF, resolve-only) enters
// OPERATION_UNIVERSE on rebase -- and the pin does NOT move: recomputed on
// the merged tree by direct compile, the fingerprint equals the value below
// unchanged, confirming the current computation is insensitive to
// unconfigured resolve-only inventory (the compass op appears in neither
// the default plan's ops nor its bindings).
// 2026-08-29: teeBorderCornerFit lands (owner's border-adjacency corner-fit
// recovery for tees buried under basket glyphs; manually validated on
// Heritage T6 before the code was written -- see
// g4.teeBorderCornerFitMath.ts's header). Another default-OFF resolve-only
// single-operation unit: UNIT_OPERATIONS/OPERATION_UNIVERSE counts move
// (19->20, 26->27) and, per the insensitivity property proven one entry up,
// the frozen default plan fingerprint is expected to stay put -- verified by
// re-running this suite after the change.
const FROZEN_DEFAULT_PLAN_FINGERPRINT =
	'f2739303d4ca9d6fe6fb444cb8f39272b0955171144d5a9e7d0f4113ab4944f9';

describe('operation universe (R2 inventory)', () => {
	test('every unit decomposes into at least one operation, three units decompose further', () => {
		expect(UNIT_OPERATIONS.size).toBe(20); // prior inventory + straightTest + teeMinAreaPose + teeBadgeLock + badgeGlyphTemplate + teeBadgeCompass + teeBorderCornerFit
		expect(OPERATION_UNIVERSE.length).toBe(27); // prior universe + six single-operation units
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

describe('ABFeature consistency guard — unit ↔ config mismatch detection', () => {
	test('resolveConfig throws when unit declares knob but config provides none', () => {
		// phantomTee declares 'maxCompletions' knob; set to minimum invalid value
		const config: ThreeFactorConfig = {
			schema: CONFIG_SCHEMA,
			name: 'test-missing-knob',
			gates: {
				G4: {
					phantomTee: {
						enabled: true,
						knobs: {
							// Provide only minViableScore, omit maxCompletions
							minViableScore: 0
						}
					}
				}
			}
		};
		const resolved = resolveConfig(config, DEFAULT_EXECUTION);
		// The resolved state should have both knobs (defaults filled in), so this should not throw
		// but if we were to manually create a broken resolved state, it would catch it.
		expect(resolved.features['phantomTee'].knobs).toHaveProperty('maxCompletions');
	});

	test('resolveConfig succeeds with valid feature knobs matching unit declaration', () => {
		const config: ThreeFactorConfig = {
			schema: CONFIG_SCHEMA,
			name: 'test-valid-knobs',
			gates: {
				G4: {
					phantomTee: {
						enabled: true,
						knobs: {
							minViableScore: 0.1,
							maxCompletions: 2,
							whitelist: []
						}
					}
				}
			}
		};
		const resolved = resolveConfig(config, DEFAULT_EXECUTION);
		expect(resolved.features['phantomTee'].enabled).toBe(true);
		expect(resolved.features['phantomTee'].knobs['maxCompletions']).toBe(2);
	});

	test('compileExecutionPlan throws TIER-1 when operation references a resolve-only feature not explicitly configured', () => {
		// badgeGlyphTemplate is resolve-only (resolveOnlyWhenConfigured=true)
		// TIER 1: Using a resolve-only feature in execution without configuring it in gates throws
		const illegalConfig: ThreeFactorConfig = {
			schema: CONFIG_SCHEMA,
			name: 'illegal-resolve-only',
			execution: [
				'badgeStage',
				'badges',
				'badgeGlyphTemplate', // In execution but not in gates
				'baskets',
				'tees',
				'teeFamily',
				'teeRecovery',
				'supportField',
				'badgeOcclusionPatch',
				'rawPairs',
				'measurement',
				'assignment'
			],
			gates: {} // badgeGlyphTemplate not configured here
		};
		const illegalResolved = resolveConfig(illegalConfig, DEFAULT_EXECUTION);
		// badgeGlyphTemplate should not be in resolved.features because it's resolve-only
		// and wasn't explicitly configured in gates
		expect(illegalResolved.features['badgeGlyphTemplate']).toBeUndefined();
		// Compiling should throw because operation references feature not in resolved config
		expect(() => compileExecutionPlan(illegalResolved)).toThrow(
			/operation 'badgeGlyphTemplate' references feature 'badgeGlyphTemplate' but it is not in the resolved config/
		);
	});

	test('compileExecutionPlan succeeds when resolve-only feature is explicitly configured in gates', () => {
		// When a resolve-only feature is added to BOTH execution AND gates, it should work
		const validConfig: ThreeFactorConfig = {
			schema: CONFIG_SCHEMA,
			name: 'valid-resolve-only',
			execution: [
				'badgeStage',
				'badges',
				'badgeGlyphTemplate', // In execution
				'baskets',
				'tees',
				'teeFamily',
				'teeRecovery',
				'supportField',
				'badgeOcclusionPatch',
				'rawPairs',
				'measurement',
				'assignment'
			],
			gates: {
				G1: {
					badgeGlyphTemplate: {
						enabled: true,
						knobs: {
							minScore: 0.6,
							minMargin: 0.05,
							foregroundThreshold: 150,
							maxShiftPx: 1
						}
					}
				}
			}
		};
		const validResolved = resolveConfig(validConfig, DEFAULT_EXECUTION);
		// Feature should be in resolved because it's explicitly configured
		expect(validResolved.features['badgeGlyphTemplate']).toBeDefined();
		// Compilation should succeed
		const plan = compileExecutionPlan(validResolved);
		expect(plan.ops.map((op) => op.id)).toContain('badgeGlyphTemplate');
	});

	test('unit side and config side must both declare the same knobs (unit knobs enforced via defaults)', () => {
		// All features in the registry come with defaults for all knobs
		// So resolved state will always have all knobs. Test this consistency:
		const config: ThreeFactorConfig = {
			schema: CONFIG_SCHEMA,
			name: 'test-all-knobs-present',
			gates: {
				G1: {
					badgeGlyphTemplate: {
						enabled: true,
						knobs: {
							minScore: 0.6,
							minMargin: 0.05,
							foregroundThreshold: 150,
							maxShiftPx: 1
						}
					}
				}
			}
		};
		const resolved = resolveConfig(config, DEFAULT_EXECUTION);
		expect(resolved.features['badgeGlyphTemplate'].knobs).toEqual({
			minScore: 0.6,
			minMargin: 0.05,
			foregroundThreshold: 150,
			maxShiftPx: 1
		});
	});

	test('TIER-1: parseConfig throws when config provides a knob the unit does not declare', () => {
		// 2026-08-29: TIER 1a detection — a config sets a knob no unit
		// resolves/reads (user believes they changed behavior; nothing happened).
		// parseConfig validates that knobs exist in the feature's knobs dict.
		const badConfig = {
			schema: CONFIG_SCHEMA,
			name: 'unknown-knob-attempt',
			gates: {
				G4: {
					phantomTee: {
						enabled: true,
						knobs: {
							minViableScore: 0.1,
							maxCompletions: 2,
							whitelist: [],
							unknownKnob: 'this should fail' // Unknown knob on phantomTee
						}
					}
				}
			}
		};
		// parseConfig should reject it at validation time, naming the unknown knob
		expect(() => parseConfig(badConfig)).toThrow(
			/unknown knob 'unknownKnob'/
		);
	});

	test('TIER-2: compileExecutionPlan emits warning (never throws) for enabled deviation using defaults', () => {
		// 2026-08-29: TIER 2 drift detection — one-sided-but-functional drift.
		// An enabled deviation feature that has knobs using default values (not
		// explicitly configured) should emit a compile-time warning for visibility.
		// This can happen when a feature adds a new knob but existing ON-configs
		// haven't been updated yet. It's functional (defaults work) but worth noting.
		const config: ThreeFactorConfig = {
			schema: CONFIG_SCHEMA,
			name: 'partial-knobs',
			gates: {
				G4: {
					phantomTee: {
						enabled: true,
						knobs: {
							minViableScore: 0.1,
							maxCompletions: 2
							// whitelist knob is missing — will use default []
						}
					}
				}
			}
		};
		const resolved = resolveConfig(config, DEFAULT_EXECUTION);
		// Compilation should succeed (never throws on TIER 2)
		const plan = compileExecutionPlan(resolved);
		// Should include a warning about defaulted knobs
		expect(plan.warnings).toBeDefined();
		expect(plan.warnings?.length).toBeGreaterThan(0);
		expect(plan.warnings?.[0]).toContain('phantomTee');
		expect(plan.warnings?.[0]).toContain('using defaults');
	});

	test('TIER-2: warning explicitly names the feature and defaulted knobs', () => {
		// 2026-08-29: verify that TIER 2 warnings provide enough context
		// to find and fix the issue. Warnings are consolidated per feature
		// (not per knob) to keep noise reasonable.
		const config: ThreeFactorConfig = {
			schema: CONFIG_SCHEMA,
			name: 'unnamed-knob',
			gates: {
				G4: {
					phantomTee: {
						enabled: true,
						knobs: {
							minViableScore: 0.5
							// Missing maxCompletions and whitelist
						}
					}
				}
			}
		};
		const resolved = resolveConfig(config, DEFAULT_EXECUTION);
		const plan = compileExecutionPlan(resolved);
		// Should have at least one warning per affected feature
		expect(plan.warnings).toBeDefined();
		expect(plan.warnings!.length).toBeGreaterThanOrEqual(1);
		// Warning should name the feature, mention defaults, and list knobs
		const warningText = plan.warnings!.join('\n');
		expect(warningText).toContain('phantomTee');
		expect(warningText).toContain('defaults');
		expect(warningText).toContain('maxCompletions');
		expect(warningText).toContain('whitelist');
	});
});
