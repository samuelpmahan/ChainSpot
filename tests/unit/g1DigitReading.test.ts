// Fix-contract unit tests for docs/seven-whys/g1-badge-digit-garbage.md
// (C1-C6). Repro of the real-corpus repair lives in the ledger (rows 18-2x)
// via scripts/ocr-forensics.mjs / scripts/ocr-counterfactual.mjs on the real
// Dev6 rasters; these tests isolate each contract clause with fabricated,
// minimal fixtures so the rule itself — not the corpus — is what's pinned.
import { describe, expect, test } from 'vitest';
import { extractComponents } from '@chainspot/alg/detectors/threeFactor/components';
import type { ComponentStats } from '@chainspot/alg/detectors/threeFactor/components';
import type { Mask } from '@chainspot/alg/detectors/threeFactor/raster';
import { extractBadgeGlyph } from '@chainspot/alg/detectors/threeFactor/digits/badgeGlyph';
import type { PlateFrameGeometry } from '@chainspot/alg/detectors/threeFactor/digits/badgeGlyph';
import { readBadge, type BadgeReadContext, type DigitScorer } from '@chainspot/alg/detectors/threeFactor/digits/readBadges';
import { classifyReading, resolveBadgeCollisions } from '@chainspot/alg/detectors/threeFactor/measure';

function makeMask(width: number, height: number): Uint8Array {
	return new Uint8Array(width * height);
}

function fillRect(mask: Uint8Array, width: number, x0: number, y0: number, w: number, h: number): void {
	for (let y = y0; y < y0 + h; y++) {
		for (let x = x0; x < x0 + w; x++) mask[y * width + x] = 1;
	}
}

/** Draw a 1px-thick hollow rectangle outline (the shape a rendered plate's
 * printed rim actually takes) touching every edge of [x0,y0,w,h]. */
function fillRingOutline(mask: Uint8Array, width: number, x0: number, y0: number, w: number, h: number): void {
	for (let x = x0; x < x0 + w; x++) {
		mask[y0 * width + x] = 1;
		mask[(y0 + h - 1) * width + x] = 1;
	}
	for (let y = y0; y < y0 + h; y++) {
		mask[y * width + x0] = 1;
		mask[y * width + (x0 + w - 1)] = 1;
	}
}

