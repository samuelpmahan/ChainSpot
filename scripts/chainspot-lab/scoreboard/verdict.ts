// Pure, truth-free verdict classification for the `lab digits` scoreboard.
//
// Takes only what `detectBadges` (packages/alg/.../measure.ts) already
// produces per badge — read label, confidence, runner-up — and turns it into
// one of five named verdicts. No Annotation truth is consulted anywhere in
// this module; the badge stage's OWN digit read is the only input, exactly
// like `scope/digitViewport.ts`'s `readDigitViewports`. This file has zero
// corpus/filesystem/detector dependency so it can be unit-tested with
// fabricated readings alone.

export type VerdictKind = 'OK' | 'GARBAGE-LABEL' | 'LOW-CONFIDENCE' | 'COLLISION' | 'UNREAD';

/** The minimal shape `detectBadges`' `BadgeEvidence` already supplies per
 * badge (see `scope/digitViewport.ts`'s `DigitViewportReading` for the same
 * shape used elsewhere in LAB). */
export interface BadgeReadingInput {
	readonly detId: string;
	readonly label: string | null;
	readonly confidence: number;
	readonly runnerUp?: { readonly label: number; readonly confidence: number };
}

export interface BadgeVerdict extends BadgeReadingInput {
	readonly verdict: VerdictKind;
	/** Present only for COLLISION: every OTHER badge that read the same
	 * label, so a receipt never hides who else is involved. */
	readonly collisionParties?: readonly string[];
}

/**
 * Advisory-only confidence floor for LOW-CONFIDENCE. This is a knob, not a
 * detector threshold: it never gates acceptance anywhere else, it only
 * labels a row in this scoreboard. Provenance: every known-good digit read
 * observed across the Dev6 corpus (AlexClark/NorthPark/HeritagePark probes,
 * 2026-08-28) lands at confidence >= 0.979; every known-bad read (garbage
 * multi-digit labels, or Heritage's live "17"/"12" collisions) lands at
 * confidence <= 0.163. 0.5 sits in the open gap between those two clusters
 * with wide margin on both sides — it is not tuned to any single course.
 */
export const DEFAULT_CONFIDENCE_FLOOR = 0.5;

/** Integer hole labels a badge can validly read. Course-derived vocabulary
 * (every Dev6 course is an 18-hole course), not an arbitrary literal. */
const MIN_LABEL = 1;
const MAX_LABEL = 18;

function isValidLabel(label: string): number | undefined {
	if (!/^-?\d+$/.test(label)) return undefined;
	const parsed = Number(label);
	if (!Number.isInteger(parsed) || parsed < MIN_LABEL || parsed > MAX_LABEL) return undefined;
	return parsed;
}

/**
 * Classify every badge reading on one course. Verdict precedence, most to
 * least severe: UNREAD (no read at all) > GARBAGE-LABEL (read something,
 * but not a valid 1-18 integer — e.g. "1868") > COLLISION (two or more
 * badges validly read the SAME label) > LOW-CONFIDENCE (valid, unique, but
 * under the advisory floor) > OK. COLLISION outranks LOW-CONFIDENCE so a
 * duplicate is never silently reported as merely "low confidence" — the
 * confidence itself still prints on every row regardless of verdict.
 */
export function classifyBadges(
	readings: readonly BadgeReadingInput[],
	floor: number = DEFAULT_CONFIDENCE_FLOOR
): BadgeVerdict[] {
	if (!Number.isFinite(floor) || floor < 0 || floor > 1) {
		throw new Error('classifyBadges: floor must be in [0, 1].');
	}
	const parsedByDetId = new Map<string, number>();
	const groups = new Map<number, string[]>();
	for (const reading of readings) {
		if (reading.label === null) continue;
		const parsed = isValidLabel(reading.label);
		if (parsed === undefined) continue;
		parsedByDetId.set(reading.detId, parsed);
		const group = groups.get(parsed) ?? [];
		group.push(reading.detId);
		groups.set(parsed, group);
	}
	return readings.map((reading) => {
		if (reading.label === null) return { ...reading, verdict: 'UNREAD' as const };
		const parsed = parsedByDetId.get(reading.detId);
		if (parsed === undefined) return { ...reading, verdict: 'GARBAGE-LABEL' as const };
		const group = groups.get(parsed) ?? [];
		if (group.length > 1) {
			return {
				...reading,
				verdict: 'COLLISION' as const,
				collisionParties: group.filter((detId) => detId !== reading.detId)
			};
		}
		if (reading.confidence < floor) return { ...reading, verdict: 'LOW-CONFIDENCE' as const };
		return { ...reading, verdict: 'OK' as const };
	});
}

export interface VerdictCounts {
	readonly total: number;
	readonly ok: number;
	readonly garbageLabel: number;
	readonly lowConfidence: number;
	readonly collision: number;
	readonly unread: number;
}

export function countVerdicts(verdicts: readonly BadgeVerdict[]): VerdictCounts {
	const counts: { [K in VerdictKind]: number } = {
		OK: 0,
		'GARBAGE-LABEL': 0,
		'LOW-CONFIDENCE': 0,
		COLLISION: 0,
		UNREAD: 0
	};
	for (const v of verdicts) counts[v.verdict]++;
	return {
		total: verdicts.length,
		ok: counts.OK,
		garbageLabel: counts['GARBAGE-LABEL'],
		lowConfidence: counts['LOW-CONFIDENCE'],
		collision: counts.COLLISION,
		unread: counts.UNREAD
	};
}
