import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, runDetection } from './detect-baskets';
import { loadValidatedCvTemplateManifest } from './cv-template-manifest';

const scriptPath = fileURLToPath(import.meta.url);

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	loadValidatedCvTemplateManifest(args.templateDir);
	await runDetection(args);
}

if (resolve(process.argv[1] ?? '') === resolve(scriptPath)) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}

// Keep an import/export surface for tests and one-off Node callers while the
// package script guarantees manifest validation on the normal CLI entry path.
export { parseArgs, runDetection } from './detect-baskets';
