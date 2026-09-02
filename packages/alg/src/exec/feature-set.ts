import type {
	ABFeature,
	FeatureContext,
	ResolvedFeature
} from '../detectors/threeFactor/features/types';
import { defaultKnobs } from '../detectors/threeFactor/features/types';
import { canonicalJson } from '../detectors/threeFactor/hash';
import type { ExecBoard } from './board';
import { validateOperationOrder, type CompiledExecutionPlan } from './compile';
import type { OperationSpec, Receipt, SlotRef } from './contract';
import {
	executeCompiledPlanAsync,
	type CalculationBinding,
	type OperationArtifact,
	type OperationImpl,
	type OperationRuntime
} from './gateway';
import { sha256HexSyncText } from './sha256';
import type { ExecSink } from './sink';
import { createMemorySink } from './sink';

export interface ABFeatureOperation {
	readonly spec: OperationSpec;
	readonly run: OperationImpl;
	/** Runtime bodies corresponding exactly to spec.calculations, for frozen fn.* testimony. */
	readonly calculationBindings?: readonly CalculationBinding[];
	readonly extractArtifacts?: (board: ExecBoard) => readonly OperationArtifact[];
}

/**
 * An executable operation owned by a set's composition boundary. Gate sets
 * express composition, not execution scheduling; `spec.features` remains the
 * honest list of every ABFeature the implementation reads.
 */
export interface ABFeatureSetOperation {
	readonly operation: ABFeatureOperation;
}

/**
 * A named piece of set-owned infrastructure. Services are intentionally
 * descriptors only: the set records semantic ownership, while the production
 * runtime owns construction/lifetime of any corresponding run-scoped object.
 * In particular, this is not an ABFeature and cannot become an execution
 * operation by appearing in a set.
 */
export interface ABFeatureSetServiceDescriptor {
	/** Stable inventory id (for example, `occlusion`). */
	readonly id: string;
	/** Human/tooling vocabulary for the service; never an execution stage id. */
	readonly kind: string;
	/** Services used by one detector run are explicitly marked run-scoped. */
	readonly scope?: 'run';
	readonly note?: string;
}

/** Short name for callers that do not need to spell out "descriptor". */
export type ABFeatureSetService = ABFeatureSetServiceDescriptor;

/** An ordered, executable composition. List order is execution intent. */
export interface ABFeatureSet {
	readonly id: string;
	readonly features: readonly ABFeature[];
	/** Set-owned infrastructure inventory; descriptors do not create runtime objects. */
	readonly services?: readonly ABFeatureSetServiceDescriptor[];
	/**
	 * Feature ids read by this set's operations but owned by another set.
	 * This is an explicit composition contract, distinct from execution order.
	 */
	readonly imports?: readonly string[];
	/**
	 * Owned features with no operation in this set. Their parameter/state may
	 * be consumed by another set's operation, or await a future engine slot.
	 * They remain visible in the compiled feature bindings.
	 */
	readonly locallyOperationlessFeatureIds?: readonly string[];
	/**
	 * Set-owned executable composition. This permits existing ABFeatures to
	 * remain immutable declarations while their production operations are
	 * grouped by an honest ownership boundary rather than a schedule.
	 */
	readonly operations?: readonly ABFeatureSetOperation[];
	readonly seededSlots?: readonly SlotRef[];
	readonly note?: string;
}

export type ABFeatureOverrides = Readonly<
	Record<string, { readonly enabled?: boolean; readonly knobs?: Readonly<Record<string, unknown>> }>
>;

export interface CompiledABFeatureSet {
	readonly definition: ABFeatureSet;
	readonly plan: CompiledExecutionPlan;
	readonly runtime: OperationRuntime;
	readonly enabledFeatureIds: readonly string[];
	/** Stable ids of infrastructure descriptors owned by this set. */
	readonly ownedServiceIds: readonly string[];
}

