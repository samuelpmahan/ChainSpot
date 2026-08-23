import { describe, expect, test } from 'vitest';
import {
	DEFAULT_EXECUTION,
	ENGINE_UNITS,
	parseConfig,
	resolveConfig,
	runThreeFactor,
	validateExecution
} from '$lib/detectors/threeFactor';
import { SEEDED_SLOTS } from '$lib/detectors/threeFactor/engine';
import { canonicalJson, sha256Hex } from '$lib/detectors/threeFactor/hash';
import { defaultKnobs } from '$lib/detectors/threeFactor/features/types';
import { g4ScoringFeature } from '$lib/detectors/threeFactor/features/g4.scoring';
import { g4SearchFeature } from '$lib/detectors/threeFactor/features/g4.search';
import { zfitFeature } from '$lib/detectors/threeFactor/features/g5.zfit';
import { g5RibbonFeature } from '$lib/detectors/threeFactor/features/g5.ribbon';
import { g5RoutingFeature } from '$lib/detectors/threeFactor/features/g5.routing';
import { g3EndpointsFeature } from '$lib/detectors/threeFactor/features/g3.endpoints';
import { g2SpriteFeature } from '$lib/detectors/threeFactor/features/g2.sprite';
import { g1BadgesFeature } from '$lib/detectors/threeFactor/features/g1.badges';
import { g1DigitsFeature } from '$lib/detectors/threeFactor/features/g1.digits';
import { sharedHsvFeature } from '$lib/detectors/threeFactor/features/shared.hsv';
import { DEFAULT_SCORING_KNOBS, DEFAULT_ZFIT_KNOBS } from '$lib/detectors/threeFactor/scoring';
import { DEFAULT_SEARCH_KNOBS } from '$lib/detectors/threeFactor/assignment';
import { DEFAULT_RIBBON_KNOBS } from '$lib/detectors/threeFactor/ribbon';
import { DEFAULT_ROUTING_KNOBS } from '$lib/detectors/threeFactor/routing';
import { DEFAULT_ENDPOINTS_KNOBS, DEFAULT_SPRITE_KNOBS } from '$lib/detectors/threeFactor/endpoints';
import { DEFAULT_BADGE_STAGE_KNOBS } from '$lib/detectors/threeFactor/badgeStage';
import { DEFAULT_DIGITS_KNOBS } from '$lib/detectors/threeFactor/digits/segment';
import { DEFAULT_HSV_KNOBS } from '$lib/detectors/threeFactor/raster';
import defaultConfigJson from '$lib/detectors/threeFactor/configs/default.json';
import zfitOnJson from '$lib/detectors/threeFactor/configs/zfit-on.json';
import type { RgbaRaster } from '$lib/detect';

function tinyRaster(): RgbaRaster {
	const w = 48;
	const h = 64;
	const rgba = new Uint8ClampedArray(w * h * 4);
	for (let i = 0; i < rgba.length; i += 4) {
		rgba[i] = 120;
		rgba[i + 1] = 120;
		rgba[i + 2] = 120;
		rgba[i + 3] = 255;
	}
	return { imageId: 'e'.repeat(64), widthPx: w, heightPx: h, rgba };
}

describe('canonicalJson / sha256Hex', () => {
	test('key order does not matter; array order does', () => {
		expect(canonicalJson({ b: 1, a: [2, 1] })).toBe(canonicalJson({ a: [2, 1], b: 1 }));
		expect(canonicalJson({ a: [1, 2] })).not.toBe(canonicalJson({ a: [2, 1] }));
	});

	test('sha256 known vector', async () => {
		// sha256("abc")
		expect(await sha256Hex('abc')).toBe(
			'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
		);
	});
});

