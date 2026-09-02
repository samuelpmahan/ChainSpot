// HEADLESS EVIDENCE CHAIN — the Heritage "ugly case" (owner's deliverable):
// a raw, uncropped 1290x2796 UDisc screenshot, run through the real G0
// crop measure+apply, checked against real Annotation JSON truth.
//
// Heritage's corpus directory holds exactly ONE raw file
// (HeritagePark-full.png) — it is already a single, pre-stitched
// full-course capture, not a multi-tile course. proposeSharedCrop needs
// >=2 same-sized rasters to find the shared chrome band by consensus
// (autoCrop.ts: "under the capture protocol every screenshot is the same
// device/orientation/zoom... chrome is bit-identical... ACROSS CAPTURES"
// — captures, not courses). So this test measures the crop from Heritage
// PLUS a second same-session raw capture (TowneLake, a different course,
// same device/protocol: both exactly 1290x2796) — the approved technique,
// verified during planning: proposeSharedCrop([heritage, townelake])
// returns {top:429, bottom:252, left:0, right:0}, and 2796-429-252=2115,
// matching Heritage's truth-declared canonical dims (1290x2115) exactly.
//
// This test depends on chainspot-corpus, a sibling checkout outside this
// repo (checked out as ../chainspot-corpus) — skipped, not failed,
// when that path isn't present (e.g. CI without the corpus checked out).
import { describe, expect, test } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeNodeFile } from '@chainspot/alg/adapters/node';
import { toGrayRaster } from '@chainspot/alg/g0/inputAsset';
import { applyCrop } from '@chainspot/alg/g0/crop';
import { createLedger, appendEntry } from '@chainspot/alg/g0/ledger';
import { matchTruth, type CanonicalTruth } from '@chainspot/alg/g0/truth';
import type { CanonicalFrame } from '@chainspot/alg/g0/canonicalFrame';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS_ROOT = resolve(HERE, '../../../chainspot-corpus');
const HERITAGE_PNG = join(CORPUS_ROOT, 'dev', 'Heritage', 'HeritagePark-full.png');
const HERITAGE_TRUTH = join(CORPUS_ROOT, 'dev', 'Heritage', 'HeritagePark-full.annotation.json');
const TOWNELAKE_PNG = join(CORPUS_ROOT, 'dev', 'TowneLake', 'TowneLake-full.png');

const corpusAvailable = existsSync(HERITAGE_PNG) && existsSync(HERITAGE_TRUTH) && existsSync(TOWNELAKE_PNG);

describe.skipIf(!corpusAvailable)('G0 evidence chain: Heritage (single-raw-tile crop + truth reconciliation)', () => {
	test('raw 1290x2796 -> crop measured+applied -> canonical 1290x2115 -> reconciled-verified', async () => {
		const heritage = await decodeNodeFile(HERITAGE_PNG);
		const townelake = await decodeNodeFile(TOWNELAKE_PNG);
		const truth: CanonicalTruth = JSON.parse(readFileSync(HERITAGE_TRUTH, 'utf8'));

		console.log('[g0-evidence:heritage] raw frame', {
			widthPx: heritage.widthPx,
			heightPx: heritage.heightPx,
			imageId: heritage.imageId
		});

		// crop MEASURE: consensus from Heritage + a second same-session raw
		// capture (see header comment for why this is the correct technique
		// for a corpus dir holding only one raw file per course)
		const heritageGray = toGrayRaster(heritage);
		const townelakeGray = toGrayRaster(townelake);
		const cropResult = applyCrop([heritageGray, townelakeGray], [{ x: 0, y: 0 }, { x: 0, y: 0 }]);

		expect(cropResult.insets).not.toBeNull();
		console.log('[g0-evidence:heritage] crop transform (ledger entry)', cropResult.insets);

		// crop APPLY already ran (applyCrop did both measure+apply); build the
		// ledger recording that it did
		const ledger = appendEntry(createLedger(), { kind: 'crop', insets: cropResult.insets! });

		const canonicalFrame: Pick<CanonicalFrame, 'imageId' | 'widthPx' | 'heightPx' | 'ledger'> = {
			imageId: heritage.imageId, // no composite step needed for a single tile; the frame's identity is the cropped raw's
			widthPx: cropResult.rasters[0].widthPx,
			heightPx: cropResult.rasters[0].heightPx,
			ledger
		};
		console.log('[g0-evidence:heritage] canonical frame', {
			widthPx: canonicalFrame.widthPx,
			heightPx: canonicalFrame.heightPx
		});

		expect(canonicalFrame.widthPx).toBe(truth.sourceImage.widthPx);
		expect(canonicalFrame.heightPx).toBe(truth.sourceImage.heightPx);
		expect(canonicalFrame.widthPx).toBe(1290);
		expect(canonicalFrame.heightPx).toBe(2115);

		const match = matchTruth(heritage.imageId, canonicalFrame, truth);
		console.log('[g0-evidence:heritage] truth frame', {
			widthPx: truth.sourceImage.widthPx,
			heightPx: truth.sourceImage.heightPx,
			declaredSha256: truth.sourceImage.sha256
		});
		console.log('[g0-evidence:heritage] match level', match);

		expect(match).not.toBeNull();
		expect(match!.level).toBe('reconciled-verified');
	});
});