export interface ABFeatureSetManifest {
	readonly runId: string;
	readonly invocation: string;
	readonly setId: string;
	readonly planFingerprint: string;
	readonly ownedFeatureIds: readonly string[];
	/** Stable ids of set-owned infrastructure descriptors. */
	readonly ownedServiceIds: readonly string[];
	readonly enabledFeatureIds: readonly string[];
	readonly importedFeatureIds: readonly string[];
	readonly locallyOperationlessFeatureIds: readonly string[];
	readonly startedAtMs: number;
	readonly durationMs: number;
	readonly operations: readonly Receipt[];
	/** Deterministic semantic receipt hash; wall-clock fields are intentionally excluded. */
	readonly manifestHash: string;
}

export interface ABFeatureSetRun {
	readonly runId: string;
	readonly invocation: string;
}

function resolveFeature(
	feature: ABFeature,
	override: ABFeatureOverrides[string] | undefined
): ResolvedFeature {
	const knobs = { ...defaultKnobs(feature), ...(override?.knobs ?? {}) };
	for (const [name, value] of Object.entries(knobs)) {
		const spec = feature.knobs[name];
		if (!spec) throw new Error(`ABFeatureSet: feature '${feature.id}' has unknown knob '${name}'.`);
		const error = spec.validate?.(value);
		if (error)
			throw new Error(`ABFeatureSet: feature '${feature.id}' knob '${name}' invalid: ${error}`);
	}
	return { enabled: override?.enabled ?? feature.defaultEnabled, knobs };
}

