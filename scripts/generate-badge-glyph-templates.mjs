#!/usr/bin/env node
// One-off asset baker for packages/alg/src/detectors/threeFactor/assets/
// badge-glyph-templates.json — NOT part of any build or test pipeline, and
// NOT a chainspot-lab surface. Run by hand only when the 18 canonical
// hole-number templates themselves need to be re-baked.
//
// The 18 template PNGs this reads are no longer in the working tree
// (old-stuff/ was removed in 9f4b9e4); they still live in git history at
// commit af85a3e, under old-stuff/static/resources/chainspot_cv_templates/.
// To regenerate:
//   mkdir -p /tmp/badge-templates
//   for f in manifest.json $(printf 'hole-%02d.png\n' $(seq 1 18)); do
//     git show af85a3e:old-stuff/static/resources/chainspot_cv_templates/$f \
//       > /tmp/badge-templates/$f
//   done
//   node scripts/generate-badge-glyph-templates.mjs /tmp/badge-templates
//
// The normalization math below (rawBadgeGlyphMask + tightBounds +
// normalizeBadgeGlyphMask) is a plain-JS mirror of
// packages/alg/src/detectors/threeFactor/digits/badgeGlyphTemplateMath.ts's
// same-named functions -- it MUST stay byte-for-byte identical to that file
// so a re-bake here matches what the runtime candidate-side normalizer
// does. Each template is normalized against its OWN full raster as the
// "badge" (matching the old classifier's own self-test contract), so there
// is nothing badge-crop-specific to share at runtime -- only the resulting
// 18 normalized masks are shipped.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(
	HERE,
	'..',
	'packages/alg/src/detectors/threeFactor/assets/badge-glyph-templates.json'
);

const SOURCE_COMMIT = 'af85a3e';

// --- verbatim mirror of badgeGlyphTemplateMath.ts (see header note) -------

const FOREGROUND_THRESHOLD = 150;
const NORMALIZED_WIDTH_PX = 24;
const NORMALIZED_HEIGHT_PX = 18;

function rgbaAt(image, x, y) {
	const clampedX = Math.max(0, Math.min(image.width - 1, x));
	const clampedY = Math.max(0, Math.min(image.height - 1, y));
	const offset = (clampedY * image.width + clampedX) * 4;
	return [image.data[offset], image.data[offset + 1], image.data[offset + 2]];
}

function brightNeutral(r, g, b, threshold) {
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	return max >= threshold && max - min <= 90;
}

function rawBadgeGlyphMask(image, badge, threshold, sampleWidthPx, sampleHeightPx) {
	const data = new Uint8Array(sampleWidthPx * sampleHeightPx);
	const left = badge.xPx - badge.widthPx / 2;
	const top = badge.yPx - badge.heightPx / 2;
	const marginX = 0.14;
	const marginY = 0.16;
	for (let y = 0; y < sampleHeightPx; y += 1) {
		const v = (y + 0.5) / sampleHeightPx;
		if (v < marginY || v > 1 - marginY) continue;
		for (let x = 0; x < sampleWidthPx; x += 1) {
			const u = (x + 0.5) / sampleWidthPx;
			if (u < marginX || u > 1 - marginX) continue;
			const sourceX = Math.round(left + u * badge.widthPx - 0.5);
			const sourceY = Math.round(top + v * badge.heightPx - 0.5);
			const [r, g, b] = rgbaAt(image, sourceX, sourceY);
			if (!brightNeutral(r, g, b, threshold)) continue;
			data[y * sampleWidthPx + x] = 1;
		}
	}
	return { widthPx: sampleWidthPx, heightPx: sampleHeightPx, data };
}

function tightBounds(mask) {
	let minX = mask.widthPx;
	let minY = mask.heightPx;
	let maxX = -1;
	let maxY = -1;
	for (let y = 0; y < mask.heightPx; y += 1) {
		for (let x = 0; x < mask.widthPx; x += 1) {
			if (!mask.data[y * mask.widthPx + x]) continue;
			minX = Math.min(minX, x);
			maxX = Math.max(maxX, x);
			minY = Math.min(minY, y);
			maxY = Math.max(maxY, y);
		}
	}
	return maxX < 0 ? null : { minX, minY, maxX, maxY };
}