describe('parseConfig', () => {
	test('accepts the shipped configs', () => {
		expect(() => parseConfig(defaultConfigJson)).not.toThrow();
		expect(() => parseConfig(zfitOnJson)).not.toThrow();
	});

	test('rejects unknown top-level keys (typo protection)', () => {
		expect(() =>
			parseConfig({ schema: 'threeFactor-config@1', name: 'x', gatess: {} })
		).toThrow(/unknown key 'gatess'/);
	});

	test('rejects unknown gate, feature, knob, and bad knob values', () => {
		const base = { schema: 'threeFactor-config@1', name: 'x' };
		expect(() => parseConfig({ ...base, gates: { G9: {} } })).toThrow(/unknown gate/);
		expect(() => parseConfig({ ...base, gates: { G5: { nope: {} } } })).toThrow(/unknown feature/);
		expect(() =>
			parseConfig({ ...base, gates: { G5: { zfit: { knobs: { nope: 1 } } } } })
		).toThrow(/unknown knob/);
		expect(() =>
			parseConfig({ ...base, gates: { G5: { zfit: { knobs: { topK: -1 } } } } })
		).toThrow(/positive integer/);
		expect(() =>
			parseConfig({ ...base, gates: { G3: { zfit: { enabled: true } } } })
		).toThrow(/belongs to gate/);
	});
});

describe('validateExecution', () => {
	test('default order is valid', () => {
		expect(() => validateExecution(DEFAULT_EXECUTION, ENGINE_UNITS, SEEDED_SLOTS)).not.toThrow();
	});

	test('reordered-but-valid passes; dependency violations fail with the slot named', () => {
		// baskets before supportField is dependency-legal (both feed later units)
		const reordered = [
			'badgeStage',
			'baskets',
			'badges',
			'supportField',
			'badgeOcclusionPatch',
			'tees',
			'rawPairs',
			'measurement',
			'assignment'
		];
		expect(() => validateExecution(reordered, ENGINE_UNITS, SEEDED_SLOTS)).not.toThrow();

		const missingStage = DEFAULT_EXECUTION.filter((id) => id !== 'badgeStage');
		expect(() => validateExecution(missingStage, ENGINE_UNITS, SEEDED_SLOTS)).toThrow(/'stage'/);
		expect(() => validateExecution(['nope'], ENGINE_UNITS, SEEDED_SLOTS)).toThrow(/unknown unit/);
		expect(() =>
			validateExecution([...DEFAULT_EXECUTION, 'assignment'], ENGINE_UNITS, SEEDED_SLOTS)
		).toThrow(/twice/);
	});
});

describe('fallback-default mirrors', () => {
	// The bare (configless) path uses DEFAULT_*_KNOBS consts; the config path
	// uses the feature files' defaults. Byte-equal or the two paths diverge.
	test('DEFAULT_*_KNOBS equal their feature defaults', () => {
		expect(DEFAULT_SCORING_KNOBS).toEqual(defaultKnobs(g4ScoringFeature));
		expect(DEFAULT_ZFIT_KNOBS).toEqual(defaultKnobs(zfitFeature));
		expect(DEFAULT_SEARCH_KNOBS).toEqual(defaultKnobs(g4SearchFeature));
		// DEFAULT_RIBBON_KNOBS covers the ribbon.ts-function-parameter knobs
		// only; fieldScale/supportTau ride CorridorParams instead (see
		// features/g5.ribbon.ts's file header), so they're excluded here and
		// compared separately below.
		const { fieldScale, supportTau, ...ribbonFunctionKnobDefaults } = defaultKnobs(g5RibbonFeature) as Record<
			string,
			unknown
		>;
		expect(DEFAULT_RIBBON_KNOBS).toEqual(ribbonFunctionKnobDefaults);
		expect(fieldScale).toBe(3);
		expect(supportTau).toBe(0.5);
		// Same split for g5.routing: quantum/ring/seedCostClamp/
		// seedClampRadiusCells are routing.ts-function-parameter knobs;
		// corridorWidthPx/orientations/widthsSrc/alignmentPower/
		// worstWindowSrcPx ride CorridorParams instead.
		const {
			corridorWidthPx,
			orientations,
			widthsSrc,
			alignmentPower,
			worstWindowSrcPx,
			...routingFunctionKnobDefaults
		} = defaultKnobs(g5RoutingFeature) as Record<string, unknown>;
		expect(DEFAULT_ROUTING_KNOBS).toEqual(routingFunctionKnobDefaults);
		expect(corridorWidthPx).toBe(37);
		expect(orientations).toBe(12);
		expect(widthsSrc).toEqual([24, 32, 40, 48, 56, 64]);
		expect(alignmentPower).toBe(2);
		expect(worstWindowSrcPx).toBe(90);
		expect(DEFAULT_ENDPOINTS_KNOBS).toEqual(defaultKnobs(g3EndpointsFeature));
		expect(DEFAULT_SPRITE_KNOBS).toEqual(defaultKnobs(g2SpriteFeature));
		// badgeInsidePadding rides no separate mechanism (unlike g5.ribbon/
		// g5.routing's CorridorParams-riding knobs) — it's bundled into the
		// same BadgeStageKnobs type even though only measure.ts's makeTees
		// reads it, not badgeStage.ts. Plain equality, no split needed.
		expect(DEFAULT_BADGE_STAGE_KNOBS).toEqual(defaultKnobs(g1BadgesFeature));
		expect(DEFAULT_DIGITS_KNOBS).toEqual(defaultKnobs(g1DigitsFeature));
		expect(DEFAULT_HSV_KNOBS).toEqual(defaultKnobs(sharedHsvFeature));
	});
});

