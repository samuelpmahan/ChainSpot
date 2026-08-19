import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { sha256File } from './core/hashing';
import { SHA256_PATTERN } from './core/identity';
import type { LabConfig } from './config';
import type { SpriteTemplate } from '../../src/lib/nuthing/endpoints';
import type { ProductionAutoViewportParameters } from './nodes/viewportTypes';

export const STEP_THREE_ABLATION_ID = 'step3-endpoint-baseline';
export type ChromeImplementationId = 'chrome.none' | 'chrome.screen-space-v1';

interface RasterDefinition {
	readonly relativePath: string;
	readonly format: 'jpeg' | 'png';
	readonly expectedSha256: string;
}

type TruthDefinition =
	| {
			readonly source: 'corpus-annotation';
			readonly relativePath: string;
			readonly expectedSha256: string;
			readonly holeNumbers?: readonly number[];
	  }
	| {
			readonly source: 'registered-annotations';
			readonly repoRelativePath: string;
			readonly expectedSha256: string;
			readonly entryKey: string;
	  };

export interface StepThreeAblationV1 {
	readonly schemaVersion: 1;
	readonly id: string;
	readonly experimentName: string;
	readonly suite: {
		readonly name: string;
		readonly evidenceRole: 'calibration';
		readonly referenceBaseline?: {
			readonly source: string;
			readonly rasterDecode: string;
			readonly cases: Readonly<Record<string, {
				readonly raw: number;
				readonly chromeSuppressed: number;
				readonly free: number;
				readonly teeRecall: number;
			}>>;
		};
		readonly cases: readonly {
			readonly id: string;
			readonly course: string;
			readonly raster: RasterDefinition;
			readonly truth: TruthDefinition;
			readonly viewport?: {
				readonly implementationId: 'viewport.crop.production-entropy-v1';
				readonly parameters: ProductionAutoViewportParameters;
			};
		}[];
	};
	readonly viewport: {
		readonly implementationId: 'viewport.crop.production-entropy-v1';
		readonly parameters: ProductionAutoViewportParameters;
	};
	readonly basketTemplate: {
		readonly repoRelativePath: string;
		readonly expectedSha256: string;
	};
	readonly chromeImplementationId: ChromeImplementationId;
}

export interface EndpointTruthHole {
	readonly number: number;
	readonly tee: readonly [number, number];
	readonly basket: readonly [number, number];
}

export interface ResolvedStepThreeCase {
	readonly id: string;
	readonly course: string;
	readonly raster: RasterDefinition;
	readonly rasterPath: string;
	readonly truthDefinition: TruthDefinition;
	readonly truthSourcePath: string;
	readonly truth: readonly EndpointTruthHole[];
	readonly viewport: StepThreeAblationV1['viewport'];
}

export interface ResolvedStepThreeAblation {
	readonly definition: StepThreeAblationV1;
	readonly definitionPath: string;
	readonly cases: readonly ResolvedStepThreeCase[];
	readonly basketTemplatePath: string;
	readonly basketTemplate: SpriteTemplate;
}

function resolveInside(root: string, path: string, label: string): string {
	if (isAbsolute(path)) throw new TypeError(`${label} must be relative`);
	const resolved = resolve(root, path);
	const fromRoot = relative(root, resolved);
	if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) throw new TypeError(`${label} escapes its root`);
	if (!existsSync(resolved)) throw new Error(`${label} does not exist: ${resolved}`);
	return resolved;
}

function verifyDigest(path: string, expected: string, label: string): void {
	if (!SHA256_PATTERN.test(expected)) throw new TypeError(`${label} expectedSha256 is invalid`);
	const actual = sha256File(path);
	if (actual !== expected) throw new Error(`${label} digest mismatch: expected ${expected}, received ${actual}`);
}