function normalizeBadgeGlyphMask(image, badge) {
	const sampled = rawBadgeGlyphMask(image, badge, FOREGROUND_THRESHOLD, 48, 36);
	const bounds = tightBounds(sampled);
	if (!bounds) return null;
	const sourceWidth = bounds.maxX - bounds.minX + 1;
	const sourceHeight = bounds.maxY - bounds.minY + 1;
	const innerWidth = Math.max(1, NORMALIZED_WIDTH_PX - 2);
	const innerHeight = Math.max(1, NORMALIZED_HEIGHT_PX - 2);
	const scale = Math.min(innerWidth / sourceWidth, innerHeight / sourceHeight);
	const drawWidth = Math.max(1, Math.round(sourceWidth * scale));
	const drawHeight = Math.max(1, Math.round(sourceHeight * scale));
	const offsetX = Math.floor((NORMALIZED_WIDTH_PX - drawWidth) / 2);
	const offsetY = Math.floor((NORMALIZED_HEIGHT_PX - drawHeight) / 2);
	const data = new Uint8Array(NORMALIZED_WIDTH_PX * NORMALIZED_HEIGHT_PX);
	for (let y = 0; y < drawHeight; y += 1) {
		const sourceY = Math.min(bounds.maxY, bounds.minY + Math.floor(((y + 0.5) * sourceHeight) / drawHeight));
		for (let x = 0; x < drawWidth; x += 1) {
			const sourceX = Math.min(bounds.maxX, bounds.minX + Math.floor(((x + 0.5) * sourceWidth) / drawWidth));
			if (!sampled.data[sourceY * sampled.widthPx + sourceX]) continue;
			data[(offsetY + y) * NORMALIZED_WIDTH_PX + (offsetX + x)] = 1;
		}
	}
	return { widthPx: NORMALIZED_WIDTH_PX, heightPx: NORMALIZED_HEIGHT_PX, data };
}

// --- driver ----------------------------------------------------------------

const templatesDir = process.argv[2];
if (!templatesDir) {
	console.error('usage: node scripts/generate-badge-glyph-templates.mjs <templatesDir>');
	process.exit(1);
}

const manifest = JSON.parse(readFileSync(join(templatesDir, 'manifest.json'), 'utf8'));
const templates = manifest.templates.holeNumbers.map((fileName, index) => {
	const label = index + 1;
	const expected = `hole-${String(label).padStart(2, '0')}.png`;
	if (fileName !== expected) throw new Error(`template ${label} must be ${expected}, got ${fileName}`);
	const png = PNG.sync.read(readFileSync(join(templatesDir, fileName)));
	const image = { width: png.width, height: png.height, data: png.data };
	const wholeRasterBadge = { xPx: png.width / 2, yPx: png.height / 2, widthPx: png.width, heightPx: png.height };
	const mask = normalizeBadgeGlyphMask(image, wholeRasterBadge);
	if (!mask) throw new Error(`template ${label} normalized to an empty glyph`);
	const rows = [];
	for (let y = 0; y < mask.heightPx; y += 1) {
		let row = '';
		for (let x = 0; x < mask.widthPx; x += 1) row += mask.data[y * mask.widthPx + x] ? '1' : '0';
		rows.push(row);
	}
	return { label, rows };
});

const out = {
	schema: 'badgeGlyphTemplates@1',
	sourceCommit: SOURCE_COMMIT,
	sourcePath: 'old-stuff/static/resources/chainspot_cv_templates',
	normalizedWidthPx: NORMALIZED_WIDTH_PX,
	normalizedHeightPx: NORMALIZED_HEIGHT_PX,
	note:
		'Each template is normalizeBadgeGlyphMask() applied to its own full raster (the old classifier\'s own self-test contract: a template classifies as itself). Rows are top-to-bottom strings of 0/1, one char per pixel, width=normalizedWidthPx.',
	templates
};
writeFileSync(OUT_PATH, JSON.stringify(out, null, '\t') + '\n');
console.log(`wrote ${templates.length} templates to ${OUT_PATH}`);
