// BUILD-2: compileExecutionPlan. C1 ordering semantics, as ruled:
//   - default.json's `execution` list carries the canonical unit ordering
//     intent; a sparse config inherits it, or overrides deliberately.
//   - Dependencies (each operation's consumes/produces) define which
//     orders are LEGAL — enforced below by a single op-level walk.
//   - The resolved config's execution list is what chooses among the
//     legal orders (there is no further search here).
//   - A stable op id is the final deterministic tiebreak. Today, config
//     authoring stays at UNIT granularity (R3: no schema bump) and each
//     unit's internal operation chain is fixed at registration time
//     (UNIT_OPERATIONS in operations.ts), so no compile actually reaches
//     a tie to break — the tiebreak is defined for the day operation-level
//     authoring exists, not exercised today. Said plainly in the Wave 1A
//     report rather than staged as a fake demo.
//
// R3: this intentionally reuses the EXISTING execution surface (an array
// of unit ids) — no schema bump. The operation universe is compiled
// machinery, invisible to config authors.
//
// Synchronous by design: runEngine's existing public contract (and the
// parity-pinned test that calls runThreeFactor synchronously) predates
// this wave and is a hard invariant. Web Crypto's sha256Hex (threeFactor/
// hash.ts) is Promise-based, so planFingerprint uses sha256.ts's
// synchronous digest instead — see that file's header for why, and how it
// was verified against node:crypto before being trusted here.

import type { OperationSpec, SlotRef } from './contract';
import { OPERATION_UNIVERSE, UNIT_OPERATIONS } from './operations';
import type { ResolvedConfig } from '../detectors/threeFactor/config';
import { ALL_FEATURES } from '../detectors/threeFactor/features/registry';
import { canonicalJson } from '../detectors/threeFactor/hash';
import { sha256HexSyncText } from './sha256';

/** Slots the caller seeds onto the board before any operation runs — mirrors engine.ts's SEEDED_SLOTS at operation granularity. */
export const SEEDED_SLOTS: readonly SlotRef[] = [
	'image',
	'localImage',
	'params',
	'viewport',
	'recoveredTees',
	'straightTestTruthAssistance'
];

export interface CompiledExecutionPlan {
	readonly ops: readonly OperationSpec[];
	/** sha256(resolved config + op universe) */
	readonly planFingerprint: string;
	/** featureId -> resolved {enabled, knobs}, for receipts/debugging */
	readonly bindings: Readonly<Record<string, { enabled: boolean; knobs: Record<string, unknown> }>>;
	/** C4's image/params hash; carried through untouched, never derived here */
	readonly paramsHash?: string;
}

function fail(message: string): never {
	throw new Error(`exec compile: ${message}`);
}

export function validateOperationOrder(
	ops: readonly OperationSpec[],
	seededSlots: readonly SlotRef[] = SEEDED_SLOTS,
	errorPrefix = 'exec compile'
): void {
	const available = new Set<SlotRef>(seededSlots);
	for (const op of ops) {
		for (const slot of op.consumes) {
			if (!available.has(slot)) {
				throw new Error(
					`${errorPrefix}: operation '${op.id}' (unit '${op.unit}') consumes '${slot}' but no earlier operation produces it.`
				);
			}
		}
		for (const slot of op.produces) available.add(slot);
	}
}

const specById = new Map(OPERATION_UNIVERSE.map((spec) => [spec.id, spec]));

/** Operations owned only by resolve-only deviations omitted from a sparse
 * config are absent from its fingerprint universe. Explicit configurations
 * still retain those operations and therefore distinct plan identity. */
function resolveOnlyWhenConfigured(spec: OperationSpec, resolved: ResolvedConfig): boolean {
	const omitted = new Set(
		ALL_FEATURES.filter(
			(feature) => feature.resolveOnlyWhenConfigured && resolved.features[feature.id] === undefined
		).map((feature) => feature.id)
	);
	const features = spec.features ?? [];
	return features.length > 0 && features.every((featureId) => omitted.has(featureId));
}

export function compileExecutionPlan(
	resolved: ResolvedConfig,
	paramsHash?: string
): CompiledExecutionPlan {
	// Expand the config's unit-level execution order into the fixed
	// per-unit operation chain (UNIT_OPERATIONS) — this is the config
	// intent choosing among legal unit orders, at the granularity configs
	// actually author.
	const ops: OperationSpec[] = [];
	const seenUnits = new Set<string>();
	for (const unitId of resolved.execution) {
		const opIds = UNIT_OPERATIONS.get(unitId);
		if (!opIds) fail(`execution lists unknown unit '${unitId}'.`);
		if (seenUnits.has(unitId)) fail(`execution lists unit '${unitId}' twice.`);
		seenUnits.add(unitId);
		for (const opId of opIds) {
			const spec = specById.get(opId);
			if (!spec) fail(`unit '${unitId}' references unregistered operation '${opId}'.`);
			ops.push(spec);
		}
	}

	// Dependencies define which orders are legal: walk the fully-expanded
	// operation list and require every consumed slot to already be
	// available (seeded, or produced by an earlier operation — including
	// an earlier operation from the SAME unit, e.g. badgeStage.badges
	// consuming badgeStage.family). This is strictly finer than the old
	// unit-level check it replaces: it also validates that each unit's own
	// internal decomposition is a genuine, satisfiable dependency chain,
	// not just decorative labels (R2).
	validateOperationOrder(ops);

	const bindings: Record<string, { enabled: boolean; knobs: Record<string, unknown> }> = {};
	for (const [id, state] of Object.entries(resolved.features)) bindings[id] = state;

	const fingerprintUniverse = OPERATION_UNIVERSE.filter(
		(spec) => !resolveOnlyWhenConfigured(spec, resolved)
	);
	const planFingerprint = sha256HexSyncText(
		canonicalJson({ resolvedConfig: resolved, opUniverse: fingerprintUniverse })
	);

	return {
		ops,
		planFingerprint,
		bindings,
		...(paramsHash ? { paramsHash } : {})
	};
}
