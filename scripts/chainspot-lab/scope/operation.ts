import { existsSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CanonicalTruth } from '@chainspot/alg/g0/truth';
import { decodeInput, type DecodedInput, type G0Report } from '../sweep/inputShim';
import { loadTruth } from '../sweep/truthScoring';
import { renderScope } from './render';
import { resolveScopeRequest, scopeCanonicalMeta, scopeSlug, validateScopeRequest } from './core';
import type { ScopeRenderMeta, ScopeRequest, ScopeResolvedRequest } from './types';

// The pure vocabulary lives in ./core (browser-safe). Re-exported here so
// existing CLI/UI importers keep working unchanged.
export { scopeSlug, scopeBounds, scopeCanonicalMeta, resolveScopeRequest, validateScopeRequest } from './core';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
export const DEFAULT_SCOPE_OUT = resolve(REPO_ROOT, 'artifacts', 'scope');

export interface LoadedScopeInput {
	readonly imagePath: string;
	readonly annotationPath?: string;
	readonly rawTruth?: CanonicalTruth;
	readonly truth?: CanonicalTruth;
	readonly decoded: DecodedInput;
}

export async function loadScopeInput(imagePath: string, annotationPath?: string): Promise<LoadedScopeInput> {
	const resolvedImage = resolve(imagePath);
	const resolvedAnnotation = annotationPath ? resolve(annotationPath) : undefined;
	if (!existsSync(resolvedImage)) throw new Error(`lab scope: image does not exist: ${resolvedImage}`);
	if (resolvedAnnotation && !existsSync(resolvedAnnotation)) throw new Error(`lab scope: annotation does not exist: ${resolvedAnnotation}`);
	const rawTruth = resolvedAnnotation ? loadTruth(resolvedAnnotation) : undefined;
	const decoded = await decodeInput(resolvedImage, rawTruth);
	if (rawTruth && !decoded.report.truthMatch) {
		throw new Error(`lab scope: supplied annotation does not correspond to canonicalized raster ${resolvedImage}.`);
	}
	return {
		imagePath: resolvedImage,
		annotationPath: resolvedAnnotation,
		rawTruth,
		truth: decoded.canonicalTruth ?? rawTruth,
		decoded
	};
}

export interface RunScopeOperationInput {
	readonly imagePath: string;
	readonly annotationPath?: string;
	readonly request: ScopeRequest;
	readonly outputPath?: string;
	readonly outDir?: string;
	readonly overlays?: readonly ScopeResolvedRequest[];
	readonly pins?: Parameters<typeof renderScope>[0]['pins'];
}

export interface RunScopeOperationResult {
	readonly outputPath: string;
	readonly meta: ScopeRenderMeta;
	readonly report: G0Report;
	readonly resolvedRequest: ScopeResolvedRequest;
	readonly imagePath: string;
	readonly annotationPath?: string;
}

export async function runScopeOperation(input: RunScopeOperationInput): Promise<RunScopeOperationResult> {
	const loaded = await loadScopeInput(input.imagePath, input.annotationPath);
	const { report, image } = loaded.decoded;
	const resolvedRequest = resolveScopeRequest(input.request, loaded.truth, image.width, image.height);
	validateScopeRequest(resolvedRequest, image.width, image.height);
	const base = scopeSlug(basename(loaded.imagePath, extname(loaded.imagePath)));
	const outputPath = input.outputPath
		? resolve(input.outputPath)
		: resolve(input.outDir ?? DEFAULT_SCOPE_OUT, base, `${scopeSlug(resolvedRequest.name)}.png`);
	const meta = renderScope({
		raster: { width: image.width, height: image.height, data: image.data, imageId: report.imageId },
		imagePath: loaded.imagePath,
		annotationPath: loaded.annotationPath,
		canonical: scopeCanonicalMeta(report),
		request: resolvedRequest,
		overlays: input.overlays,
		pins: input.pins,
		outputPath
	});
	return {
		outputPath,
		meta,
		report,
		resolvedRequest,
		imagePath: loaded.imagePath,
		annotationPath: loaded.annotationPath
	};
}
