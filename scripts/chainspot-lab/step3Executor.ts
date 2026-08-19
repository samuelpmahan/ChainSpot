import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import type { LabConfig } from './config';
import { computeExperimentHash } from './core/hashing';
import type { EntityRef } from './core/identity';
import { LabLedger } from './core/ledger';
import { ImmutableObjectStore } from './core/objectStore';
import { collectDoctorReport } from './doctor';
import {
	executeNode,
	packageVersion,
	recordObject,
	registerImplementations,
	repoSha,
	type ReplayNodeExecutionSummary
} from './executor';
import { runBadgesDetect } from './nodes/badgesDetect';
import { runBasketsSpriteMatch } from './nodes/basketsSpriteMatch';
import { runBrightComponents } from './nodes/brightComponents';
import { runBrightDarkMasks, type BrightDarkMaskParameters } from './nodes/brightDarkMasks';
import { runChromeNone } from './nodes/chromeNone';
import { runChromeScreenSpace } from './nodes/chromeScreenSpace';
import {
	runEndpointEvaluation,
	type EndpointEvaluationParameters,
	type EndpointEvaluationObjectV1,
	type EndpointTruthObjectV1
} from './nodes/endpointEvaluate';
import type {
	BadgesObjectV1,
	BasketsObjectV1,
	BrightComponentsObjectV1,
	ChromeAttributionObjectV1,
	TeeCandidatesObjectV1
} from './nodes/endpointTypes';
import { runRasterDecode, type RasterDecodeParameters } from './nodes/rasterDecode';
import { runProductionAutoViewport } from './nodes/viewportProductionAuto';
import { runTeesCandidates } from './nodes/teesCandidates';
import {
	resolveStepThreeAblation,
	type ChromeImplementationId,
	STEP_THREE_ABLATION_ID
} from './step3Suite';

export interface StepThreeRunOptions {
	readonly chromeImplementationId?: ChromeImplementationId;
	readonly progress?: (event: StepThreeProgressEvent) => void;
}

export interface StepThreeProgressEvent {
	readonly caseId: string;
	readonly nodeType: string;
	readonly cacheStatus: 'hit' | 'miss';
}

export interface StepThreeCaseResult {
	readonly caseId: string;
	readonly course: string;
	readonly nodes: readonly ReplayNodeExecutionSummary[];
	readonly evaluationObjectHash: string;
	readonly evaluation: EndpointEvaluationObjectV1;
	readonly historicalReference: {
		readonly source: string;
		readonly rasterDecode: string;
		readonly matches: boolean;
		readonly expected: { readonly raw: number; readonly chromeSuppressed: number; readonly free: number; readonly teeRecall: number };
	} | null;
}

export interface StepThreeRunResult {
	readonly runId: string;
	readonly experimentHash: string;
	readonly ablationId: typeof STEP_THREE_ABLATION_ID;
	readonly chromeImplementationId: ChromeImplementationId;
	readonly cases: readonly StepThreeCaseResult[];
	readonly cache: { readonly hits: number; readonly misses: number };
}

function json<T>(store: ImmutableObjectStore, hash: string): T {
	return store.readJson<T>(hash);
}

function ref(producerObjectHash: string, localId: string): EntityRef {
	return { producerObjectHash, localId };
}

