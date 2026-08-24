// CanonicalTruth — Annotation JSON loaded as native truth (no reshaping),
// plus the C3 match-level rule that says HOW confidently a given
// CanonicalFrame corresponds to a given truth file.
//
// TRUTH FIREWALL: nothing in this file, or anywhere else in G0, ever feeds
// a CanonicalTruth value INTO a measure/decide function (measurePurpleMass,
// proposeSharedCrop, findBestTranslation, traceWalk, findDroplets, or any
// g0/* decide function) as an input that changes their output. Truth is
// evaluation-only: matchTruth below is the only function that reads a
// CanonicalTruth, and it produces a match-level VERDICT, never a value fed
// back into detection. tests/unit/g0TruthFirewall.test.ts proves this by
// running the same CanonicalFrame through every G0 measure/decide function
// twice — once with a CanonicalTruth attached to the surrounding call site,
// once without — and asserting byte-identical production fingerprints.
//
// C3 match levels (owner-ruled):
// - 'byte': the sha256 of an actual file (the raw capture, OR the
//   materialized canonical composite — either is checked) equals the
//   truth's declared sourceImage.sha256 directly. Strongest: no
//   transform's correctness is even in question.
// - 'reconciled-verified': dimensions match AND the frame's ledger shows a
//   real crop/placement transform actually ran to produce those
//   dimensions — not merely asserted. Strong: intake RAN the missing
//   transform and confirmed the frames line up.
// - 'dims-only': dimensions happen to match but no transform is recorded
//   in the ledger — coincidental until proven otherwise. ALWAYS carries a
//   warning; never silently treated as trustworthy.
// - No match at all (dimensions don't agree either): returns null — there
//   is no plausible correspondence between this frame and this truth file.

import type { CanonicalFrame } from './canonicalFrame';

export interface AnnotationPoint {
	readonly xPx: number;
	readonly yPx: number;
}

export interface AnnotationHole {
	readonly id: string;
	readonly number: number;
	readonly shots: readonly unknown[];
	readonly corridorBends: readonly AnnotationPoint[];
	readonly corridorWidthPx: number;
	readonly tee: AnnotationPoint;
	readonly basket: AnnotationPoint;
}

export interface AnnotationSourceImage {
	readonly fileName: string;
	readonly mimeType: string;
	readonly widthPx: number;
	readonly heightPx: number;
	readonly sha256: string;
	readonly bundlePath: string;
}

/** Native Annotation JSON shape (schemaVersion 1), used as truth as-is. */
export interface CanonicalTruth {
	readonly schemaVersion: number;
	readonly sourceImage: AnnotationSourceImage;
	readonly holes: readonly AnnotationHole[];
}

export type TruthMatchLevel = 'byte' | 'reconciled-verified' | 'dims-only';

export interface TruthMatch {
	readonly level: TruthMatchLevel;
	/** which sha256 comparison produced a 'byte' match, when level is 'byte'. */
	readonly matchedAgainst?: 'raw' | 'canonical';
	/** always present when level is 'dims-only' — never treat that level as trustworthy silently. */
	readonly warning?: string;
}

export function matchTruth(
	rawImageSha256: string,
	frame: Pick<CanonicalFrame, 'imageId' | 'widthPx' | 'heightPx' | 'ledger'>,
	truth: CanonicalTruth
): TruthMatch | null {
	if (rawImageSha256 === truth.sourceImage.sha256) {
		return { level: 'byte', matchedAgainst: 'raw' };
	}
	if (frame.imageId === truth.sourceImage.sha256) {
		return { level: 'byte', matchedAgainst: 'canonical' };
	}

	const dimsMatch = frame.widthPx === truth.sourceImage.widthPx && frame.heightPx === truth.sourceImage.heightPx;
	if (!dimsMatch) return null;

	const transformRan = frame.ledger.entries.some((entry) => entry.kind === 'crop' || entry.kind === 'placement');
	if (transformRan) return { level: 'reconciled-verified' };

	return {
		level: 'dims-only',
		warning:
			'Dimensions match the truth source image, but the ledger records no crop or placement transform that produced them — this may be coincidence. Treat this match as unverified.'
	};
}
