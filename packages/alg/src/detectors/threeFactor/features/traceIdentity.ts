// Deterministic identity for reviewed spatial traces.
//
// Wall-clock spans and heatmap bytes are deliberately excluded: they are not
// semantic testimony and would make the same execution hash differently. The
// payload includes every structured S0 row and drawable, so CLI and visual
// consumers can prove that they read the same reviewed trace.

import { sha256HexSyncText } from '../../../exec/sha256';
import { canonicalJson } from '../hash';
import type { RunTrace, UnitTrace } from './types';

export interface TraceIdentityInput {
	readonly runId: string;
	readonly imageId: string;
}

function unitPayload(unit: UnitTrace): Omit<UnitTrace, 'ms'> {
	const { ms: _ms, ...semantic } = unit;
	return semantic;
}

/** The exact stable payload hashed for trace↔CLI↔Visual correspondence. */
export function semanticTracePayload(trace: RunTrace, identity: TraceIdentityInput): object {
	return {
		schema: 'chainspot-semantic-trace@1',
		runId: identity.runId,
		imageId: identity.imageId,
		configName: trace.configName,
		paramsHash: trace.paramsHash,
		execution: trace.execution,
		features: trace.features,
		units: trace.units.map(unitPayload),
		...(trace.straightTest ? { straightTest: trace.straightTest } : {})
	};
}

export function makeTraceRunId(
	imageId: string,
	paramsHash: string,
	planFingerprint: string
): string {
	return sha256HexSyncText(
		canonicalJson({ schema: 'chainspot-run-id@1', imageId, paramsHash, planFingerprint })
	);
}

/** Return a trace with immutable correspondence identity attached. */
export function sealTrace(trace: RunTrace, identity: TraceIdentityInput): RunTrace {
	const traceHash = sha256HexSyncText(canonicalJson(semanticTracePayload(trace, identity)));
	return { ...trace, ...identity, traceHash };
}
