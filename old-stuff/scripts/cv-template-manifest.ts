import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { validateCvTemplateManifest } from '../src/lib/autoAnnotation/cvCalibration';
import type { CvTemplateManifest } from '../src/lib/autoAnnotation/cvCalibration';

/**
 * Node/CLI template-pack boundary. Semantic calibration comes from manifest
 * metadata; native PNG dimensions are intentionally never inspected here.
 */
export function loadValidatedCvTemplateManifest(templateDir: string): CvTemplateManifest {
	const root = resolve(templateDir);
	const manifestPath = join(root, 'manifest.json');
	if (!existsSync(manifestPath)) {
		throw new Error(`CV template manifest is missing: ${manifestPath}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
	} catch (error) {
		throw new Error(
			`CV template manifest is invalid JSON: ${error instanceof Error ? error.message : String(error)}`
		);
	}
	const manifest = validateCvTemplateManifest(parsed);
	for (const fileName of [...manifest.templates.holeNumbers, manifest.templates.basket]) {
		const assetPath = join(root, fileName);
		if (!existsSync(assetPath)) {
			throw new Error(`CV template manifest asset is missing: ${assetPath}`);
		}
	}
	return manifest;
}
