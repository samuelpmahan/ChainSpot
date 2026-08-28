/**
 * Counterfactual for the FIX CONTRACT (Opus lead, read-only — modifies no
 * detector source): re-reads every badge with the ONE change the root cause
 * implies — exclude the badge's own plate frame from the glyph mask for
 * dark-plate-recovery badges too (today `brightLabels[i] !== badge.label`
 * is a no-op there because their synthetic label is -1).
 *
 * Substitute: drop any bright component inside the interior whose bbox spans
 * >=85% of the interior in BOTH axes — that is the plate frame, never a digit.
 *
 *   node scripts/ocr-counterfactual.mjs <canonical.png> <CourseName>
 */
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { runBadgeStage } from '@chainspot/alg/detectors/threeFactor/badgeStage';
import { extractBadgeGlyph } from '@chainspot/alg/detectors/threeFactor/digits/badgeGlyph';
import { DEFAULT_DIGITS_KNOBS, segmentDigits } from '@chainspot/alg/detectors/threeFactor/digits/segment';
import { normalizeDigitMask } from '@chainspot/alg/detectors/threeFactor/digits/normalize';
import { predictProbs } from '@chainspot/alg/detectors/threeFactor/digits/logisticInference';
import { extractComponents } from '@chainspot/alg/detectors/threeFactor/components';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const model = require('@chainspot/alg/detectors/threeFactor/assets/logistic.json');

const [, , pngPath, courseName] = process.argv;
const png = PNG.sync.read(readFileSync(pngPath));
const stage = runBadgeStage({ width: png.width, height: png.height, data: new Uint8ClampedArray(png.data) });
const ordered = [...stage.badges].sort((a, b) => a.cy - b.cy || a.cx - b.cx);

console.log(`=== ${courseName}: counterfactual (plate-frame excluded) vs CURRENT ===`);
console.log('badge | source | CURRENT read @conf | COUNTERFACTUAL read @conf');

for (const [idx, badge] of ordered.entries()) {
	const glyph = extractBadgeGlyph(badge, stage.brightMask, stage.darkMask, stage.brightLabels);
	if (glyph.mask.width === 0) continue;
	const isRecovered = badge.label === -1;

	const read = (mask) => {
		const seg = segmentDigits(mask, DEFAULT_DIGITS_KNOBS);
		const out = seg.digits.map((c) => {
			const s = predictProbs(model, normalizeDigitMask(c.mask, c.bbox[2], c.bbox[3], DEFAULT_DIGITS_KNOBS));
			let w = 0, second = -1;
			for (let i = 1; i < s.length; i++) {
				if (s[i] > s[w]) { second = w; w = i; }
				else if (second < 0 || s[i] > s[second]) second = i;
			}
			return { d: String(w), margin: s[w] - s[second] };
		});
		return { label: out.map((o) => o.d).join(''), conf: out.length ? Math.min(...out.map((o) => o.margin)) : Infinity };
	};

	const current = read(glyph.mask);

	// Counterfactual mask: drop interior-spanning components (the plate frame).
	const { labels, components } = extractComponents(glyph.mask);
	const iw = glyph.mask.width, ih = glyph.mask.height;
	const frameLabels = new Set(
		components.filter((c) => c.bboxW >= 0.85 * iw && c.bboxH >= 0.85 * ih).map((c) => c.label)
	);
	const cfData = new Uint8Array(glyph.mask.data);
	for (let i = 0; i < cfData.length; i++) if (frameLabels.has(labels[i])) cfData[i] = 0;
	const cf = read({ width: iw, height: ih, data: cfData });

	const mark = current.label !== cf.label ? '   <<< CHANGED' : '';
	console.log(
		`badge-${String(idx).padStart(2)} | ${isRecovered ? 'dark-plate-recovery' : 'bright-family     '} | ` +
		`"${current.label}"@${current.conf === Infinity ? 'Inf' : current.conf.toFixed(4)} | ` +
		`"${cf.label}"@${cf.conf === Infinity ? 'Inf' : cf.conf.toFixed(4)}${mark}`
	);
}
