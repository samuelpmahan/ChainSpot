import { describe, expect, test } from 'vitest';
import {
	compileABFeatureSet,
	createExecBoard,
	executeABFeatureSet,
	formatABFeatureSetManifestMarkdown,
	type ABFeatureSet
} from '@chainspot/alg/exec';
import { nullFeatureContext } from '@chainspot/alg/detectors/threeFactor/features/types';
import { THREE_FACTOR_SHARED_SERVICES } from '@chainspot/alg/detectors/threeFactor/shared-services';

const feature = {
	id: 'service-demo',
	gate: 'shared',
	kind: 'baseline',
	defaultEnabled: true,
	knobs: {}
} as const;

const base: ABFeatureSet = {
	id: 'service-demo-set',
	features: [feature],
	locallyOperationlessFeatureIds: ['service-demo']
};

describe('ABFeatureSet shared-service enclosure', () => {
	test('registers the three-factor occlusion seam as metadata only', () => {
		expect(THREE_FACTOR_SHARED_SERVICES).toEqual([
			{
				id: 'occlusion',
				kind: 'run-scoped-infrastructure',
				scope: 'run',
				note: 'Known opaque/alpha footprint seam shared by three-factor stages.'
			}
		]);
		expect(THREE_FACTOR_SHARED_SERVICES).toHaveLength(1);
	});

	test('compiles owned services into inventory without adding runtime stages', async () => {
		const withoutServices = compileABFeatureSet(base);
		const withServices = compileABFeatureSet({
			...base,
			services: THREE_FACTOR_SHARED_SERVICES
		});

		expect(withServices.plan.ops).toEqual([]);
		expect(withServices.ownedServiceIds).toEqual(['occlusion']);
		expect(withoutServices.ownedServiceIds).toEqual([]);
		// Empty service metadata intentionally leaves existing plan fingerprints
		// untouched; adding an owned service is a semantic fingerprint change.
		expect(withServices.plan.planFingerprint).not.toBe(withoutServices.plan.planFingerprint);

		const receipt = await executeABFeatureSet(
			withServices,
			createExecBoard(),
			nullFeatureContext,
			{ runId: 'service-run', invocation: 'vitest featureSetSharedServices' }
		);
		expect(receipt.ownedServiceIds).toEqual(['occlusion']);
		expect(receipt.operations).toEqual([]);
		expect(formatABFeatureSetManifestMarkdown(receipt)).toContain(
			'- owned services: `occlusion`'
		);
	});

	test('rejects duplicate and malformed service descriptors', () => {
		const descriptor = { id: 'shared', kind: 'run-scoped-infrastructure' } as const;
		expect(() => compileABFeatureSet({ ...base, services: [descriptor, descriptor] })).toThrow(
			/duplicate service 'shared'/
		);
		expect(() => compileABFeatureSet({ ...base, services: [{ id: '', kind: 'infrastructure' }] })).toThrow(
			/service id must be a non-empty string/
		);
		expect(() =>
			compileABFeatureSet({ ...base, services: [{ id: 'shared', kind: '' }] })
		).toThrow(/service 'shared' kind must be a non-empty string/);
		expect(() =>
			compileABFeatureSet({
				...base,
				services: [{ id: 'shared', kind: 'infrastructure', scope: 'process' as 'run' }]
			})
		).toThrow(/unsupported scope 'process'/);
	});
});