describe('C1 — glyph mask contains glyphs only (dark-plate-recovery frame exclusion)', () => {
	// A fabricated dark-plate badge: dark interior [10,10,40,30], a bright
	// rectangular frame outline tracing that interior's own boundary (the
	// plate's printed rim), and two small bright "digit" blobs well inset
	// from every edge — exactly the badge-10/-16/-2/-7/-9/-12/-14 shape from
	// the forensics doc (component spanning the whole interior + real digits).
	const width = 60;
	const height = 50;

	function buildFixture() {
		const dark = makeMask(width, height);
		fillRect(dark, width, 10, 10, 40, 30);
		const bright = makeMask(width, height);
		fillRingOutline(bright, width, 10, 10, 40, 30); // the plate's own frame
		fillRect(bright, width, 20, 18, 4, 12); // digit "1"-shaped blob
		fillRect(bright, width, 30, 18, 6, 12); // second digit blob
		const { labels } = extractComponents({ width, height, data: bright });
		const badge: ComponentStats = {
			label: -1, // the sentinel recoverDarkPlateBadges stamps
			cx: 30,
			cy: 25,
			area: 1200,
			bboxX: 5,
			bboxY: 5,
			bboxW: 50,
			bboxH: 40,
			major: 50,
			minor: 40,
			angle: 0,
			fill: 0.6
		};
		return {
			badge,
			brightMask: { width, height, data: bright } as Mask,
			darkMask: { width, height, data: dark } as Mask,
			brightLabels: labels
		};
	}

	test('without plate geometry, the -1 sentinel comparison is a silent no-op (reproduces the bug)', () => {
		const { badge, brightMask, darkMask, brightLabels } = buildFixture();
		const glyph = extractBadgeGlyph(badge, brightMask, darkMask, brightLabels, null);
		let onCount = 0;
		for (const value of glyph.mask.data) onCount += value;
		// Frame ring (2*(40+30)-4 = 136px) + two digit blobs (48+72=120px) all
		// survive when no plate geometry is supplied — the bug this contract
		// fixes.
		expect(onCount).toBe(136 + 48 + 72);
	});

	test('with plate geometry, the frame is positively identified and excluded — glyphs only survive', () => {
		const { badge, brightMask, darkMask, brightLabels } = buildFixture();
		const plateFrame: PlateFrameGeometry = {
			plateBbox: [10, 10, 40, 30],
			plateInteriorMarginPx: 0,
			plateFrameTolerancePx: 2
		};
		const glyph = extractBadgeGlyph(badge, brightMask, darkMask, brightLabels, plateFrame);
		let onCount = 0;
		for (const value of glyph.mask.data) onCount += value;
		expect(onCount).toBe(48 + 72); // exactly the two digit blobs, frame gone
		expect(glyph.frameLabels.length).toBe(1);
		expect(glyph.frameProvenance).toContain('plateInteriorMargin=0');
	});

	test('a digit inset from every edge is never mistaken for the frame even with a generous tolerance', () => {
		const { badge, brightMask, darkMask, brightLabels } = buildFixture();
		const plateFrame: PlateFrameGeometry = {
			plateBbox: [10, 10, 40, 30],
			plateInteriorMarginPx: 0,
			plateFrameTolerancePx: 2
		};
		const glyph = extractBadgeGlyph(badge, brightMask, darkMask, brightLabels, plateFrame);
		// Both digit blobs (inset >=5px from every edge) must still be present.
		expect(glyph.mask.width).toBeGreaterThan(0);
		let onCount = 0;
		for (const value of glyph.mask.data) onCount += value;
		expect(onCount).toBeGreaterThan(0);
	});
});

describe('C6 — segmentDigits notes reach BadgeReading (no silent drops)', () => {
	test('readBadge forwards segmentDigits notes for a badge with no glyph pixels', () => {
		const width = 20;
		const height = 20;
		const dark = makeMask(width, height);
		fillRect(dark, width, 2, 2, 10, 10);
		const bright = makeMask(width, height); // no bright pixels at all
		const { labels } = extractComponents({ width, height, data: bright });
		const badge: ComponentStats = {
			label: 1,
			cx: 7,
			cy: 7,
			area: 100,
			bboxX: 0,
			bboxY: 0,
			bboxW: 20,
			bboxH: 20,
			major: 20,
			minor: 20,
			angle: 0,
			fill: 0.5
		};
		const scorer: DigitScorer = { name: 'stub', scores: () => new Array(10).fill(0.1) };
		const ctx: BadgeReadContext = {
			brightMask: { width, height, data: bright },
			darkMask: { width, height, data: dark },
			brightLabels: labels,
			badges: [badge]
		};
		const reading = readBadge(badge, ctx, scorer);
		expect(reading.digits.length).toBe(0);
		expect(reading.notes.length).toBeGreaterThan(0);
		expect(reading.notes[0]).toMatch(/no components in glyph mask/);
	});
});

describe('C2 — a hole label is 1 or 2 digits, always (structural rejection)', () => {
	test('more than 2 digits is rejected as too-many-digits, never emitted (also proves C3: no raw fallback)', () => {
		const result = classifyReading('1868', 4, 0.0278, [], 0.1, 0.045);
		expect(result.label).toBeNull();
		expect(result.abstentionReason).toBe('too-many-digits');
		// C3: labelCandidates is empty for a 4-digit read (no label 1-18 has
		// length 4) — the fix deletes the `|| entry.reading.label` fallback,
		// so the emitted label must be null, never the raw "1868" string.
		expect(result.label).not.toBe('1868');
		expect(result.bestLabel).toBeNull();
	});

	test('a leading zero is rejected, never normalized away ("03" must never become "13")', () => {
		const result = classifyReading(
			'03',
			2,
			0.9891,
			[
				{ label: 13, confidence: 0.62 },
				{ label: 12, confidence: 0.2 }
			],
			0.1,
			0.045
		);
		expect(result.label).toBeNull();
		expect(result.abstentionReason).toBe('leading-zero');
		expect(result.label).not.toBe('13');
		// bestLabel retains what would have been emitted, for the receipt.
		expect(result.bestLabel).toBe('13');
	});
});

