// The package's exported surface is the contract between the algorithm and the
// app. Branches may diverge freely on everything behind it; a change to the
// surface itself reaches every branch at once, so it has to be deliberate.
//
// This test snapshots the runtime exports by name. If you meant to change the
// boundary, update EXPECTED_RUNTIME_EXPORTS in the same commit — that diff is
// the signal to reviewers that dependent code may need to move with it.
import { describe, expect, it } from 'vitest';
import * as pkg from '../src/index';

const EXPECTED_RUNTIME_EXPORTS = [
	'THREE_FACTOR_ALGO',
	'THREE_FACTOR_ALGO_VERSION',
	'assignMeasuredThreeFactor',
	'createThreeFactorDetector',
	'emitThreeFactorRun',
	'insertRecoveredEndpoints',
	'measureThreeFactor',
	'runThreeFactor',
	'threeFactorDetector'
] as const;

describe('package surface', () => {
	it('exports exactly the agreed runtime names', () => {
		expect(Object.keys(pkg).sort()).toEqual([...EXPECTED_RUNTIME_EXPORTS].sort());
	});

	it('exposes a callable detector matching the contract shape', () => {
		expect(typeof pkg.threeFactorDetector).toBe('function');
		expect(pkg.threeFactorDetector.length).toBe(2); // (image, emit)
		expect(typeof pkg.createThreeFactorDetector()).toBe('function');
	});

	it('identifies its algorithm so emissions can be traced to a version', () => {
		expect(pkg.THREE_FACTOR_ALGO).toBeTruthy();
		expect(pkg.THREE_FACTOR_ALGO_VERSION).toBeTruthy();
	});
});
