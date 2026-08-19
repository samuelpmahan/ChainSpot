import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import {
	DEFAULT_STEP_TWO_ABLATION_ID,
	resolveStepTwoAblation
} from './ablation';
import { computeExperimentHash, computeInvocationKey } from './core/hashing';
import { LabLedger } from './core/ledger';
import { ImmutableObjectStore } from './core/objectStore';
import {
	ImplementationRegistry,
	type RegisteredImplementation,
	type ResourceDeclaration
} from './core/registry';
import type { LabConfig } from './config';
import { collectDoctorReport } from './doctor';
import { runBrightDarkMasks, type BrightDarkMaskParameters } from './nodes/brightDarkMasks';
import { runRasterDecode, type RasterDecodeParameters } from './nodes/rasterDecode';
import { decodeBrightDarkMasks, decodeRgbaRaster } from './nodes/rasterBinary';
import { runExplicitInsetsViewport } from './nodes/viewportExplicitInsets';
import { runProductionAutoViewport } from './nodes/viewportProductionAuto';
import type { ViewportCropParameters } from './nodes/viewportTypes';

export interface StepTwoRunOptions {
	readonly ablationId?: string;
	readonly viewportParametersOverride?: ViewportCropParameters;
}

export interface ReplayNodeExecutionSummary {
	readonly nodeId: string;
	readonly nodeType: string;
	readonly invocationKey: string;
	readonly outputHash: string;
	readonly cacheStatus: 'hit' | 'miss';
	readonly runtimeMs: number;
}

export interface StepTwoRunResult {
	readonly runId: string;
	readonly experimentHash: string;
	readonly ablationId: string;
	readonly suiteCaseId: string;
	readonly course: string;
	readonly sourceObjectHash: string;
	readonly viewportParameters: ViewportCropParameters;
	readonly nodes: readonly ReplayNodeExecutionSummary[];
	readonly output: {
		readonly width: number;
		readonly height: number;
		readonly sourceWidth: number;
		readonly sourceHeight: number;
		readonly originY: number;
		readonly brightPixelCount: number;
		readonly darkPixelCount: number;
	};
}

interface NodeDefinition<Parameters> {
	readonly nodeId: string;
	readonly implementation: RegisteredImplementation;
	readonly outputSchemaVersion: number;
	readonly parameters: Parameters;
	readonly relevantEnvironment: unknown;
	readonly execute: (inputs: readonly Buffer[], parameters: Parameters) => Buffer;
}

function packageVersion(name: string): string {
	const require = createRequire(import.meta.url);
	const path = require.resolve(`${name}/package.json`);
	return (JSON.parse(readFileSync(path, 'utf8')) as { version: string }).version;
}

function repoSha(repoRoot: string): string {
	return execFileSync('git', ['rev-parse', 'HEAD'], {
		cwd: repoRoot,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe']
	}).trim();
}

function plainError(error: unknown): { name: string; message: string } {
	return error instanceof Error
		? { name: error.name, message: error.message }
		: { name: 'Error', message: String(error) };
}

function registerImplementations(repoRoot: string): {
	readonly registry: ImplementationRegistry;
	readonly decode: RegisteredImplementation;
	readonly viewports: ReadonlyMap<string, RegisteredImplementation>;
	readonly masks: RegisteredImplementation;
} {
	const registry = new ImplementationRegistry(repoRoot);
	const cpuOnly = (ramMiB: number): ResourceDeclaration => ({
		cpuCores: 1,
		ramMiB,
		gpu: null
	});
	const decode = registry.register({
		id: 'raster.decode.jpeg-js-v1',
		version: '1.0.0',
		nodeType: 'raster.decode',
		language: 'typescript',
		entrypoint: 'scripts/chainspot-lab/nodes/rasterDecode.ts',
		sources: [
			'scripts/chainspot-lab/nodes/rasterDecode.ts',
			'scripts/chainspot-lab/nodes/rasterBinary.ts',
			'scripts/nuthing/decode.ts'
		],
		inputKinds: ['source.raster.jpeg.v1'],
		outputKind: 'raster.rgba.v2',
		resources: cpuOnly(256)
	});
	const explicitViewport = registry.register({
		id: 'viewport.crop.explicit-insets-v1',
		version: '1.0.0',
		nodeType: 'viewport.crop',
		language: 'typescript',
		entrypoint: 'scripts/chainspot-lab/nodes/viewportExplicitInsets.ts',
		sources: [
			'scripts/chainspot-lab/nodes/viewportExplicitInsets.ts',
			'scripts/chainspot-lab/nodes/rasterBinary.ts',
			'src/lib/nuthing/viewport.ts'
		],
		inputKinds: ['raster.rgba.v2'],
		outputKind: 'raster.rgba.v2',
		resources: cpuOnly(256)
	});
	const automaticViewport = registry.register({
		id: 'viewport.crop.production-entropy-v1',
		version: '1.0.0',
		nodeType: 'viewport.crop',
		language: 'typescript',
		entrypoint: 'scripts/chainspot-lab/nodes/viewportProductionAuto.ts',
		sources: [
			'scripts/chainspot-lab/nodes/viewportProductionAuto.ts',
			'scripts/chainspot-lab/nodes/rasterBinary.ts',
			'src/lib/nuthing/viewport.ts',
			'src/lib/stitch/autoCrop.ts'
		],
		inputKinds: ['raster.rgba.v2'],
		outputKind: 'raster.rgba.v2',
		resources: cpuOnly(256)
	});
	const masks = registry.register({
		id: 'mask.bright-dark.opencv-parity-v1',
		version: '1.0.0',
		nodeType: 'mask.bright-dark',
		language: 'typescript',
		entrypoint: 'scripts/chainspot-lab/nodes/brightDarkMasks.ts',
		sources: [
			'scripts/chainspot-lab/nodes/brightDarkMasks.ts',
			'scripts/chainspot-lab/nodes/rasterBinary.ts',
			'src/lib/nuthing/raster.ts'
		],
		inputKinds: ['raster.rgba.v2'],
		outputKind: 'raster.bright-dark-masks.v2',
		resources: cpuOnly(128)
	});
	return {
		registry,
		decode,
		viewports: new Map([
			[explicitViewport.id, explicitViewport],
			[automaticViewport.id, automaticViewport]
		]),
		masks
	};
}

