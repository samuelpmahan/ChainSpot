// BUG (2026-08-29 audit): Scope re-crops canonical rasters -- StripChrome ran
// AGAIN on an already-canonical input, taking a few more rows off a frame
// that was already correct. This pins the fix: an already-canonical file
// (proved via sidecar provenance, never dimensions alone) skips StripChrome
// on a second load, and the readout says so.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { PNG } from 'pngjs';
import {
	canonicalizeInputs,
	canonicalProvenanceSidecarJson
} from '../../scripts/chainspot-lab/sweep/inputShim';

/** Phone-chrome portrait: low-entropy top/bottom bands StripChrome detects
 * and crops, a textured body it leaves alone -- the same shape
 * g0StripChrome.test.ts's fixture uses, encoded as an actual PNG file since
 * canonicalizeInputs() reads files, not raw GrayRaster arrays. */
function writePhoneChromePng(path: string, width = 240, height = 480, chrome = 40): void {
	const png = new PNG({ width, height });
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const inChrome = y < chrome || y >= height - chrome;
			const value = inChrome ? 30 : (x * 17 + y * 13) & 0xff;
			const index = (y * width + x) * 4;
			png.data[index] = value;
			png.data[index + 1] = value;
			png.data[index + 2] = value;
			png.data[index + 3] = 255;
		}
	}
	writeFileSync(path, PNG.sync.write(png));
}

describe('LAB intake: already-canonical input detection', () => {
	test('a raw capture with real chrome is stripped normally', async () => {
		const root = mkdtempSync(join(tmpdir(), 'lab-intake-'));
		const rawPath = join(root, 'raw.png');
		writePhoneChromePng(rawPath);
		const { report } = await canonicalizeInputs([rawPath]);
		expect(report.alreadyCanonicalInput).toBe(false);
		expect(report.stripChrome.insets).not.toBeNull();
		expect(report.heightPx).toBeLessThan(480);
	});

	test('re-feeding the canonical output WITH its provenance sidecar skips StripChrome and preserves dimensions', async () => {
		const root = mkdtempSync(join(tmpdir(), 'lab-intake-'));
		const rawPath = join(root, 'raw.png');
		writePhoneChromePng(rawPath);
		const first = await canonicalizeInputs([rawPath]);

		const canonicalPath = join(root, 'g0.canonical.png');
		const canonicalPng = new PNG({ width: first.image.width, height: first.image.height });
		canonicalPng.data.set(first.image.data);
		writeFileSync(canonicalPath, PNG.sync.write(canonicalPng));
		writeFileSync(
			`${canonicalPath}.json`,
			canonicalProvenanceSidecarJson(first.report.imageId, first.image.width, first.image.height)
		);

		const second = await canonicalizeInputs([canonicalPath]);
		expect(second.report.alreadyCanonicalInput).toBe(true);
		expect(second.report.stripChrome.insets).toBeNull();
		// The load-bearing assertion: a second pass must not shrink the frame
		// the first pass already produced (the "4px frame lie").
		expect(second.report.widthPx).toBe(first.report.widthPx);
		expect(second.report.heightPx).toBe(first.report.heightPx);
	});

	test('the same canonical file WITHOUT a sidecar is not trusted (no dimensions-only guess)', async () => {
		const root = mkdtempSync(join(tmpdir(), 'lab-intake-'));
		const rawPath = join(root, 'raw.png');
		writePhoneChromePng(rawPath);
		const first = await canonicalizeInputs([rawPath]);

		const canonicalPath = join(root, 'g0.canonical.png');
		const canonicalPng = new PNG({ width: first.image.width, height: first.image.height });
		canonicalPng.data.set(first.image.data);
		writeFileSync(canonicalPath, PNG.sync.write(canonicalPng));
		// Deliberately no sidecar written here.

		const second = await canonicalizeInputs([canonicalPath]);
		expect(second.report.alreadyCanonicalInput).toBe(false);
	});

	test('a mismatched sidecar (wrong imageId) is not trusted', async () => {
		const root = mkdtempSync(join(tmpdir(), 'lab-intake-'));
		const rawPath = join(root, 'raw.png');
		writePhoneChromePng(rawPath);
		const first = await canonicalizeInputs([rawPath]);

		const canonicalPath = join(root, 'g0.canonical.png');
		const canonicalPng = new PNG({ width: first.image.width, height: first.image.height });
		canonicalPng.data.set(first.image.data);
		writeFileSync(canonicalPath, PNG.sync.write(canonicalPng));
		writeFileSync(
			`${canonicalPath}.json`,
			canonicalProvenanceSidecarJson('0'.repeat(64), first.image.width, first.image.height)
		);

		const second = await canonicalizeInputs([canonicalPath]);
		expect(second.report.alreadyCanonicalInput).toBe(false);
	});
});
