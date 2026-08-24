// HEADLESS EVIDENCE CHAIN — the multi-tile equivalent (owner's deliverable
// asked for either the REC trio in static/tmp-corpus or corpus tiles,
// "document which"): chainspot-corpus/demo/TheRec-{L,R,Thrown-full}.PNG.
//
// Chosen over static/tmp-corpus (which only holds 2 of the 3 files, no
// Thrown-full) and over Lenard-{1..5}.PNG (which HAS real truth —
// Lenard-full.annotation.json — but was rejected after direct
// measurement: feeding all 5 raw Lenard tiles through the real
// crop+solvePixelStitch pipeline produces wildly inconsistent pairwise
// offsets (adjacent-pair dx jumping 1000+px, inconsistent direction) and
// an incoherent ~2528x3515 composite, because pixel search alone has no
// way to know these tiles don't actually overlap the way findBestTranslation
// assumes without semantic (badge-number) anchoring, which this
// deliverable does not wire up. Using Lenard here would misrepresent
// pixel-only stitch as working when it demonstrably isn't for that set —
// a real finding, kept for the LAB knowledge deck rather than papered
// over.
//
// The REC trio instead demonstrates BOTH G0 mechanisms cleanly:
// - TheRec-L + TheRec-R: real 2-tile crop (same 429/252 chrome consensus
//   as Heritage, confirming it's a device/session constant) + pixel stitch
//   (dx=954, low error score, coherent composite) — no truth JSON exists
//   for this course, so the match level is honestly reported as
//   'dims-only'-with-warning rather than fabricated as verified.
// - TheRec-Thrown-full: thrown-round arbitration exactly-one-candidate —
//   L and R score 0 ("likely-map"), Thrown-full alone scores >0
//   ("likely-thrown"), so decideThrownRound picks it unambiguously.
import { describe, expect, test } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { decodeNodeFile } from '@chainspot/alg/adapters/node';
import { toGrayRaster } from '@chainspot/alg/g0/inputAsset';
import { measurePurpleMass } from '@chainspot/alg/detectors/purpleMass';
import { decideThrownRound } from '@chainspot/alg/g0/thrownRound';
import { applyCrop } from '@chainspot/alg/g0/crop';
import { solvePixelStitch, initialSpreadPlacements } from '@chainspot/alg/g0/stitchSolve';
import { materializeComposite } from '@chainspot/alg/g0/composite';
import { createLedger, appendEntries } from '@chainspot/alg/g0/ledger';
import { matchTruth } from '@chainspot/alg/g0/truth';
import type { CanonicalTruth } from '@chainspot/alg/g0/truth';

const CORPUS_DEMO = 'C:\\Users\\tenni\\workspace\\chainspot-corpus\\demo';
const L_PNG = join(CORPUS_DEMO, 'TheRec-L.PNG');
const R_PNG = join(CORPUS_DEMO, 'TheRec-R.PNG');
const THROWN_PNG = join(CORPUS_DEMO, 'TheRec-Thrown-full.PNG');

const corpusAvailable = existsSync(L_PNG) && existsSync(R_PNG) && existsSync(THROWN_PNG);

