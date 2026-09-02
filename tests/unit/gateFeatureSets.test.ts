import { describe, expect, test } from 'vitest';
import { GATE_FEATURE_SETS } from '@chainspot/alg/detectors/threeFactor/gate-sets';
import { compileABFeatureSet, type ABFeatureSet } from '@chainspot/alg/exec';
import type { ABFeature } from '@chainspot/alg/detectors/threeFactor/features/types';

const expectedMembership = {
	'shared-set': ['hsv'],
	'g1-set': ['badges', 'digits', 'badgeGlyphTemplate'],
	'g2-set': ['sprite', 'cleanBasketFamily'],
	'g3-set': ['endpoints', 'teeFamily', 'teeMinAreaPose'],
	'g4-set': ['teeRecovery', 'phantomTee', 'teeBadgeLock', 'posteriorTeeRecovery'],
	'g5-set': ['fourLaneSensor', 'straightTest', 'ribbon', 'routing', 'badgeM2Aa'],
	'g6-set': ['scoring', 'search'],
	'g7-set': ['zfit']
} as const;

describe('threeFactor production semantic ABFeatureSets', () => {
	test('declares all semantic sets with the exact active feature ownership', () => {
		expect(Object.keys(GATE_FEATURE_SETS).sort()).toEqual(Object.keys(expectedMembership).sort());
		for (const [setId, featureIds] of Object.entries(expectedMembership) as [
			keyof typeof expectedMembership,
			readonly string[]
		][]) {
			expect(GATE_FEATURE_SETS[setId].features.map((feature) => feature.id)).toEqual(featureIds);
		}
	});

	test('makes cross-gate operation reads an explicit import contract', () => {
		const owned = {
			id: 'owned',
			gate: 'G1',
			kind: 'baseline',
			defaultEnabled: true,
			knobs: {}
		} satisfies ABFeature;
		const definition: ABFeatureSet = {
			id: 'import-contract-demo',
			features: [owned],
			seededSlots: ['input'],
			operations: [
				{
					operation: {
						spec: {
							id: 'import-contract-demo.run',
							kind: 'compute',
							gate: 'G1',
							unit: 'demo',
							consumes: ['input'],
							produces: ['output'],
							features: ['external-read']
						},
						run(board) {
							board.set('output', board.get('input'));
						}
					}
				}
			]
		};
		expect(() => compileABFeatureSet(definition)).toThrow(
			/reads 'external-read' but the set neither owns nor imports it/
		);
		expect(() =>
			compileABFeatureSet({
				...definition,
				imports: ['external-read'],
				locallyOperationlessFeatureIds: ['owned']
			})
		).not.toThrow();
		expect(() => compileABFeatureSet({ ...definition, imports: ['external-read'] })).toThrow(
			/enabled feature 'owned' has no operations/
		);
	});

	test('keeps an explicitly operationless owned feature in the public binding', () => {
		const parameterOnly = {
			id: 'parameter-only',
			gate: 'G5',
			kind: 'deviation',
			defaultEnabled: false,
			knobs: {}
		} satisfies ABFeature;
		const compiled = compileABFeatureSet(
			{
				id: 'operationless-feature-demo',
				features: [parameterOnly],
				locallyOperationlessFeatureIds: ['parameter-only']
			},
			{ 'parameter-only': { enabled: true } }
		);
		expect(compiled.enabledFeatureIds).toEqual(['parameter-only']);
		expect(compiled.plan.ops).toEqual([]);
	});
});
