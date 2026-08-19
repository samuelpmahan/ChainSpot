import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { SHA256_PATTERN } from './core/identity';
import { sha256File } from './core/hashing';
import type { LabConfig } from './config';
import type { ViewportCropParameters } from './nodes/viewportTypes';

export const DEFAULT_STEP_TWO_ABLATION_ID = 'step2-dashstrack';
const ABLATION_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export interface StepTwoAblationV1 {
	readonly schemaVersion: 1;
	readonly id: string;
	readonly experimentName: string;
	readonly suite: {
		readonly name: string;
		readonly case: {
			readonly id: string;
			readonly course: string;
			readonly raster: {
				readonly relativePath: string;
				readonly format: 'jpeg' | 'png';
				readonly expectedSha256: string;
			};
			readonly truth?: {
				readonly relativePath: string;
				readonly expectedSha256: string;
				readonly evidenceRole: 'discovery' | 'calibration' | 'held_out_validation';
			};
		};
	};
	readonly viewport: {
		readonly implementationId:
			| 'viewport.crop.explicit-insets-v1'
			| 'viewport.crop.production-entropy-v1';
		readonly parameters: ViewportCropParameters;
	};
}

export interface ResolvedStepTwoAblation {
	readonly definition: StepTwoAblationV1;
	readonly definitionPath: string;
	readonly rasterPath: string;
	readonly truthPath?: string;
}

function requiredString(value: unknown, name: string): string {
	if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
		throw new TypeError(`${name} must be a non-empty string`);
	}
	return value;
}

function resolveCorpusFile(corpusRoot: string, relativePath: string, name: string): string {
	if (isAbsolute(relativePath)) throw new TypeError(`${name} must be corpus-relative`);
	const path = resolve(corpusRoot, relativePath);
	const fromCorpus = relative(corpusRoot, path);
	if (fromCorpus.startsWith('..') || isAbsolute(fromCorpus)) {
		throw new TypeError(`${name} escapes the configured corpus root`);
	}
	if (!existsSync(path)) throw new Error(`${name} does not exist: ${path}`);
	return path;
}

function validateDigest(path: string, expected: string, name: string): void {
	if (!SHA256_PATTERN.test(expected)) throw new TypeError(`${name} expectedSha256 is invalid`);
	const actual = sha256File(path);
	if (actual !== expected) throw new Error(`${name} digest mismatch: expected ${expected}, received ${actual}`);
}

function validateDefinition(value: unknown, expectedId: string): StepTwoAblationV1 {
	if (!value || typeof value !== 'object') throw new TypeError('Ablation must be an object');
	const definition = value as StepTwoAblationV1;
	if (definition.schemaVersion !== 1) throw new TypeError('Unsupported Step 2 ablation schema');
	if (definition.id !== expectedId) throw new Error(`Ablation ID mismatch: expected ${expectedId}`);
	requiredString(definition.experimentName, 'experimentName');
	requiredString(definition.suite?.name, 'suite.name');
	requiredString(definition.suite?.case?.id, 'suite.case.id');
	requiredString(definition.suite?.case?.course, 'suite.case.course');
	if (definition.suite.case.raster.format !== 'jpeg' && definition.suite.case.raster.format !== 'png') {
		throw new TypeError('suite.case.raster.format is unsupported');
	}
	const viewport = definition.viewport;
	if (viewport.implementationId === 'viewport.crop.explicit-insets-v1') {
		if (viewport.parameters.strategy !== 'explicit-insets') {
			throw new TypeError('Explicit-insets implementation requires explicit-insets parameters');
		}
	} else if (viewport.implementationId === 'viewport.crop.production-entropy-v1') {
		if (viewport.parameters.strategy !== 'production-auto') {
			throw new TypeError('Production-entropy implementation requires production-auto parameters');
		}
	} else {
		throw new TypeError(`Unsupported viewport implementation: ${String(viewport.implementationId)}`);
	}
	return definition;
}

/** Resolve a named, repo-tracked ablation. Arbitrary paths are intentionally not accepted. */
export function resolveStepTwoAblation(
	config: LabConfig,
	ablationId = DEFAULT_STEP_TWO_ABLATION_ID,
	viewportParametersOverride?: ViewportCropParameters
): ResolvedStepTwoAblation {
	if (!ABLATION_ID_PATTERN.test(ablationId)) throw new TypeError(`Invalid ablation ID: ${ablationId}`);
	const definitionPath = join(
		config.repoRoot,
		'experiments',
		'chainspot-lab',
		'ablations',
		`${ablationId}.json`
	);
	if (!existsSync(definitionPath)) throw new Error(`Unknown Step 2 ablation: ${ablationId}`);
	const loaded = validateDefinition(JSON.parse(readFileSync(definitionPath, 'utf8')), ablationId);
	const definition = viewportParametersOverride
		? validateDefinition(
				{
					...loaded,
					viewport: { ...loaded.viewport, parameters: viewportParametersOverride }
				},
				ablationId
			)
		: loaded;
	const rasterPath = resolveCorpusFile(
		config.corpus.path,
		definition.suite.case.raster.relativePath,
		'suite.case.raster'
	);
	validateDigest(rasterPath, definition.suite.case.raster.expectedSha256, 'suite.case.raster');
	let truthPath: string | undefined;
	if (definition.suite.case.truth) {
		truthPath = resolveCorpusFile(
			config.corpus.path,
			definition.suite.case.truth.relativePath,
			'suite.case.truth'
		);
		validateDigest(truthPath, definition.suite.case.truth.expectedSha256, 'suite.case.truth');
	}
	return { definition, definitionPath, rasterPath, truthPath };
}
