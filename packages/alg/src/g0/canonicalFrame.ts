// CanonicalFrame: the settled, post-intake image G0 hands downstream —
// real pixels, a content-addressed identity, and the full ledger of how it
// got there from the raw capture(s).
//
// NAMING NOTE: packages/alg/src/exec/contract.ts (Chunk A, landed as
// commit e46274b) reserves the name `CanonicalInput` as a placeholder
// (`export type CanonicalInput = unknown`) for "resolved config + image +
// params — the thing planFingerprint hashes", explicitly asking consumers
// not to widen it ad hoc. This type is NOT that one: `CanonicalInput` per
// that file's own doc comment also folds in resolved detector CONFIG,
// which is out of scope for G0 (G0 produces the image half only, before
// any detector config is involved). Using a distinct name here avoids
// silently colliding with or narrowing a type Chunk A's compiler still
// owns — reported to the coordinator as the one place the shared contract
// and G0 reality don't overlap 1:1; alignment (e.g. CanonicalFrame
// becoming a field inside a future concrete CanonicalInput) is a follow-up
// once src/exec's compiler settles, not something to force now.

import type { RgbaRaster } from '../detect';
import type { CoordinateTransformLedger } from './ledger';

export interface CanonicalFrame extends RgbaRaster {
	readonly ledger: CoordinateTransformLedger;
}
