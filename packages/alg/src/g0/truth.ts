// CanonicalTruth — Annotation JSON loaded as native truth (no reshaping),
// plus the C3 match-level rule that says HOW confidently a given
// CanonicalFrame corresponds to a given truth file.
//
// TRUTH FIREWALL: nothing in this file, or anywhere else in G0, ever feeds
// a CanonicalTruth value INTO a measure/decide function as an input that
// changes production output. Truth is evaluation/assistance metadata only.

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
	/** Optional explicit rendered-number/badge anchor for navigation tooling. */
	readonly numberBadge?: AnnotationPoint;
	/** Backward/alternate spelling accepted when an annotation source owns it. */
	readonly badge?: AnnotationPoint;
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
	readonly matchedAgainst?: 'raw' | 'canonical';
	readonly warning?: string;
}

export function matchTruth(
	rawImageSha256: string,
	frame: Pick<CanonicalFrame, 'imageId' | 'widthPx' | 'heightPx' | 'ledger'>,
	truth: CanonicalTruth
): TruthMatch | null {
	if (rawImageSha256 === truth.sourceImage.sha256) return { level: 'byte', matchedAgainst: 'raw' };
	if (frame.imageId === truth.sourceImage.sha256) return { level: 'byte', matchedAgainst: 'canonical' };
	const dimsMatch = frame.widthPx === truth.sourceImage.widthPx && frame.heightPx === truth.sourceImage.heightPx;
	if (!dimsMatch) return null;
	const transformRan = frame.ledger.entries.some((entry) => entry.kind === 'crop' || entry.kind === 'placement');
	if (transformRan) return { level: 'reconciled-verified' };
	return {
		level: 'dims-only',
		warning: 'Dimensions match the truth source image, but the ledger records no crop or placement transform that produced them — this may be coincidence. Treat this match as unverified.'
	};
}