function recordEntities(
	ledger: LabLedger,
	store: ImmutableObjectStore,
	runId: string,
	nodeIds: Record<'components' | 'badges' | 'baskets' | 'chrome' | 'tees', string>,
	hashes: Record<'components' | 'badges' | 'baskets' | 'chrome' | 'tees', string>
): void {
	const components = json<BrightComponentsObjectV1>(store, hashes.components);
	const badges = json<BadgesObjectV1>(store, hashes.badges);
	const baskets = json<BasketsObjectV1>(store, hashes.baskets);
	const chrome = json<ChromeAttributionObjectV1>(store, hashes.chrome);
	const tees = json<TeeCandidatesObjectV1>(store, hashes.tees);
	const componentRefs = new Map<string, EntityRef>();
	for (const component of components.components) {
		const entity = ref(hashes.components, component.localId);
		componentRefs.set(component.localId, entity);
		ledger.recordEntity(entity, 'bright-component', component);
		ledger.linkRunNodeEntity(runId, nodeIds.components, entity);
	}
	for (const badge of badges.badges) {
		const entity = ref(hashes.badges, badge.localId);
		ledger.recordEntity(entity, 'badge', badge);
		ledger.linkRunNodeEntity(runId, nodeIds.badges, entity);
		const parent = componentRefs.get(badge.componentLocalId);
		if (!parent) throw new Error(`Badge parent component is missing: ${badge.componentLocalId}`);
		ledger.recordEntityLineage(entity, parent, 'classified-from-component');
	}
	for (const basket of baskets.baskets) {
		const entity = ref(hashes.baskets, basket.localId);
		ledger.recordEntity(entity, 'basket-sprite-match', basket);
		ledger.linkRunNodeEntity(runId, nodeIds.baskets, entity);
		for (const localId of basket.supportingComponentLocalIds) {
			const parent = componentRefs.get(localId);
			if (parent) ledger.recordEntityLineage(entity, parent, 'supported-by-component');
		}
	}
	const chromeRefs = new Map<string, EntityRef>();
	for (const region of chrome.regions) {
		const entity = ref(hashes.chrome, region.localId);
		chromeRefs.set(region.localId, entity);
		ledger.recordEntity(entity, 'screen-chrome-region', region);
		ledger.linkRunNodeEntity(runId, nodeIds.chrome, entity);
		for (const localId of region.componentLocalIds) {
			const parent = componentRefs.get(localId);
			if (parent) ledger.recordEntityLineage(entity, parent, 'groups-component');
		}
	}
	const ringRefs = new Map<string, EntityRef>();
	for (const ring of tees.rings) {
		const entity = ref(hashes.tees, ring.localId);
		ringRefs.set(ring.localId, entity);
		ledger.recordEntity(entity, 'tee-ring-hypothesis', ring);
		ledger.linkRunNodeEntity(runId, nodeIds.tees, entity);
		for (const localId of ring.supportingComponentLocalIds) {
			const parent = componentRefs.get(localId);
			if (parent) ledger.recordEntityLineage(entity, parent, 'supported-by-component');
		}
	}
	const freeIds = new Set(tees.candidates.map((candidate) => candidate.localId));
	const suppressed = new Map(tees.suppressedCandidates.map((candidate) => [candidate.localId, candidate]));
	for (const candidate of tees.rawCandidates) {
		const suppression = suppressed.get(candidate.localId);
		const entity = ref(hashes.tees, candidate.localId);
		ledger.recordEntity(entity, 'tee-candidate', {
			...candidate,
			status: freeIds.has(candidate.localId) ? 'free' : 'suppressed',
			reasonCode: suppression?.reasonCode ?? null
		});
		ledger.linkRunNodeEntity(runId, nodeIds.tees, entity);
		const origin = candidate.tier === 'ring'
			? ringRefs.get(candidate.originEntityLocalId)
			: componentRefs.get(candidate.originEntityLocalId);
		if (!origin) throw new Error(`Tee candidate origin is missing: ${candidate.originEntityLocalId}`);
		ledger.recordEntityLineage(entity, origin, 'derived-from-origin');
		for (const chromeLocalId of suppression?.chromeRegionLocalIds ?? []) {
			const parent = chromeRefs.get(chromeLocalId);
			if (parent) ledger.recordEntityLineage(entity, parent, 'attributed-to-screen-chrome');
		}
	}
}

function relativeUnix(root: string, path: string): string {
	return relative(root, path).split('\\').join('/');
}