function point(value: unknown, label: string): readonly [number, number] {
	if (!Array.isArray(value) || value.length !== 2 || value.some((part) => typeof part !== 'number')) {
		throw new TypeError(`${label} must be a numeric [x,y] pair`);
	}
	return [value[0], value[1]];
}

function loadTruth(
	config: LabConfig,
	definition: TruthDefinition
): { path: string; holes: readonly EndpointTruthHole[] } {
	if (definition.source === 'corpus-annotation') {
		const path = resolveInside(config.corpus.path, definition.relativePath, 'truth corpus path');
		verifyDigest(path, definition.expectedSha256, 'truth corpus path');
		const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
			holes: Array<{
				number: number;
				tee: { xPx: number; yPx: number };
				basket: { xPx: number; yPx: number };
			}>;
		};
		const allowed = definition.holeNumbers ? new Set(definition.holeNumbers) : null;
		return {
			path,
			holes: parsed.holes
				.filter((hole) => !allowed || allowed.has(hole.number))
				.map((hole) => ({
					number: hole.number,
					tee: [hole.tee.xPx, hole.tee.yPx],
					basket: [hole.basket.xPx, hole.basket.yPx]
				}))
		};
	}
	const path = resolveInside(config.repoRoot, definition.repoRelativePath, 'registered truth path');
	verifyDigest(path, definition.expectedSha256, 'registered truth path');
	const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<
		string,
		{ registeredHoles: Array<{ number: number; tee: unknown; basket: unknown }> }
	>;
	const entry = parsed[definition.entryKey];
	if (!entry) throw new Error(`Registered truth entry is missing: ${definition.entryKey}`);
	return {
		path,
		holes: entry.registeredHoles.map((hole) => ({
			number: hole.number,
			tee: point(hole.tee, `truth ${definition.entryKey} tee`),
			basket: point(hole.basket, `truth ${definition.entryKey} basket`)
		}))
	};
}

export function resolveStepThreeAblation(
	config: LabConfig,
	chromeImplementationId?: ChromeImplementationId
): ResolvedStepThreeAblation {
	const definitionPath = join(
		config.repoRoot,
		'experiments',
		'chainspot-lab',
		'ablations',
		`${STEP_THREE_ABLATION_ID}.json`
	);
	const loaded = JSON.parse(readFileSync(definitionPath, 'utf8')) as StepThreeAblationV1;
	if (loaded.schemaVersion !== 1 || loaded.id !== STEP_THREE_ABLATION_ID) {
		throw new TypeError('Unsupported Step 3 ablation');
	}
	const selectedChrome = chromeImplementationId ?? loaded.chromeImplementationId;
	if (selectedChrome !== 'chrome.none' && selectedChrome !== 'chrome.screen-space-v1') {
		throw new TypeError(`Unsupported chrome implementation: ${selectedChrome}`);
	}
	const definition: StepThreeAblationV1 = {
		...loaded,
		chromeImplementationId: selectedChrome
	};
	const cases = definition.suite.cases.map((caseDefinition): ResolvedStepThreeCase => {
		const rasterPath = resolveInside(config.corpus.path, caseDefinition.raster.relativePath, 'raster path');
		verifyDigest(rasterPath, caseDefinition.raster.expectedSha256, 'raster path');
		const truth = loadTruth(config, caseDefinition.truth);
		return {
			...caseDefinition,
			rasterPath,
			truthDefinition: caseDefinition.truth,
			truthSourcePath: truth.path,
			truth: truth.holes,
			viewport: caseDefinition.viewport ?? definition.viewport
		};
	});
	const basketTemplatePath = resolveInside(
		config.repoRoot,
		definition.basketTemplate.repoRelativePath,
		'basket template path'
	);
	verifyDigest(basketTemplatePath, definition.basketTemplate.expectedSha256, 'basket template path');
	const basketTemplate = JSON.parse(readFileSync(basketTemplatePath, 'utf8')) as SpriteTemplate;
	return { definition, definitionPath, cases, basketTemplatePath, basketTemplate };
}
