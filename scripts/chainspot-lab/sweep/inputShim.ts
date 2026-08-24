// ============================================================================
// B-SHIM -- reads this comment block before touching this file.
// ============================================================================
// Chunk B (G0 intake: packages/alg/src/g0/** driving crop/stitch/composite/
// ledger, plus a real CanonicalInput) is still in flight in this checkout.
// @chainspot/alg/exec's CanonicalInput is currently `unknown` (see
// contract.ts) -- there is nothing to import yet.
//
// Until B lands, `./lab sweep` decodes each input file DIRECTLY with B's own
// Node adapter (@chainspot/alg/adapters/node's decodeNodeFile -- this DID
// land, commit ad6a661) and skips the rest of G0 entirely: no crop, no
// stitch, no composite, no ledger. One input file becomes one image, full
// stop. That is real decode (real bytes, real sha256 imageId, real pixels)
// wearing a fake front door.
//
// The truth-match call below is NOT shimmed -- g0/truth.ts's matchTruth
// also landed (real G0 code, not provisional) and is called here exactly as
// B intends it to be called, with one honest simplification: the ledger
// this shim hands it is always empty (`{ entries: [] }`), because no real
// G0 crop/stitch ran to populate one. That means this shim can only ever
// report 'byte' (raw file bytes hash-equal the truth's declared source
// image) or 'dims-only' (dimensions coincide, ledger proves nothing) --
// never 'reconciled-verified', which requires a real transform record.
// DashsTrack-full.jpg is an unmodified copy of the annotation's original
// capture, so it hits 'byte' today; a course needing a real crop/stitch to
// line up with its truth would show 'dims-only' here, correctly flagged
// with matchTruth's own warning, until B's real intake replaces this shim.
//
// SNAPS OUT WHEN B LANDS: this file's decodeInput() becomes "call B's real
// G0 intake pipeline instead of decodeNodeFile + an empty ledger" and the
// CanonicalInput import in configIo.ts/sweepCli.ts stops being `unknown`.
// Nothing downstream of G0Report should need to change shape.
// ============================================================================

import { decodeNodeFile } from '@chainspot/alg/adapters/node';
import { matchTruth, type CanonicalTruth, type TruthMatch } from '@chainspot/alg/g0/truth';
import type { RgbaImage } from '@chainspot/alg/detectors/threeFactor';

export interface G0Report {
	readonly shimmed: true;
	readonly filePath: string;
	readonly imageId: string;
	readonly widthPx: number;
	readonly heightPx: number;
	readonly sourceByteLength: number;
	/** null when no truth file was supplied to this sweep. */
	readonly truthMatch: TruthMatch | null;
}

export interface DecodedInput {
	readonly report: G0Report;
	/** width/height/data -- what seedBoard (@chainspot/alg/detectors/threeFactor/measure) expects. */
	readonly image: RgbaImage;
}

/** Decode one input file and, if truth was supplied, run the REAL
 * matchTruth against it with an empty ledger (see file header). This is
 * the one function that snaps out wholesale once B's G0 intake lands. */
export async function decodeInput(filePath: string, truth?: CanonicalTruth): Promise<DecodedInput> {
	const asset = await decodeNodeFile(filePath);
	const truthMatch = truth
		? matchTruth(asset.imageId, { imageId: asset.imageId, widthPx: asset.widthPx, heightPx: asset.heightPx, ledger: { entries: [] } }, truth)
		: null;

	const report: G0Report = {
		shimmed: true,
		filePath,
		imageId: asset.imageId,
		widthPx: asset.widthPx,
		heightPx: asset.heightPx,
		sourceByteLength: asset.sourceByteLength,
		truthMatch
	};

	return {
		report,
		image: { width: asset.widthPx, height: asset.heightPx, data: asset.rgba }
	};
}

export function printG0Report(report: G0Report): void {
	console.log('--- G0 intake (SHIMMED -- see scripts/chainspot-lab/sweep/inputShim.ts) ---');
	console.log(`  file:        ${report.filePath}`);
	console.log(`  imageId:     ${report.imageId}`);
	console.log(`  dims:        ${report.widthPx}x${report.heightPx}px (${report.sourceByteLength} bytes on disk)`);
	if (report.truthMatch) {
		const m = report.truthMatch;
		console.log(`  truth match: ${m.level}${m.matchedAgainst ? ` (matched against ${m.matchedAgainst})` : ''}`);
		if (m.warning) console.log(`               WARNING: ${m.warning}`);
	} else {
		console.log('  truth match: (no truth file supplied)');
	}
}
