// Digit-derived, truth-free hole viewports for `lab scope`.
//
// Only DashsTrack's course manifest carries per-hole sourceBox viewports;
// every other course used to make `lab scope hN` refuse. This module derives
// a viewport from the detector's OWN G1 badge digits instead: run the badge
// stage plus digit reading (fast — no baskets/tees/support field), find the
// badge whose read label equals the requested hole number, and center a
// manifest-shaped box on it. No annotation truth is consulted anywhere, so
// the result carries no TRUTH-TAINT: the digits come from the same detector
// a blind run would use.

import { detectBadges } from '@chainspot/alg/detectors/threeFactor/measure';
import type { BadgeEvidence, RgbaImage } from '@chainspot/alg/detectors/threeFactor/types';

export type BoxTuple = readonly [number, number, number, number];

/** Matches the hand-drawn DashsTrack manifest boxes' typical size; a derived
 * viewport is a starting frame for a human look, not detector geometry. */
export const DEFAULT_DERIVED_BOX_SIZE = 420;

export interface DigitViewportReading {
	readonly detId: string;
	/** Read hole label, or null when digits were unreadable. */
	readonly label: string | null;
	readonly confidence: number;
	/** Badge center in the frame detectBadges ran in (canonical raster). */
	readonly cxPx: number;
	readonly cyPx: number;
	readonly runnerUp?: { readonly label: number; readonly confidence: number };
}

export interface DerivedHoleViewport {
	readonly sourceBox: BoxTuple;
	readonly reading: DigitViewportReading;
	/** Ambiguity/duplicate facts a receipt must not hide. */
	readonly warnings: readonly string[];
}

export function readDigitViewports(image: RgbaImage): DigitViewportReading[] {
	return detectBadges(image).map((badge) => toReading(badge));
}

function toReading(badge: BadgeEvidence): DigitViewportReading {
	const runnerUp = badge.labelCandidates[1];
	return {
		detId: badge.detId,
		label: badge.label,
		confidence: badge.confidence,
		cxPx: badge.cxPx,
		cyPx: badge.cyPx,
		...(runnerUp ? { runnerUp } : {})
	};
}

/**
 * Derive an original-frame sourceBox for one hole from digit readings.
 * `offset` is the G0 single-source offset (canonical = original + offset),
 * so original = canonical − offset. Throws with the full read-label
 * inventory when no badge read as the requested hole — a viewport that
 * cannot be derived must say what WAS read, never silently pick a box.
 */
export function deriveHoleSourceBox(
	readings: readonly DigitViewportReading[],
	hole: number,
	originalDims: { readonly width: number; readonly height: number },
	offset: { readonly xPx: number; readonly yPx: number },
	boxSize: number = DEFAULT_DERIVED_BOX_SIZE
): DerivedHoleViewport {
	const matches = readings
		.filter((reading) => reading.label === String(hole))
		.sort((a, b) => b.confidence - a.confidence);
	if (matches.length === 0) {
		const inventory = readings
			.map((reading) => `${reading.detId}=${reading.label ?? 'UNREAD'}@${reading.confidence.toFixed(3)}`)
			.join(', ');
		throw new Error(
			`lab scope: no badge read as hole ${hole} (digit-derived, truth-free). Read labels: ${inventory || 'none'}.`
		);
	}
	const reading = matches[0];
	const warnings: string[] = [];
	if (matches.length > 1) {
		warnings.push(
			`label ${hole} was read on ${matches.length} badges (${matches
				.map((match) => `${match.detId}@${match.confidence.toFixed(3)}`)
				.join(', ')}); using the highest-confidence one`
		);
	}
	if (reading.runnerUp && reading.confidence - reading.runnerUp.confidence < 0.1) {
		warnings.push(
			`digit read is ambiguous: ${reading.label}@${reading.confidence.toFixed(3)} vs ` +
				`${reading.runnerUp.label}@${reading.runnerUp.confidence.toFixed(3)}`
		);
	}
	const originalX = reading.cxPx - offset.xPx;
	const originalY = reading.cyPx - offset.yPx;
	const half = boxSize / 2;
	const x = Math.max(0, Math.min(originalDims.width - boxSize, originalX - half));
	const y = Math.max(0, Math.min(originalDims.height - boxSize, originalY - half));
	const width = Math.min(boxSize, originalDims.width);
	const height = Math.min(boxSize, originalDims.height);
	return { sourceBox: [x, y, width, height], reading, warnings };
}