export function compileABFeatureSet(
	definition: ABFeatureSet,
	overrides: ABFeatureOverrides = {},
	paramsHash?: string
): CompiledABFeatureSet {
	const featureIds = new Set<string>();
	const operationIds = new Set<string>();
	const ops: OperationSpec[] = [];
	const implementations = new Map<string, OperationImpl>();
	const calculationBindings = new Map<string, readonly CalculationBinding[]>();
	const artifactExtractors: Record<string, (board: ExecBoard) => readonly OperationArtifact[]> = {};
	const bindings: Record<string, ResolvedFeature> = {};
	const enabledFeatureIds: string[] = [];
	const setOperations = definition.operations ?? [];
	const services = definition.services ?? [];
	const serviceIds = new Set<string>();
	for (const service of services) {
		if (!service || typeof service.id !== 'string' || service.id.length === 0) {
			throw new Error(`ABFeatureSet '${definition.id}': service id must be a non-empty string.`);
		}
		if (service.id.trim() !== service.id) {
			throw new Error(`ABFeatureSet '${definition.id}': service id '${service.id}' must not have surrounding whitespace.`);
		}
		if (typeof service.kind !== 'string' || service.kind.length === 0) {
			throw new Error(`ABFeatureSet '${definition.id}': service '${service.id}' kind must be a non-empty string.`);
		}
		if (service.kind.trim() !== service.kind) {
			throw new Error(`ABFeatureSet '${definition.id}': service '${service.id}' kind must not have surrounding whitespace.`);
		}
		if (service.scope !== undefined && service.scope !== 'run') {
			throw new Error(`ABFeatureSet '${definition.id}': service '${service.id}' has unsupported scope '${service.scope}'.`);
		}
		if (serviceIds.has(service.id)) {
			throw new Error(`ABFeatureSet '${definition.id}': duplicate service '${service.id}'.`);
		}
		serviceIds.add(service.id);
	}
	const ownedFeatureIds = new Set(definition.features.map((feature) => feature.id));
	const locallyReadFeatureIds = new Set(
		setOperations
			.flatMap(({ operation }) => operation.spec.features ?? [])
			.filter((id) => ownedFeatureIds.has(id))
	);
	const imports = new Set(definition.imports ?? []);
	const locallyOperationlessFeatureIds = new Set(definition.locallyOperationlessFeatureIds ?? []);
	for (const id of imports) {
		if (ownedFeatureIds.has(id)) {
			throw new Error(
				`ABFeatureSet '${definition.id}': import '${id}' is already owned by the set.`
			);
		}
	}
	for (const id of locallyOperationlessFeatureIds) {
		if (!ownedFeatureIds.has(id)) {
			throw new Error(
				`ABFeatureSet '${definition.id}': locally operationless feature '${id}' is not owned by the set.`
			);
		}
	}
	for (const entry of setOperations) {
		for (const dependency of entry.operation.spec.features ?? []) {
			if (!ownedFeatureIds.has(dependency) && !imports.has(dependency)) {
				throw new Error(
					`ABFeatureSet '${definition.id}': operation '${entry.operation.spec.id}' reads '${dependency}' but the set neither owns nor imports it.`
				);
			}
		}
	}

	for (const id of Object.keys(overrides)) {
		if (!definition.features.some((feature) => feature.id === id)) {
			throw new Error(`ABFeatureSet '${definition.id}': override names unknown feature '${id}'.`);
		}
	}

	for (const feature of definition.features) {
		if (featureIds.has(feature.id)) {
			throw new Error(`ABFeatureSet '${definition.id}': duplicate feature '${feature.id}'.`);
		}
		featureIds.add(feature.id);
		const resolved = resolveFeature(feature, overrides[feature.id]);
		bindings[feature.id] = resolved;
		if (!resolved.enabled) continue;

		const featureOps = feature.operations ?? [];
		if (!featureOps || featureOps.length === 0) {
			if (locallyOperationlessFeatureIds.has(feature.id) || locallyReadFeatureIds.has(feature.id)) {
				enabledFeatureIds.push(feature.id);
				continue;
			}
			throw new Error(
				`ABFeatureSet '${definition.id}': enabled feature '${feature.id}' has no operations.`
			);
		}
		enabledFeatureIds.push(feature.id);
		for (const operation of featureOps) {
			if (operationIds.has(operation.spec.id)) {
				throw new Error(
					`ABFeatureSet '${definition.id}': duplicate operation '${operation.spec.id}'.`
				);
			}
			if (!operation.spec.features?.includes(feature.id)) {
				throw new Error(
					`ABFeatureSet '${definition.id}': operation '${operation.spec.id}' does not name owning feature '${feature.id}'.`
				);
			}
			operationIds.add(operation.spec.id);
			ops.push(operation.spec);
			implementations.set(operation.spec.id, operation.run);
			if (operation.calculationBindings)
				calculationBindings.set(operation.spec.id, operation.calculationBindings);
			if (operation.extractArtifacts)
				artifactExtractors[operation.spec.id] = operation.extractArtifacts;
		}
	}

	// Set-owned operations are a complete production composition and run in
	// the declaration's fixed order, independent of feature enablement. The
	// saved config remains the sole source of execution scheduling.
	for (const { operation } of setOperations) {
		if (operationIds.has(operation.spec.id)) {
			throw new Error(
				`ABFeatureSet '${definition.id}': duplicate operation '${operation.spec.id}'.`
			);
		}
		operationIds.add(operation.spec.id);
		ops.push(operation.spec);
		implementations.set(operation.spec.id, operation.run);
		if (operation.calculationBindings)
			calculationBindings.set(operation.spec.id, operation.calculationBindings);
		if (operation.extractArtifacts)
			artifactExtractors[operation.spec.id] = operation.extractArtifacts;
	}

	validateOperationOrder(
		ops,
		definition.seededSlots ?? [],
		`ABFeatureSet '${definition.id}' compile`
	);
	const planFingerprint = sha256HexSyncText(
		canonicalJson({
			setId: definition.id,
			features: definition.features.map((feature) => ({
				id: feature.id,
				resolved: bindings[feature.id]
			})),
			...(services.length
				? {
						services: services.map((service) => ({
							id: service.id,
							kind: service.kind,
							...(service.scope ? { scope: service.scope } : {}),
							...(service.note ? { note: service.note } : {})
						}))
				}
				: {}),
			imports: definition.imports ?? [],
			locallyOperationlessFeatureIds: definition.locallyOperationlessFeatureIds ?? [],
			operations: ops,
			seededSlots: definition.seededSlots ?? []
		})
	);
	const plan: CompiledExecutionPlan = {
		ops,
		planFingerprint,
		bindings,
		...(paramsHash ? { paramsHash } : {})
	};

	return {
		definition,
		plan,
		runtime: { implementations, calculationBindings, artifactExtractors },
		enabledFeatureIds,
		ownedServiceIds: [...serviceIds]
	};
}

