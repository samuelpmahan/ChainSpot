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

describe('resolveConfig + engine', () => {
	test('default config resolves to registry defaults and PINNED hash', async () => {
		const resolved = resolveConfig(parseConfig(defaultConfigJson), DEFAULT_EXECUTION);
		expect(resolved.features['zfit']).toEqual({
			enabled: false,
			knobs: { topK: 80, alignedWorstCeiling: 0.28 }
		});
		const hash = await sha256Hex(canonicalJson(resolved));
		// Pinned: changing any registry default or the execution list must
		// force a conscious update here.
		expect(hash).toBe('09ee0fdff7eb561925cbdcfdef2688e6a5409665412b0155e1df2a64e5a6e0b6');
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
