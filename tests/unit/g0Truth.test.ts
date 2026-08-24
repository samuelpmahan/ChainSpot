import { describe, expect, test } from 'vitest';
import { matchTruth, type CanonicalTruth } from '@chainspot/alg/g0/truth';
import { createLedger, appendEntry } from '@chainspot/alg/g0/ledger';

function truth(overrides: Partial<CanonicalTruth['sourceImage']> = {}): CanonicalTruth {
	return {
		schemaVersion: 1,
		sourceImage: {
			fileName: 'course.png',
			mimeType: 'image/png',
			widthPx: 1290,
			heightPx: 2115,
			sha256: 'truth-declared-sha',
			bundlePath: 'images/source-original.png',
			...overrides
		},
		holes: []
	};
}

describe('matchTruth', () => {
	test('byte: raw file sha256 equals the declared truth sha256', () => {
		const frame = { imageId: 'canonical-hash', widthPx: 1290, heightPx: 2115, ledger: createLedger() };
		expect(matchTruth('truth-declared-sha', frame, truth())).toEqual({ level: 'byte', matchedAgainst: 'raw' });
	});

	test('byte: canonical composite imageId equals the declared truth sha256 (raw does not)', () => {
		const frame = { imageId: 'truth-declared-sha', widthPx: 1290, heightPx: 2115, ledger: createLedger() };
		expect(matchTruth('some-other-raw-sha', frame, truth())).toEqual({
			level: 'byte',
			matchedAgainst: 'canonical'
		});
	});

	test('reconciled-verified: dims match and the ledger shows a crop transform actually ran', () => {
		const ledger = appendEntry(createLedger(), {
			kind: 'crop',
			insets: { top: 429, right: 0, bottom: 252, left: 0 }
		});
		const frame = { imageId: 'unrelated-hash', widthPx: 1290, heightPx: 2115, ledger };
		expect(matchTruth('raw-hash', frame, truth())).toEqual({ level: 'reconciled-verified' });
	});

	test('reconciled-verified: dims match and the ledger shows a placement transform ran', () => {
		const ledger = appendEntry(createLedger(), {
			kind: 'placement',
			tileIndex: 0,
			placement: { x: 0, y: 0 },
			source: 'pixel'
		});
		const frame = { imageId: 'unrelated-hash', widthPx: 1290, heightPx: 2115, ledger };
		expect(matchTruth('raw-hash', frame, truth())).toEqual({ level: 'reconciled-verified' });
	});

	test('dims-only: dims match but the ledger records no transform — always carries a warning', () => {
		const frame = { imageId: 'unrelated-hash', widthPx: 1290, heightPx: 2115, ledger: createLedger() };
		const result = matchTruth('raw-hash', frame, truth());
		expect(result?.level).toBe('dims-only');
		expect(result?.warning).toBeTruthy();
	});

	test('no plausible correspondence: dims differ and no byte match -> null', () => {
		const frame = { imageId: 'unrelated-hash', widthPx: 999, heightPx: 999, ledger: createLedger() };
		expect(matchTruth('raw-hash', frame, truth())).toBeNull();
	});
});
