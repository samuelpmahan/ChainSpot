import { canonicalJson } from '../detectors/threeFactor/hash';
import type { CompiledExecutionPlan } from './compile';
import type { OperationSpec, TickTestimony } from './contract';
import { sha256HexSyncText } from './sha256';

export interface PcrSpec {
	readonly id: string;
	readonly title: string;
	readonly tickIds: readonly string[];
}

export interface PcrTickCheckpoint {
	readonly operation: OperationSpec;
	readonly testimony: TickTestimony;
}

/**
 * Storybook-facing composition of already-executed Tick testimony.  PCR has
 * deliberately no run() method: the production gateway is the only execution
 * authority and hands this function the receipts it already produced.
 */
export interface Pcr {
	readonly schema: 'chainspot-pcr@1';
	readonly id: string;
	readonly title: string;
	readonly planFingerprint: string;
	readonly paramsHash: string | null;
	readonly runResultId: string;
	/** Explicitly bounded: opaque PxC values are not silently claimed as content-frozen. */
	readonly runResultIdentityScope: 'tick-testimony-and-materializations';
	readonly runResultIdentityLimitation: 'opaque PxC output values require an emitted Materialization';
	readonly ticks: readonly PcrTickCheckpoint[];
}

function frozenTickIdentity(tick: TickTestimony) {
	return {
		opId: tick.opId,
		frozenCalculations: tick.frozenCalculations,
		actualConsumes: tick.actualConsumes,
		actualProduces: tick.actualProduces,
		writes: tick.writes,
		artifacts: tick.artifacts.map((artifact) => ({
			id: artifact.id,
			kind: artifact.kind,
			sha256: artifact.sha256,
			dims: artifact.dims ?? null
		}))
	};
}

export function composePcr(
	spec: PcrSpec,
	plan: CompiledExecutionPlan,
	testimony: readonly TickTestimony[]
): Pcr {
	if (spec.tickIds.length === 0) throw new Error(`PCR '${spec.id}' requires at least one Tick.`);
	const operationById = new Map(plan.ops.map((operation) => [operation.id, operation]));
	const testimonyById = new Map(testimony.map((tick) => [tick.opId, tick]));
	const seen = new Set<string>();
	const ticks = spec.tickIds.map((tickId) => {
		if (seen.has(tickId)) throw new Error(`PCR '${spec.id}' names Tick '${tickId}' twice.`);
		seen.add(tickId);
		const operation = operationById.get(tickId);
		if (!operation) throw new Error(`PCR '${spec.id}' has no planned Tick '${tickId}'.`);
		const tick = testimonyById.get(tickId);
		if (!tick) throw new Error(`PCR '${spec.id}' Tick '${tickId}' never ran.`);
		return { operation, testimony: tick };
	});
	const paramsHash = plan.paramsHash ?? null;
	const runResultId = sha256HexSyncText(
		canonicalJson({
			planFingerprint: plan.planFingerprint,
			paramsHash,
			ticks: ticks.map(({ testimony: tick }) => frozenTickIdentity(tick))
		})
	);
	return {
		schema: 'chainspot-pcr@1',
		id: spec.id,
		title: spec.title,
		planFingerprint: plan.planFingerprint,
		paramsHash,
		runResultId,
		runResultIdentityScope: 'tick-testimony-and-materializations',
		runResultIdentityLimitation: 'opaque PxC output values require an emitted Materialization',
		ticks
	};
}

/** View identity is a pure projection of a frozen PCR; it cannot execute CV. */
export function pcrRenderId(pcr: Pcr, viewArgs: Readonly<Record<string, unknown>>): string {
	return sha256HexSyncText(canonicalJson({ runResultId: pcr.runResultId, viewArgs }));
}
