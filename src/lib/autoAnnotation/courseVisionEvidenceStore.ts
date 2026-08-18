/**
 * Progressive Course Vision evidence: a pure, framework-free snapshot +
 * reducer over the `CourseVisionEvidenceEvent` contract (see
 * `courseVisionEvidence.ts`). No Svelte imports, no DOM, no domain types --
 * this module is unit-testable in isolation and safe to run on either side
 * of a postMessage boundary.
 *
 * HARD POLICY: this snapshot is transient, retractable DISPLAY state only.
 * It must never be written into `holes`/`AnnotatedHole`/domain state, and no
 * event here -- including `final` -- authorizes a domain mutation. As the
 * plan puts it: evidence = transient/retractable visualization; completed
 * CourseDetectionResult = authoritative domain mutation. Callers that want a
 * real hole must wait for the awaited detection result and go through the
 * existing `applyDetectedPieces` path, exactly as before this module existed.
 */

import {
	HOLE_VISION_STATE_RANK,
	operatorLabel,
	type CourseVisionChannel,
	type CourseVisionEvidenceEvent,
	type EvidenceHoleGeometry,
	type EvidenceLandmarkBatch,
	type HoleVisionState
} from './courseVisionEvidence';

/** Best-known progressive state for one hole, merged monotonically by certainty rank. */
export interface HoleEvidenceEntry {
	readonly holeNumber: number;
	readonly state: HoleVisionState;
	readonly channel: CourseVisionChannel;
	readonly producerLabel: string;
	readonly geometry?: EvidenceHoleGeometry;
	readonly elapsedMs?: number;
}

/** Timing trace, milliseconds since the detection request began. Set at most once per field. */
export interface CourseVisionEvidenceMarks {
	readonly firstCandidateMs?: number;
	readonly firstFastLaneIdentityMs?: number;
	readonly firstOwnedMs?: number;
	readonly firstProvisionalMs?: number;
	readonly finalBurstMs?: number;
}

export interface CourseVisionEvidenceSnapshot {
	/** Latest candidate landmark batch, not yet tied to any hole number. */
	readonly unassigned: EvidenceLandmarkBatch | null;
	readonly holes: ReadonlyMap<number, HoleEvidenceEntry>;
	readonly marks: CourseVisionEvidenceMarks;
	/** Human-readable trace lines, newest last, capped at MAX_LOG_LINES. */
	readonly log: readonly string[];
}

const MAX_LOG_LINES = 200;

export function emptyCourseVisionEvidence(): CourseVisionEvidenceSnapshot {
	return {
		unassigned: null,
		holes: new Map(),
		marks: {},
		log: []
	};
}

function formatElapsed(elapsedMs: number | undefined): string {
	return typeof elapsedMs === 'number' && Number.isFinite(elapsedMs) ? String(Math.round(elapsedMs)) : '–';
}

function logLineFor(event: CourseVisionEvidenceEvent, producerLabel: string): string {
	const scope = typeof event.holeNumber === 'number' ? `H${event.holeNumber}` : 'course';
	return `[${formatElapsed(event.elapsedMs)}ms] ${producerLabel} · ${scope} · ${event.state}`;
}

function appendLog(log: readonly string[], line: string): readonly string[] {
	const next = log.length >= MAX_LOG_LINES ? log.slice(log.length - MAX_LOG_LINES + 1) : log.slice();
	next.push(line);
	return next;
}

/** Field-wise geometry merge: incoming fields overwrite; missing fields keep prior values. */
function mergeGeometry(
	prior: EvidenceHoleGeometry | undefined,
	incoming: EvidenceHoleGeometry | undefined
): EvidenceHoleGeometry | undefined {
	if (!incoming) return prior;
	if (!prior) return incoming;
	return {
		tee: incoming.tee ?? prior.tee,
		badge: incoming.badge ?? prior.badge,
		basket: incoming.basket ?? prior.basket
	};
}

/** Is `holeNumber` a usable positive integer? Defensive -- events ride a postMessage boundary. */
function isValidHoleNumber(holeNumber: unknown): holeNumber is number {
	return typeof holeNumber === 'number' && Number.isFinite(holeNumber) && holeNumber > 0;
}

function isValidState(state: unknown): state is HoleVisionState {
	return typeof state === 'string' && Object.prototype.hasOwnProperty.call(HOLE_VISION_STATE_RANK, state);
}