function recordObject(ledger: LabLedger, store: ImmutableObjectStore, hash: string): void {
	ledger.recordObject(store.descriptor(hash), store.relativePath(hash));
}

function executeNode<Parameters>(
	ledger: LabLedger,
	store: ImmutableObjectStore,
	runId: string,
	definition: NodeDefinition<Parameters>,
	inputHashes: readonly string[]
): ReplayNodeExecutionSummary {
	for (const [index, hash] of inputHashes.entries()) {
		const descriptor = store.descriptor(hash);
		const expected = definition.implementation.inputKinds[index];
		if (expected && descriptor.kind !== expected) {
			throw new TypeError(
				`${definition.nodeId} input ${index} expected ${expected}, received ${descriptor.kind}`
			);
		}
	}
	const invocationKey = computeInvocationKey({
		cacheKeySchemaVersion: 1,
		nodeType: definition.implementation.nodeType,
		outputSchemaVersion: definition.outputSchemaVersion,
		implementation: {
			id: definition.implementation.id,
			version: definition.implementation.version,
			sourceDigest: definition.implementation.sourceDigest
		},
		parameters: definition.parameters,
		orderedInputObjectHashes: inputHashes,
		relevantEnvironment: definition.relevantEnvironment
	});
	const started = performance.now();
	const memoryBefore = process.memoryUsage().rss;
	let cacheStatus: 'hit' | 'miss' = 'miss';
	try {
		let outputHash = ledger.getCacheEntry(invocationKey);
		if (outputHash) {
			cacheStatus = 'hit';
			store.descriptor(outputHash); // Full length and digest validation before reuse.
		} else {
			const inputs = inputHashes.map((hash) => store.readBytes(hash));
			const output = definition.execute(inputs, definition.parameters);
			const stored = store.putBytes(definition.implementation.outputKind, output);
			outputHash = stored.descriptor.hash;
			recordObject(ledger, store, outputHash);
			ledger.putCacheEntry(invocationKey, outputHash);
		}
		const runtimeMs = performance.now() - started;
		ledger.recordRunNode({
			runId,
			nodeId: definition.nodeId,
			invocationKey,
			nodeType: definition.implementation.nodeType,
			implementationKey: definition.implementation.implementationKey,
			inputHashes,
			outputHash,
			status: 'completed',
			cacheStatus,
			runtimeMs,
			declaredResources: definition.implementation.resources,
			observedResources: {
				rssBeforeBytes: memoryBefore,
				rssAfterBytes: process.memoryUsage().rss
			}
		});
		return {
			nodeId: definition.nodeId,
			nodeType: definition.implementation.nodeType,
			invocationKey,
			outputHash,
			cacheStatus,
			runtimeMs
		};
	} catch (error) {
		ledger.recordRunNode({
			runId,
			nodeId: definition.nodeId,
			invocationKey,
			nodeType: definition.implementation.nodeType,
			implementationKey: definition.implementation.implementationKey,
			inputHashes,
			status: 'failed',
			cacheStatus,
			runtimeMs: performance.now() - started,
			declaredResources: definition.implementation.resources,
			error: plainError(error)
		});
		throw error;
	}
}