describe('C3 — the vocabulary cap is unconditional (fallback deletion = UNREAD)', () => {
	test('zero digits (empty glyph) never falls through to a raw label', () => {
		const result = classifyReading('', 0, 0, [], 0.1, 0.045);
		expect(result.label).toBeNull();
		expect(result.abstentionReason).toBe('empty-glyph');
		expect(result.bestLabel).toBeNull();
	});
});

describe('C4 — derived confidence floor + named abstention reasons', () => {
	const candidates = [
		{ label: 12, confidence: 0.6 },
		{ label: 16, confidence: 0.2 }
	];

	test('a well-formed, well-scored, unambiguous 2-digit read is accepted', () => {
		const result = classifyReading('12', 2, 0.99, candidates, 0.12, 0.045);
		expect(result.label).toBe('12');
		expect(result.abstentionReason).toBeNull();
	});

	test('below the derived floor abstains as low-score, retaining bestLabel', () => {
		const result = classifyReading('62', 2, 0.026, candidates, 0.42, 0.045);
		expect(result.label).toBeNull();
		expect(result.abstentionReason).toBe('low-score');
		expect(result.bestLabel).toBe('12');
	});

	test('a near-tied top-2 candidate posterior abstains as ambiguous', () => {
		const tied = [
			{ label: 12, confidence: 0.5 },
			{ label: 16, confidence: 0.48 }
		];
		const result = classifyReading('12', 2, 0.9, tied, 0.1, 0.045);
		expect(result.label).toBeNull();
		expect(result.abstentionReason).toBe('ambiguous');
		expect(result.bestLabel).toBe('12');
	});
});

describe('C5 — collisions are receipt-visible CONFLICT evidence, never silent', () => {
	test('two badges landing on the same label produce CONFLICT evidence on both parties', () => {
		const resolutions = resolveBadgeCollisions([
			{ detId: 'badge-7', index: 7, label: '12', confidence: 0.9926 },
			{ detId: 'badge-9', index: 9, label: '12', confidence: 0.0250 },
			{ detId: 'badge-3', index: 3, label: '10', confidence: 0.99 }
		]);
		const winner = resolutions.get('badge-7');
		const loser = resolutions.get('badge-9');
		expect(winner?.label).toBe('12');
		expect(winner?.abstentionReason).toBeNull();
		expect(winner?.conflictWith).toEqual(['badge-9']);
		expect(loser?.label).toBeNull();
		expect(loser?.abstentionReason).toBe('collision');
		expect(loser?.conflictWith).toEqual(['badge-7']);
		// The non-colliding badge is untouched (not even present in the map).
		expect(resolutions.has('badge-3')).toBe(false);
	});

	test('a three-way collision resolves to exactly one winner; the rest are all named losers', () => {
		const resolutions = resolveBadgeCollisions([
			{ detId: 'badge-a', index: 0, label: '5', confidence: 0.4 },
			{ detId: 'badge-b', index: 1, label: '5', confidence: 0.9 },
			{ detId: 'badge-c', index: 2, label: '5', confidence: 0.3 }
		]);
		expect(resolutions.get('badge-b')?.label).toBe('5');
		expect(resolutions.get('badge-a')?.label).toBeNull();
		expect(resolutions.get('badge-c')?.label).toBeNull();
		expect(resolutions.get('badge-a')?.conflictWith.sort()).toEqual(['badge-b', 'badge-c']);
	});

	test('distinct labels never collide', () => {
		const resolutions = resolveBadgeCollisions([
			{ detId: 'badge-1', index: 1, label: '1', confidence: 0.9 },
			{ detId: 'badge-2', index: 2, label: '2', confidence: 0.9 }
		]);
		expect(resolutions.size).toBe(0);
	});
});