describe('validateRoutingRingQuantum (g5.routing / g5.ribbon cross-feature invariant)', () => {
	test('default ring/quantum/costMultiplier combination resolves cleanly', () => {
		expect(() => resolveConfig(parseConfig(defaultConfigJson), DEFAULT_EXECUTION)).not.toThrow();
	});

	test('a ring/quantum pair too small for the max edge weight fails at resolve time', () => {
		const base = { schema: 'threeFactor-config@1', name: 'x' };
		expect(() =>
			resolveConfig(
				parseConfig({ ...base, gates: { G5: { routing: { knobs: { ring: 2 } } } } }),
				DEFAULT_EXECUTION
			)
		).toThrow(/ring \(2\) \* quantum/);
	});
});

describe('resolveConfig + engine', () => {
	test('default config resolves to registry defaults and PINNED hash', async () => {
		const resolved = resolveConfig(parseConfig(defaultConfigJson), DEFAULT_EXECUTION);
		expect(resolved.features['zfit']).toEqual({
			enabled: false,
			knobs: {
				topK: 80,
				alignedWorstCeiling: 0.28,
				distanceStartOffset: 8,
				distanceStepPx: 14,
				maxChordFraction: 0.85,
				maxAdditionalDistance: 220,
				bendAngles: [-60, -45, -30, -20, 0, 20, 30, 45, 60],
				bendLengthShort: 0.8,
				bendLengthMedium: 1.6,
				bendLengthLong: 3,
				maxPathOvershootFraction: 1.4,
				bendFactorWithSegment: 0.8,
				bendFactorWithoutSegment: 0.9,
				scoreMultiplier: 0.9
			}
		});
		const hash = await sha256Hex(canonicalJson(resolved));
		// Pinned: changing any registry default or the execution list must
		// force a conscious update here.
		expect(hash).toBe('45013e053b576b9aaf0cd4d63bdda25e6c16c58684f41967688903321740df41');
	});

	test('config path is byte-identical to the bare path on defaults', async () => {
		const raster = tinyRaster();
		const bare = runThreeFactor(raster);
		const resolved = resolveConfig(parseConfig(defaultConfigJson), DEFAULT_EXECUTION);
		const configured = runThreeFactor(raster, { config: resolved, paramsHash: 'h' });
		expect(configured.measurement).toEqual(bare.measurement);
		expect(configured.assignment).toEqual(bare.assignment);
		expect(configured.trace).toBeDefined();
		expect(configured.trace?.execution).toEqual(DEFAULT_EXECUTION);
	});

	test('zfit-on config flips measurement.parameters.zfit', () => {
		const resolved = resolveConfig(parseConfig(zfitOnJson), DEFAULT_EXECUTION);
		const run = runThreeFactor(tinyRaster(), { config: resolved });
		expect(run.measurement.parameters.zfit).toBe(true);
	});

	test('trace collects unit spans and paramsHash lands on emissions', async () => {
		const resolved = resolveConfig(parseConfig(defaultConfigJson), DEFAULT_EXECUTION);
		const run = runThreeFactor(tinyRaster(), { config: resolved, paramsHash: 'deadbeef' });
		const unitIds = run.trace?.units.map((u) => u.id) ?? [];
		expect(unitIds).toContain('badgeStage');
		expect(unitIds).toContain('assignment');
		expect(run.paramsHash).toBe('deadbeef');
	});
});
