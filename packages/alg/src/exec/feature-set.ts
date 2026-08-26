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
	readonly extractArtifacts?: (board: ExecBoard) => readonly OperationArtifact[];
}

/** An ordered, executable composition. List order is execution intent. */
export interface ABFeatureSet {
	readonly id: string;
	readonly features: readonly ABFeature[];
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
}

export interface ABFeatureSetManifest {
	readonly runId: string;
	readonly invocation: string;
	readonly setId: string;
	readonly planFingerprint: string;
	readonly enabledFeatureIds: readonly string[];
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
	const artifactExtractors: Record<string, (board: ExecBoard) => readonly OperationArtifact[]> = {};
	const bindings: Record<string, ResolvedFeature> = {};
	const enabledFeatureIds: string[] = [];

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

		const featureOps = feature.operations;
		if (!featureOps || featureOps.length === 0) {
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
			if (operation.extractArtifacts)
				artifactExtractors[operation.spec.id] = operation.extractArtifacts;
		}
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
		runtime: { implementations, artifactExtractors },
		enabledFeatureIds
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
		enabledFeatureIds: compiled.enabledFeatureIds,
		operations: operations.map(
			({ startedAtMs: _startedAtMs, durationMs: _durationMs, ...receipt }) => receipt
		)
	};
	return {
		runId: run.runId,
		invocation: run.invocation,
		...semanticReceipt,
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
		`- enabled features: ${list(manifest.enabledFeatureIds.map((id) => `\`${id}\``))}`,
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
