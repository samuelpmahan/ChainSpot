import type {
	AssignmentEvidence,
	RecoveryProvenance,
	TeeEvidence,
	ThreeFactorAssignment
} from './types';
import type { Drawable, GateId, RunTrace, Verdict } from './features/types';

/**
 * Chain-of-custody is observability, not detector behavior.
 *
 * Evidence is never re-scored here and no selection can change.  This module
 * only joins already-retained TeeEvidence, sealed trace testimony, and the
 * final assignment decision into one inspectable record keyed by the opaque
 * tee detId that downstream code already uses.
 */
export const CHAIN_OF_CUSTODY_SCHEMA = 'chainspot-chain-of-custody@1' as const;

export type TeeCustodyOriginKind = 'visible-ring' | 'visible-component' | 'recovered';

export interface TeeCustodyPhysicalSnapshot {
	readonly tier: TeeEvidence['tier'];
	readonly centerXPx: number;
	readonly centerYPx: number;
	readonly bbox: TeeEvidence['bbox'];
	readonly angleRad: number | null;
	readonly area: number;
	readonly fill: number;
	readonly onRing: boolean;
	readonly ring?: TeeEvidence['ring'];
	readonly pad?: TeeEvidence['pad'];
	readonly recovery?: RecoveryProvenance;
}

export interface TeeCustodyTraceEvent {
	readonly kind: 'trace';
	/** Deterministic order in the sealed trace: unit order first, drawable order second. */
	readonly sequence: number;
	readonly unitId: string;
	readonly gate: GateId;
	readonly featureIds: readonly string[];
	readonly verdict: Verdict;
	readonly drawableType: Drawable['type'];
	readonly ref?: string;
	readonly visualRole?: Drawable['visualRole'];
	readonly reason?: string;
	readonly values?: Readonly<Record<string, number>>;
	readonly metadata?: Readonly<Record<string, string>>;
}

export interface TeeCustodyAssignmentEvent {
	readonly kind: 'assignment';
	readonly sequence: number;
	readonly producerUnit: 'assignment' | 'zfit' | 'UNKNOWN';
	readonly hole: string | null;
	readonly badgeId: string;
	readonly basketId: string;
	readonly score: number;
	readonly rank: number;
	readonly ownership: AssignmentEvidence['ownership'];
	readonly alternatives: AssignmentEvidence['alternatives'];
}

export type TeeCustodyEvent = TeeCustodyTraceEvent | TeeCustodyAssignmentEvent;

export interface TeeCustodyRecord {
	/** The exact opaque id used by raw pairs and final assignment, e.g. tee-7. */
	readonly teeId: string;
	readonly originKind: TeeCustodyOriginKind;
	/** Human-readable answer to "what the hell is tee-N?" without opening source. */
	readonly summary: string;
	/** Structured evidence handles retained by the current representation. */
	readonly evidenceRefs: readonly string[];
	/**
	 * Places where the current representation already forgot something useful.
	 * These are first-class output: custody must reveal missing lineage rather
	 * than reconstructing certainty that no longer exists.
	 */
	readonly gaps: readonly string[];
	readonly physical: TeeCustodyPhysicalSnapshot;
	readonly events: readonly TeeCustodyEvent[];
}

export interface ChainOfCustodyLedger {
	readonly schema: typeof CHAIN_OF_CUSTODY_SCHEMA;
	readonly runId?: string;
	readonly imageId?: string;
	readonly paramsHash?: string;
	readonly traceHash?: string;
	readonly traceAvailable: boolean;
	readonly tees: readonly TeeCustodyRecord[];
}