/** Execute the deliberately small Step 2 chain against one resolved corpus ablation. */
export function runStepTwoReplay(config: LabConfig, options: StepTwoRunOptions = {}): StepTwoRunResult {
	const ablation = resolveStepTwoAblation(
		config,
		options.ablationId ?? DEFAULT_STEP_TWO_ABLATION_ID,
		options.viewportParametersOverride
	);
	const store = new ImmutableObjectStore(config.evidenceStore.path);
	const ledger = new LabLedger(config.ledgerPath);
	const registered = registerImplementations(config.repoRoot);
	for (const implementation of registered.registry.list()) ledger.recordImplementation(implementation);

	const sourcePath = ablation.rasterPath;
	const sourceFormat = ablation.definition.suite.case.raster.format;
	const source = store.putBytes(`source.raster.${sourceFormat}.v1`, readFileSync(sourcePath));
	recordObject(ledger, store, source.descriptor.hash);
	const viewportParameters = ablation.definition.viewport.parameters;
	const viewportImplementation = registered.viewports.get(ablation.definition.viewport.implementationId);
	if (!viewportImplementation) {
		throw new Error(`Viewport implementation is not registered: ${ablation.definition.viewport.implementationId}`);
	}
	const decodeParameters: RasterDecodeParameters = { format: sourceFormat };
	const maskParameters: BrightDarkMaskParameters = {
		brightVMin: 210,
		brightSMax: 45,
		darkVMax: 45
	};
	const suite = {
		suiteSchemaVersion: 1,
		...ablation.definition.suite,
		resolvedSource: {
			relativePath: relative(config.corpus.path, sourcePath).split('\\').join('/'),
			objectHash: source.descriptor.hash
		}
	};
	const manifest = {
		manifestSchemaVersion: 1,
		ablationId: ablation.definition.id,
		name: ablation.definition.experimentName,
		nodes: [
			{ nodeType: 'raster.decode', implementation: registered.decode.id, parameters: decodeParameters },
			{ nodeType: 'viewport.crop', implementation: viewportImplementation.id, parameters: viewportParameters },
			{ nodeType: 'mask.bright-dark', implementation: registered.masks.id, parameters: maskParameters }
		]
	};
	const registryResolution = [registered.decode, viewportImplementation, registered.masks];
	const suiteObject = store.putJson('lab.suite.resolved.v1', suite);
	const manifestObject = store.putJson('lab.manifest.resolved.v1', manifest);
	recordObject(ledger, store, suiteObject.descriptor.hash);
	recordObject(ledger, store, manifestObject.descriptor.hash);
	const experimentHash = computeExperimentHash({
		experimentHashSchemaVersion: 1,
		resolvedManifest: manifest,
		resolvedSuite: suite,
		registryResolution
	});
	ledger.recordExperiment({
		experimentHash,
		resolvedManifestObjectHash: manifestObject.descriptor.hash,
		resolvedSuiteObjectHash: suiteObject.descriptor.hash,
		registryResolution
	});
	const doctor = collectDoctorReport(config, ablation.definition.id);
	const runId = ledger.startRun({
		experimentHash,
		repoSha: repoSha(config.repoRoot),
		hostSnapshot: doctor
	});
	try {
		const nodeVersion = process.versions.node;
		const decode = executeNode(ledger, store, runId, {
			nodeId: 'raster.decode',
			implementation: registered.decode,
			outputSchemaVersion: 2,
			parameters: decodeParameters,
			relevantEnvironment: {
				nodeVersion,
				jpegJsVersion: packageVersion('jpeg-js'),
				pngjsVersion: packageVersion('pngjs')
			},
			execute: (inputs, parameters) => runRasterDecode(inputs[0], parameters)
		}, [source.descriptor.hash]);
		const viewport = executeNode(ledger, store, runId, {
			nodeId: 'viewport.crop',
			implementation: viewportImplementation,
			outputSchemaVersion: 2,
			parameters: viewportParameters,
			relevantEnvironment: { nodeVersion },
			execute: (inputs, parameters) =>
				parameters.strategy === 'explicit-insets'
					? runExplicitInsetsViewport(inputs[0], parameters).bytes
					: runProductionAutoViewport(inputs[0], parameters).bytes
		}, [decode.outputHash]);
		const masks = executeNode(ledger, store, runId, {
			nodeId: 'mask.bright-dark',
			implementation: registered.masks,
			outputSchemaVersion: 2,
			parameters: maskParameters,
			relevantEnvironment: { nodeVersion },
			execute: (inputs) => runBrightDarkMasks(inputs[0])
		}, [viewport.outputHash]);
		ledger.finishRun(runId, 'completed');
		const cropped = decodeRgbaRaster(store.readBytes(viewport.outputHash));
		const maskPayload = decodeBrightDarkMasks(store.readBytes(masks.outputHash));
		return {
			runId,
			experimentHash,
			ablationId: ablation.definition.id,
			suiteCaseId: ablation.definition.suite.case.id,
			course: ablation.definition.suite.case.course,
			sourceObjectHash: source.descriptor.hash,
			viewportParameters,
			nodes: [decode, viewport, masks],
			output: {
				width: cropped.width,
				height: cropped.height,
				sourceWidth: cropped.frame.sourceWidth,
				sourceHeight: cropped.frame.sourceHeight,
				originY: cropped.frame.originY,
				brightPixelCount: maskPayload.bright.reduce((sum, value) => sum + value, 0),
				darkPixelCount: maskPayload.dark.reduce((sum, value) => sum + value, 0)
			}
		};
	} catch (error) {
		ledger.finishRun(runId, 'failed');
		throw error;
	} finally {
		ledger.close();
	}
}
