import { describe, expect, test } from 'vitest';
import { resolve } from 'node:path';
import { runSweepOperation } from '../../scripts/chainspot-lab/sweep/operation';

const REPO_ROOT = resolve(__dirname, '../..');
const TAINTED_CONFIG = resolve(
	REPO_ROOT,
	'packages/alg/src/detectors/threeFactor/configs/straight-test-truth-assisted-compare.json'
);

describe('Straight Test ingress truth firewall', () => {
	test('refuses in blind/test mode before reading an unreadable annotation path', async () => {
		const previous = process.env.LAB_TEST_RUN;
		process.env.LAB_TEST_RUN = '1';
		try {
			await expect(
				runSweepOperation({
					configPath: TAINTED_CONFIG,
					inputPaths: ['/tmp/straight-test-blind-input.jpg'],
					truthPath: '/tmp/straight-test-missing-annotation.json'
				})
			).rejects.toThrow(/LAB TRUTH-TAINT/);
		} finally {
			if (previous === undefined) delete process.env.LAB_TEST_RUN;
			else process.env.LAB_TEST_RUN = previous;
		}
	});
});
