import { resolve } from 'node:path';
import { parseArgs, runDetection } from './detect-baskets';
import { loadValidatedCvTemplateManifest } from './cv-template-manifest';

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	loadValidatedCvTemplateManifest(args.templateDir);
	await runDetection(args);
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});

// Keep an import/export surface for unit tests and one-off Node callers while
// ensuring the package entry point always validates calibration metadata first.
export { parseArgs, runDetection } from './detect-baskets';
void resolve;