function now(): number {
	return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export async function executeABFeatureSet(
	compiled: CompiledABFeatureSet,
	board: ExecBoard,
	ctx: FeatureContext,
	run: ABFeatureSetRun,
	sink: ExecSink = createMemorySink()
): Promise<ABFeatureSetManifest> {
	const startedAtMs = now();
	const operations = await executeCompiledPlanAsync(
		compiled.plan,
		board,
		ctx,
		sink,
		compiled.runtime
	);
	const durationMs = now() - startedAtMs;
	const semanticReceipt = {
		setId: compiled.definition.id,
		planFingerprint: compiled.plan.planFingerprint,
		ownedFeatureIds: compiled.definition.features.map((feature) => feature.id),
		...(compiled.ownedServiceIds.length
			? { ownedServiceIds: compiled.ownedServiceIds }
			: {}),
		enabledFeatureIds: compiled.enabledFeatureIds,
		importedFeatureIds: compiled.definition.imports ?? [],
		locallyOperationlessFeatureIds: compiled.definition.locallyOperationlessFeatureIds ?? [],
		operations: operations.map(({ startedAtMs, durationMs, ...receipt }) => {
			void startedAtMs;
			void durationMs;
			return receipt;
		})
	};
	return {
		runId: run.runId,
		invocation: run.invocation,
		...semanticReceipt,
		ownedServiceIds: compiled.ownedServiceIds,
		startedAtMs,
		durationMs,
		operations,
		manifestHash: sha256HexSyncText(canonicalJson(semanticReceipt))
	};
}

function list(values: readonly string[]): string {
	return values.length === 0 ? '(none)' : values.join(', ');
}

export function formatABFeatureSetManifestMarkdown(manifest: ABFeatureSetManifest): string {
	const lines = [
		'# ABFeatureSet Execution Manifest',
		'',
		`- run: \`${manifest.runId}\``,
		`- invocation: \`${manifest.invocation}\``,
		`- set: \`${manifest.setId}\``,
		`- plan fingerprint: \`${manifest.planFingerprint}\``,
		`- manifest hash: \`${manifest.manifestHash}\``,
		`- owned features: ${list(manifest.ownedFeatureIds.map((id) => `\`${id}\``))}`,
		`- owned services: ${list(manifest.ownedServiceIds.map((id) => `\`${id}\``))}`,
		`- enabled features: ${list(manifest.enabledFeatureIds.map((id) => `\`${id}\``))}`,
		`- imported features: ${list(manifest.importedFeatureIds.map((id) => `\`${id}\``))}`,
		`- locally operationless features: ${list(manifest.locallyOperationlessFeatureIds.map((id) => `\`${id}\``))}`,
		`- total time: ${manifest.durationMs.toFixed(3)} ms`,
		''
	];
	for (const operation of manifest.operations) {
		lines.push(
			`## ${operation.opId}`,
			'',
			`- time: ${operation.durationMs.toFixed(3)} ms`,
			`- declared consumes: ${list(operation.declaredConsumes.map((slot) => `\`${slot}\``))}`,
			`- actual consumes: ${list(operation.actualConsumes.map((slot) => `\`${slot}\``))}`,
			`- declared produces: ${list(operation.declaredProduces.map((slot) => `\`${slot}\``))}`,
			`- actual produces: ${list(operation.actualProduces.map((slot) => `\`${slot}\``))}`,
			`- probes: ${
				operation.probes.length === 0
					? '(none)'
					: operation.probes.map((probe) => `\`${probe.name}=${probe.value}\``).join(', ')
			}`,
			`- artifacts: ${
				operation.artifacts.length === 0
					? '(none)'
					: operation.artifacts
							.map((artifact) => `\`${artifact.id} ${artifact.kind} sha256=${artifact.sha256}\``)
							.join(', ')
			}`,
			''
		);
	}
	return lines.join('\n');
}
