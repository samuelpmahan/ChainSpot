// Coordinate-transform ledger: an ordered record of every transform that
// moved a pixel coordinate from its raw, original-image position to its
// final canonical-frame position. Every G0 operation that changes what a
// coordinate means (crop, placement, projection) appends one entry instead
// of silently mutating positions — this is what lets truth matching claim
// 'reconciled-verified' ("we RAN the transform and can show it") rather
// than merely 'dims-only' ("the numbers happen to agree").

import type { CropInsets } from '../raster';
import type { Placement } from './types';

export type LedgerEntry =
	| { readonly kind: 'crop'; readonly insets: CropInsets }
	| {
			readonly kind: 'placement';
			readonly tileIndex: number;
			readonly placement: Placement;
			readonly source: 'spread' | 'semantic' | 'pixel' | 'manual';
	  }
	| {
			readonly kind: 'projection';
			readonly tileIndex: number;
			readonly note: string;
	  };

export interface CoordinateTransformLedger {
	readonly entries: readonly LedgerEntry[];
}

export function createLedger(): CoordinateTransformLedger {
	return { entries: [] };
}

/** Ledgers are immutable — appending returns a new ledger, never mutates. */
export function appendEntry(ledger: CoordinateTransformLedger, entry: LedgerEntry): CoordinateTransformLedger {
	return { entries: [...ledger.entries, entry] };
}

export function appendEntries(
	ledger: CoordinateTransformLedger,
	entries: readonly LedgerEntry[]
): CoordinateTransformLedger {
	return { entries: [...ledger.entries, ...entries] };
}