function fixed(value: number): string {
	return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function bboxRef(bbox: TeeEvidence['bbox']): string {
	return `bbox:${bbox.map(fixed).join(',')}`;
}

function ringRef(tee: TeeEvidence): string | null {
	return tee.ring ? `ring:${tee.ring.bbox.map(fixed).join(',')}` : null;
}

/**
 * Current G4 recovery retains the accepted recovery result id only in the
 * provenance note (`teeRecovery support fit <id>:`).  Parse it solely to join
 * historical trace testimony, and report the representation gap loudly.
 * Once RecoveryProvenance grows a structured source ref, this compatibility
 * seam can disappear without changing the custody schema.
 */
function legacyRecoveryResultRef(tee: TeeEvidence): string | null {
	if (tee.tier !== 'recovered' || !tee.recovery) return null;
	const match = /teeRecovery support fit ([^:]+):/.exec(tee.recovery.note);
	return match?.[1] ?? null;
}

function originKind(tee: TeeEvidence): TeeCustodyOriginKind {
	if (tee.tier === 'recovered') return 'recovered';
	if (tee.tier === 'ring') return 'visible-ring';
	return 'visible-component';
}

function evidenceRefs(tee: TeeEvidence): string[] {
	const refs = [`tee:${tee.detId}`, bboxRef(tee.bbox)];
	const ring = ringRef(tee);
	if (ring) refs.push(ring);
	if (tee.pad) refs.push(`bright-component:${tee.pad.componentLabel}`);
	const recoveryRef = legacyRecoveryResultRef(tee);
	if (recoveryRef) refs.push(`tee-recovery-result:${recoveryRef}`);
	return refs;
}

function custodyGaps(tee: TeeEvidence): string[] {
	const gaps: string[] = [];
	if (tee.tier === 'component' && !tee.pad) {
		gaps.push(
			'visible component-tier TeeEvidence no longer retains the source bright-component label; bbox/center/area/fill survive but component identity is UNKNOWN'
		);
	}
	if (tee.tier === 'recovered') {
		if (legacyRecoveryResultRef(tee)) {
			gaps.push(
				'recovery result identity survives only inside RecoveryProvenance.note; custody correlated the trace through the legacy note format rather than a structured source ref'
			);
		} else {
			gaps.push(
				'recovered TeeEvidence has no structured recovery-result ref and its provenance note does not expose one; recovery trace correlation is UNKNOWN'
			);
		}
	}
	return gaps;
}

function summary(tee: TeeEvidence): string {
	const center = `center=(${fixed(tee.xPx)},${fixed(tee.yPx)})`;
	if (tee.tier === 'recovered') {
		const resultRef = legacyRecoveryResultRef(tee) ?? 'UNKNOWN';
		return `${tee.detId}: recovered tee ${center} ${bboxRef(tee.bbox)} via ${tee.recovery?.source ?? 'UNKNOWN'}; recoveryResult=${resultRef}`;
	}
	if (tee.pad) {
		return `${tee.detId}: visible ${tee.tier} tee ${center} ${bboxRef(tee.bbox)}; brightComponent=${tee.pad.componentLabel}`;
	}
	return `${tee.detId}: visible ${tee.tier} tee ${center} ${bboxRef(tee.bbox)}; sourceComponent=UNKNOWN`;
}

function drawableMatchesRef(drawable: Drawable, ref: string): boolean {
	if (drawable.ref === ref || drawable.ref?.startsWith(`${ref}:`)) return true;
	if (drawable.metadata?.targetRef === ref) return true;
	return false;
}

function traceRefs(tee: TeeEvidence): string[] {
	const refs = [tee.detId];
	const recoveryRef = legacyRecoveryResultRef(tee);
	if (recoveryRef) refs.push(recoveryRef);
	return refs;
}

function traceEvents(tee: TeeEvidence, trace: RunTrace | undefined): TeeCustodyTraceEvent[] {
	if (!trace) return [];
	const refs = traceRefs(tee);
	const events: TeeCustodyTraceEvent[] = [];
	for (const [unitIndex, unit] of trace.units.entries()) {
		for (const [drawableIndex, drawable] of unit.drawables.entries()) {
			if (!refs.some((ref) => drawableMatchesRef(drawable, ref))) continue;
			events.push({
				kind: 'trace',
				sequence: unitIndex * 1_000_000 + drawableIndex,
				unitId: unit.id,
				gate: unit.gate,
				featureIds: [...unit.featureIds],
				verdict: drawable.verdict,
				drawableType: drawable.type,
				...(drawable.ref ? { ref: drawable.ref } : {}),
				...(drawable.visualRole ? { visualRole: drawable.visualRole } : {}),
				...(drawable.reason ? { reason: drawable.reason } : {}),
				...(drawable.values ? { values: { ...drawable.values } } : {}),
				...(drawable.metadata ? { metadata: { ...drawable.metadata } } : {})
			});
		}
	}
	return events;
}

function finalAssignmentProducer(trace: RunTrace | undefined): TeeCustodyAssignmentEvent['producerUnit'] {
	if (!trace) return 'UNKNOWN';
	const zfit = [...trace.units].reverse().find((unit) => unit.id === 'zfit');
	if (zfit?.enabled) return 'zfit';
	return trace.units.some((unit) => unit.id === 'assignment') ? 'assignment' : 'UNKNOWN';
}

function assignmentEvent(
	assignment: ThreeFactorAssignment,
	tee: TeeEvidence,
	trace: RunTrace | undefined,
	sequence: number
): TeeCustodyAssignmentEvent | null {
	const selected = assignment.assignments.find((row) => row.teeId === tee.detId);
	if (!selected) return null;
	const badge = assignment.measurement.badges.find((candidate) => candidate.detId === selected.badgeId);
	return {
		kind: 'assignment',
		sequence,
		producerUnit: finalAssignmentProducer(trace),
		hole: badge?.label ?? null,
		badgeId: selected.badgeId,
		basketId: selected.basketId,
		score: selected.score,
		rank: selected.rank,
		ownership: selected.ownership,
		alternatives: selected.alternatives.map((alternative) => ({ ...alternative }))
	};
}

/**
 * Build the first structural custody ledger from one completed detector run.
 * The function is deliberately pure and deterministic; callers can rebuild it
 * from persisted assignment + trace without rerunning CV.
 */
export function buildChainOfCustody(
	assignment: ThreeFactorAssignment,
	trace?: RunTrace
): ChainOfCustodyLedger {
	const tees = [...assignment.tees]
		.sort((a, b) => a.detId.localeCompare(b.detId))
		.map((tee) => {
			const events: TeeCustodyEvent[] = traceEvents(tee, trace);
			const assigned = assignmentEvent(assignment, tee, trace, Number.MAX_SAFE_INTEGER);
			if (assigned) events.push(assigned);
			return {
				teeId: tee.detId,
				originKind: originKind(tee),
				summary: summary(tee),
				evidenceRefs: evidenceRefs(tee),
				gaps: custodyGaps(tee),
				physical: {
					tier: tee.tier,
					centerXPx: tee.xPx,
					centerYPx: tee.yPx,
					bbox: [...tee.bbox] as TeeEvidence['bbox'],
					angleRad: tee.angleRad,
					area: tee.area,
					fill: tee.fill,
					onRing: tee.onRing,
					...(tee.ring ? { ring: { ...tee.ring, bbox: [...tee.ring.bbox] as TeeEvidence['ring'] extends infer R ? R extends { bbox: infer B } ? B : never : never } } : {}),
					...(tee.pad ? { pad: tee.pad } : {}),
					...(tee.recovery ? { recovery: { ...tee.recovery } } : {})
				},
				events
			} satisfies TeeCustodyRecord;
		});

	return {
		schema: CHAIN_OF_CUSTODY_SCHEMA,
		...(trace?.runId ? { runId: trace.runId } : {}),
		...(trace?.imageId ? { imageId: trace.imageId } : {}),
		...(trace?.paramsHash ? { paramsHash: trace.paramsHash } : {}),
		...(trace?.traceHash ? { traceHash: trace.traceHash } : {}),
		traceAvailable: Boolean(trace),
		tees
	};
}

export function findTeeCustody(
	ledger: ChainOfCustodyLedger,
	teeId: string
): TeeCustodyRecord | undefined {
	return ledger.tees.find((record) => record.teeId === teeId);
}