/**
 * Should an incoming per-hole event replace the current entry for that hole?
 * Monotonic by certainty rank: higher rank always wins, lower rank never
 * regresses the display. At equal rank, latest wins, except `authoritative`
 * always beats `fast-lane` at equal rank (an authoritative confirmation of
 * the same certainty level is stronger evidence than a fast-lane guess).
 */
function shouldReplaceHoleEntry(
	current: HoleEvidenceEntry | undefined,
	incomingState: HoleVisionState,
	incomingChannel: CourseVisionChannel
): boolean {
	if (!current) return true;
	const currentRank = HOLE_VISION_STATE_RANK[current.state];
	const incomingRank = HOLE_VISION_STATE_RANK[incomingState];
	if (incomingRank > currentRank) return true;
	if (incomingRank < currentRank) return false;
	// Equal rank: authoritative beats fast-lane regardless of arrival order;
	// otherwise latest wins.
	if (current.channel === 'fast-lane' && incomingChannel === 'authoritative') return true;
	if (current.channel === 'authoritative' && incomingChannel === 'fast-lane') return false;
	return true;
}

function nextMarks(
	marks: CourseVisionEvidenceMarks,
	event: CourseVisionEvidenceEvent
): CourseVisionEvidenceMarks {
	if (event.state === 'identified' && event.channel === 'fast-lane' && marks.firstFastLaneIdentityMs === undefined) {
		return { ...marks, firstFastLaneIdentityMs: event.elapsedMs };
	}
	if (event.state === 'owned' && marks.firstOwnedMs === undefined) {
		return { ...marks, firstOwnedMs: event.elapsedMs };
	}
	if (event.state === 'provisional' && marks.firstProvisionalMs === undefined) {
		return { ...marks, firstProvisionalMs: event.elapsedMs };
	}
	if (event.state === 'final' && marks.finalBurstMs === undefined) {
		return { ...marks, finalBurstMs: event.elapsedMs };
	}
	return marks;
}

function applyOneEvent(
	snapshot: CourseVisionEvidenceSnapshot,
	event: CourseVisionEvidenceEvent
): CourseVisionEvidenceSnapshot {
	// Defensive: never throw on malformed evidence. Skip anything that
	// doesn't shape up, rather than let a bad producer take down the UI.
	if (!event || typeof event !== 'object') return snapshot;
	if (!isValidState(event.state)) return snapshot;
	if (event.channel !== 'fast-lane' && event.channel !== 'authoritative') return snapshot;
	if (!event.producer || typeof event.producer.name !== 'string') return snapshot;

	const producerLabel = operatorLabel(event.producer);

	if (event.state === 'candidate' && event.landmarks) {
		const firstCandidateMs = snapshot.marks.firstCandidateMs ?? event.elapsedMs;
		const next: CourseVisionEvidenceSnapshot = {
			...snapshot,
			unassigned: event.landmarks,
			marks: { ...snapshot.marks, firstCandidateMs }
		};
		return { ...next, log: appendLog(next.log, logLineFor(event, producerLabel)) };
	}

	if (!isValidHoleNumber(event.holeNumber)) {
		// Per-hole states with no usable hole number carry nothing we can
		// merge -- skip defensively rather than guess.
		return snapshot;
	}

	const current = snapshot.holes.get(event.holeNumber);
	const accept = shouldReplaceHoleEntry(current, event.state, event.channel);
	if (!accept) return snapshot;

	const geometry = mergeGeometry(current?.geometry, event.geometry);
	const entry: HoleEvidenceEntry = {
		holeNumber: event.holeNumber,
		state: event.state,
		channel: event.channel,
		producerLabel,
		geometry,
		elapsedMs: event.elapsedMs ?? current?.elapsedMs
	};
	const holes = new Map(snapshot.holes);
	holes.set(event.holeNumber, entry);

	const marks = nextMarks(snapshot.marks, event);

	const next: CourseVisionEvidenceSnapshot = { ...snapshot, holes, marks };
	return { ...next, log: appendLog(next.log, logLineFor(event, producerLabel)) };
}

/**
 * Merge a batch of evidence events into a snapshot. Pure: returns a new
 * snapshot, never mutates the one it was given. Malformed events are
 * skipped, never thrown -- this rides a postMessage boundary from the CV
 * worker/producers and must not be able to crash the caller.
 */
export function applyCourseVisionEvidence(
	snapshot: CourseVisionEvidenceSnapshot,
	events: readonly CourseVisionEvidenceEvent[]
): CourseVisionEvidenceSnapshot {
	if (!Array.isArray(events) || events.length === 0) return snapshot;
	let next = snapshot;
	for (const event of events) {
		next = applyOneEvent(next, event);
	}
	return next;
}