export function runStepThreeBaseline(
	config: LabConfig,
	options: StepThreeRunOptions = {}
): StepThreeRunResult {
	const ablation = resolveStepThreeAblation(config, options.chromeImplementationId);
	const store = new ImmutableObjectStore(config.evidenceStore.path);
	const ledger = new LabLedger(config.ledgerPath);
	const registered = registerImplementations(config.repoRoot);
	for (const implementation of registered.registry.list()) ledger.recordImplementation(implementation);
	const chromeImplementation = registered.chromes.get(ablation.definition.chromeImplementationId);
	if (!chromeImplementation) throw new Error(`Chrome implementation is not registered: ${ablation.definition.chromeImplementationId}`);
	const viewportImplementations = new Map(
		ablation.cases.map((entry) => {
			const implementation = registered.viewports.get(entry.viewport.implementationId);
			if (!implementation) throw new Error(`Viewport implementation is not registered: ${entry.viewport.implementationId}`);
			return [entry.id, implementation] as const;
		})
	);
	const templateObject = store.putJson('baskets.sprite-template.v1', ablation.basketTemplate);
	recordObject(ledger, store, templateObject.descriptor.hash);
	const resolvedCases = ablation.cases.map((caseDefinition) => {
		const source = store.putBytes(`source.raster.${caseDefinition.raster.format}.v1`, readFileSync(caseDefinition.rasterPath));
		recordObject(ledger, store, source.descriptor.hash);
		const truth: EndpointTruthObjectV1 = {
			schemaVersion: 1,
			caseId: caseDefinition.id,
			course: caseDefinition.course,
			evidenceRole: 'calibration',
			source: caseDefinition.truthDefinition,
			holes: caseDefinition.truth
		};
		const truthObject = store.putJson('endpoints.truth.v1', truth);
		recordObject(ledger, store, truthObject.descriptor.hash);
		return { definition: caseDefinition, sourceHash: source.descriptor.hash, truthHash: truthObject.descriptor.hash };
	});
	const maskParameters: BrightDarkMaskParameters = { brightVMin: 210, brightSMax: 45, darkVMax: 45 };
	const evaluationParameters: EndpointEvaluationParameters = { teeTolerancePx: 18, basketTolerancePx: 16 };
	const suite = {
		suiteSchemaVersion: 1,
		name: ablation.definition.suite.name,
		evidenceRole: ablation.definition.suite.evidenceRole,
		referenceBaseline: ablation.definition.suite.referenceBaseline ?? null,
		cases: resolvedCases.map(({ definition, sourceHash, truthHash }) => ({
			id: definition.id,
			course: definition.course,
			raster: { format: definition.raster.format, relativePath: relativeUnix(config.corpus.path, definition.rasterPath), objectHash: sourceHash },
			truth: { source: definition.truthDefinition.source, objectHash: truthHash },
			viewport: definition.viewport
		}))
	};
	const manifest = {
		manifestSchemaVersion: 1,
		ablationId: ablation.definition.id,
		name: ablation.definition.experimentName,
		viewports: resolvedCases.map(({ definition }) => ({ caseId: definition.id, ...definition.viewport })),
		mask: { implementation: registered.masks.id, parameters: maskParameters },
		components: registered.components.id,
		badges: registered.badges.id,
		baskets: { implementation: registered.baskets.id, templateObjectHash: templateObject.descriptor.hash },
		chrome: chromeImplementation.id,
		tees: registered.tees.id,
		evaluation: { implementation: registered.endpointEvaluation.id, parameters: evaluationParameters }
	};
	const decoderImplementations = [...new Set(resolvedCases.map((entry) => entry.definition.raster.format))].map((format) => {
		const implementation = registered.decoders.get(format);
		if (!implementation) throw new Error(`Raster decoder is not registered: ${format}`);
		return implementation;
	});
	const registryResolution = [
		...decoderImplementations,
		...new Map([...viewportImplementations.values()].map((implementation) => [implementation.implementationKey, implementation])).values(),
		registered.masks,
		registered.components,
		registered.badges,
		registered.baskets,
		chromeImplementation,
		registered.tees,
		registered.endpointEvaluation
	];
	const suiteObject = store.putJson('lab.suite.resolved.v1', suite);
	const manifestObject = store.putJson('lab.manifest.resolved.v1', manifest);
	recordObject(ledger, store, suiteObject.descriptor.hash);
	recordObject(ledger, store, manifestObject.descriptor.hash);
	const experimentHash = computeExperimentHash({ experimentHashSchemaVersion: 1, resolvedManifest: manifest, resolvedSuite: suite, registryResolution });
	ledger.recordExperiment({
		experimentHash,
		resolvedManifestObjectHash: manifestObject.descriptor.hash,
		resolvedSuiteObjectHash: suiteObject.descriptor.hash,
		registryResolution
	});
	const runId = ledger.startRun({
		experimentHash,
		repoSha: repoSha(config.repoRoot),
		hostSnapshot: collectDoctorReport(config, STEP_THREE_ABLATION_ID)
	});
	try {
		const caseResults: StepThreeCaseResult[] = [];
		const nodeVersion = process.versions.node;
		for (const resolved of resolvedCases) {
			const caseId = resolved.definition.id;
			const viewportImplementation = viewportImplementations.get(caseId);
			if (!viewportImplementation) throw new Error(`Viewport implementation is not resolved: ${caseId}`);
			const nodeId = (type: string): string => `${caseId}/${type}`;
			const summaries: ReplayNodeExecutionSummary[] = [];
			const add = (summary: ReplayNodeExecutionSummary): ReplayNodeExecutionSummary => {
				summaries.push(summary);
				options.progress?.({ caseId, nodeType: summary.nodeType, cacheStatus: summary.cacheStatus });
				return summary;
			};
			const decoder = registered.decoders.get(resolved.definition.raster.format);
			if (!decoder) throw new Error(`Raster decoder is not registered: ${resolved.definition.raster.format}`);
			const decodeParameters: RasterDecodeParameters = { format: resolved.definition.raster.format };
			const decode = add(executeNode(ledger, store, runId, {
				nodeId: nodeId('raster.decode'), implementation: decoder, outputSchemaVersion: 2,
				parameters: decodeParameters,
				relevantEnvironment: { nodeVersion, jpegJsVersion: packageVersion('jpeg-js'), pngjsVersion: packageVersion('pngjs') },
				execute: (inputs, parameters) => ({ encoding: 'binary', payload: runRasterDecode(inputs[0], parameters) })
			}, [resolved.sourceHash]));
			const viewport = add(executeNode(ledger, store, runId, {
				nodeId: nodeId('viewport.crop'), implementation: viewportImplementation, outputSchemaVersion: 2,
				parameters: resolved.definition.viewport.parameters, relevantEnvironment: { nodeVersion },
				execute: (inputs, parameters) => ({ encoding: 'binary', payload: runProductionAutoViewport(inputs[0], parameters).bytes })
			}, [decode.outputHash]));
			const masks = add(executeNode(ledger, store, runId, {
				nodeId: nodeId('mask.bright-dark'), implementation: registered.masks, outputSchemaVersion: 2,
				parameters: maskParameters, relevantEnvironment: { nodeVersion },
				execute: (inputs) => ({ encoding: 'binary', payload: runBrightDarkMasks(inputs[0]) })
			}, [viewport.outputHash]));
			const components = add(executeNode(ledger, store, runId, {
				nodeId: nodeId('components.bright'), implementation: registered.components, outputSchemaVersion: 1,
				parameters: {}, relevantEnvironment: { nodeVersion },
				execute: (inputs) => ({ encoding: 'json', payload: runBrightComponents(inputs[0]) })
			}, [masks.outputHash]));
			const badges = add(executeNode(ledger, store, runId, {
				nodeId: nodeId('badges.detect'), implementation: registered.badges, outputSchemaVersion: 1,
				parameters: {}, relevantEnvironment: { nodeVersion },
				execute: (inputs) => ({ encoding: 'json', payload: runBadgesDetect(inputs[0], inputs[1]) })
			}, [masks.outputHash, components.outputHash]));
			const baskets = add(executeNode(ledger, store, runId, {
				nodeId: nodeId('baskets.sprite-match'), implementation: registered.baskets, outputSchemaVersion: 1,
				parameters: {}, relevantEnvironment: { nodeVersion },
				execute: (inputs) => ({ encoding: 'json', payload: runBasketsSpriteMatch(inputs[0], inputs[1], inputs[2]) })
			}, [masks.outputHash, components.outputHash, templateObject.descriptor.hash]));
			const chrome = add(executeNode(ledger, store, runId, {
				nodeId: nodeId('chrome.attribute'), implementation: chromeImplementation, outputSchemaVersion: 1,
				parameters: {}, relevantEnvironment: { nodeVersion },
				execute: (inputs) => ({ encoding: 'json', payload: chromeImplementation.id === 'chrome.none' ? runChromeNone(inputs[0]) : runChromeScreenSpace(inputs[0]) })
			}, [components.outputHash]));
			const tees = add(executeNode(ledger, store, runId, {
				nodeId: nodeId('tees.candidates'), implementation: registered.tees, outputSchemaVersion: 1,
				parameters: {}, relevantEnvironment: { nodeVersion },
				execute: (inputs) => ({ encoding: 'json', payload: runTeesCandidates(inputs[0], inputs[1], inputs[2], inputs[3], inputs[4]) })
			}, [masks.outputHash, components.outputHash, badges.outputHash, baskets.outputHash, chrome.outputHash]));
			const evaluation = add(executeNode(ledger, store, runId, {
				nodeId: nodeId('endpoints.evaluate'), implementation: registered.endpointEvaluation, outputSchemaVersion: 1,
				parameters: evaluationParameters, relevantEnvironment: { nodeVersion },
				execute: (inputs, parameters) => ({ encoding: 'json', payload: runEndpointEvaluation(inputs[0], inputs[1], inputs[2], parameters) })
			}, [tees.outputHash, baskets.outputHash, resolved.truthHash]));
			recordEntities(ledger, store, runId, {
				components: nodeId('components.bright'), badges: nodeId('badges.detect'), baskets: nodeId('baskets.sprite-match'), chrome: nodeId('chrome.attribute'), tees: nodeId('tees.candidates')
			}, {
				components: components.outputHash, badges: badges.outputHash, baskets: baskets.outputHash, chrome: chrome.outputHash, tees: tees.outputHash
			});
			const evaluationPayload = json<EndpointEvaluationObjectV1>(store, evaluation.outputHash);
			for (const [name, value] of Object.entries({
				truthCount: evaluationPayload.truthCount,
				rawTeeCandidateCount: evaluationPayload.rawTeeCandidateCount,
				chromeSuppressedCount: evaluationPayload.chromeSuppressedCount,
				freeTeeCandidateCount: evaluationPayload.freeTeeCandidateCount,
				teeRecallCount: evaluationPayload.teeRecallCount,
				basketRecallCount: evaluationPayload.basketRecallCount,
				teeFalsePositiveScreenChrome: evaluationPayload.teeFalsePositiveClasses.screenChrome,
				teeFalsePositiveBasketFurniture: evaluationPayload.teeFalsePositiveClasses.basketFurniture,
				teeFalsePositiveUnexplained: evaluationPayload.teeFalsePositiveClasses.unexplained
			})) ledger.recordMetric({ runId, scopeType: 'suite-case', scopeId: caseId, name, value, unit: 'count' });
			const reference = ablation.definition.suite.referenceBaseline;
			const expected = reference?.cases[caseId];
			caseResults.push({
				caseId,
				course: resolved.definition.course,
				nodes: summaries,
				evaluationObjectHash: evaluation.outputHash,
				evaluation: evaluationPayload,
				historicalReference: reference && expected ? {
					source: reference.source,
					rasterDecode: reference.rasterDecode,
					expected,
					matches:
						evaluationPayload.rawTeeCandidateCount === expected.raw &&
						evaluationPayload.chromeSuppressedCount === expected.chromeSuppressed &&
						evaluationPayload.freeTeeCandidateCount === expected.free &&
						evaluationPayload.teeRecallCount === expected.teeRecall
				} : null
			});
		}
		ledger.finishRun(runId, 'completed');
		const nodes = caseResults.flatMap((entry) => entry.nodes);
		return {
			runId,
			experimentHash,
			ablationId: STEP_THREE_ABLATION_ID,
			chromeImplementationId: ablation.definition.chromeImplementationId,
			cases: caseResults,
			cache: {
				hits: nodes.filter((node) => node.cacheStatus === 'hit').length,
				misses: nodes.filter((node) => node.cacheStatus === 'miss').length
			}
		};
	} catch (error) {
		ledger.finishRun(runId, 'failed');
		throw error;
	} finally {
		ledger.close();
	}
}
