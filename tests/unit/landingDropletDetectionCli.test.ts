import { describe, expect, it } from 'vitest';
import { parseArgs } from '../../scripts/detect-landing-droplets';

describe('landing droplet detection CLI', () => {
	it('parses the input path, output directory, and template directory override', () => {
		expect(
			parseArgs(['round.png', '--out', 'out', '--templates', 'my-templates'])
		).toMatchObject({
			inputPath: 'round.png',
			outputDir: 'out',
			templateDir: 'my-templates'
		});
	});

	it('requires an output directory', () => {
		expect(() => parseArgs(['round.png'])).toThrow('--out is required');
	});

	it('requires an input path', () => {
		expect(() => parseArgs(['--out', 'out'])).toThrow('An image input is required');
	});

	it('rejects a second positional argument', () => {
		expect(() => parseArgs(['round.png', 'round2.png', '--out', 'out'])).toThrow(
			"Only one input path is supported; received 'round2.png'."
		);
	});
});