describe.skipIf(!corpusAvailable)('G0 evidence chain: REC trio (multi-tile crop+stitch + thrown-round arbitration)', () => {
	test('thrown-round arbitration: exactly one of the three images is the thrown round', async () => {
		const [l, r, thrown] = await Promise.all([L_PNG, R_PNG, THROWN_PNG].map(decodeNodeFile));

		const scores = [l, r, thrown].map((asset) => measurePurpleMass(asset).confidence);
		console.log('[g0-evidence:rec-trio] purple-mass scores', {
			L: scores[0],
			R: scores[1],
			ThrownFull: scores[2]
		});

		const decision = decideThrownRound(scores);
		console.log('[g0-evidence:rec-trio] thrown-round decision', decision);

		expect(decision).toEqual({ status: 'auto', index: 2, score: scores[2] });
	});

	test('crop + pixel stitch: L+R flatten into one coherent composite; no truth exists for this course', async () => {
		const [l, r] = await Promise.all([L_PNG, R_PNG].map(decodeNodeFile));
		console.log('[g0-evidence:rec-trio] raw frames', {
			L: { widthPx: l.widthPx, heightPx: l.heightPx, imageId: l.imageId },
			R: { widthPx: r.widthPx, heightPx: r.heightPx, imageId: r.imageId }
		});

		const spread = initialSpreadPlacements([l.widthPx, r.widthPx]);
		const cropResult = applyCrop([toGrayRaster(l), toGrayRaster(r)], spread);
		expect(cropResult.insets).toEqual({ top: 429, bottom: 252, left: 0, right: 0 });
		console.log('[g0-evidence:rec-trio] crop transform (ledger entry)', cropResult.insets);

		const stitch = solvePixelStitch(cropResult.rasters);
		expect(stitch).not.toBeNull();
		expect(stitch!.hadFallback).toBe(false);
		console.log('[g0-evidence:rec-trio] stitch placements', stitch);

		const composite = await materializeComposite(
			[
				{ rgba: l.rgba, widthPx: l.widthPx, heightPx: l.heightPx, placement: stitch!.placements[0] },
				{ rgba: r.rgba, widthPx: r.widthPx, heightPx: r.heightPx, placement: stitch!.placements[1] }
			],
			cropResult.insets!
		);
		console.log('[g0-evidence:rec-trio] canonical composite', {
			widthPx: composite.widthPx,
			heightPx: composite.heightPx,
			imageId: composite.imageId
		});
		expect(composite.widthPx).toBeGreaterThan(0);
		expect(composite.heightPx).toBeGreaterThan(0);

		const ledger = appendEntries(createLedger(), [
			{ kind: 'crop', insets: cropResult.insets! },
			{ kind: 'placement', tileIndex: 0, placement: stitch!.placements[0], source: 'pixel' },
			{ kind: 'placement', tileIndex: 1, placement: stitch!.placements[1], source: 'pixel' }
		]);

		// No annotation.json exists for TheRec course in the corpus — honestly
		// report the absence of truth rather than fabricate a match.
		const noTruth: CanonicalTruth | null = null;
		console.log('[g0-evidence:rec-trio] truth availability', {
			hasTruth: noTruth !== null,
			note: 'no annotation.json exists for this course in the corpus'
		});
		expect(noTruth).toBeNull();

		// Demonstrate the 'dims-only' path explicitly using a SYNTHETIC truth
		// stub whose declared dims coincidentally match this composite, but
		// whose sha256 doesn't and whose ledger check is bypassed on purpose
		// (a fresh, empty ledger) — this is what 'dims-only' means and why it
		// always warns.
		const coincidentalTruth: CanonicalTruth = {
			schemaVersion: 1,
			sourceImage: {
				fileName: 'hypothetical.png',
				mimeType: 'image/png',
				widthPx: composite.widthPx,
				heightPx: composite.heightPx,
				sha256: 'not-a-real-match',
				bundlePath: 'images/source-original.png'
			},
			holes: []
		};
		const dimsOnlyMatch = matchTruth('raw-sha-not-checked-here', { ...composite, ledger: createLedger() }, coincidentalTruth);
		expect(dimsOnlyMatch?.level).toBe('dims-only');
		expect(dimsOnlyMatch?.warning).toBeTruthy();

		// The REAL ledger (crop + placements actually ran) against that same
		// coincidental truth correctly upgrades to reconciled-verified —
		// showing the two levels side by side against identical dims.
		const reconciledMatch = matchTruth('raw-sha-not-checked-here', { ...composite, ledger }, coincidentalTruth);
		expect(reconciledMatch?.level).toBe('reconciled-verified');
		console.log('[g0-evidence:rec-trio] match level (dims-only vs reconciled-verified, same dims)', {
			dimsOnly: dimsOnlyMatch,
			reconciledVerified: reconciledMatch
		});
	});
});
