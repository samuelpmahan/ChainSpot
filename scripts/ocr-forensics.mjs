/**
 * OCR forensics (Opus lead, read-only): walks the CURRENT G1 digit pipeline on
 * a canonical raster and prints every intermediate value per badge —
 * glyph interior bbox, segmentation notes, per-digit bbox/method/scores,
 * the 1-18 labelCandidates table, and the label actually emitted.
 *
 * Read-only: imports dist/, mutates nothing.
 *   node scripts/ocr-forensics.mjs <canonical.png> <CourseName>
 */
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { runBadgeStage } from '@chainspot/alg/detectors/threeFactor/badgeStage';
import { readCourseBadges } from '@chainspot/alg/detectors/threeFactor/digits/readBadges';
import { DEFAULT_DIGITS_KNOBS, segmentDigits } from '@chainspot/alg/detectors/threeFactor/digits/segment';
import { extractBadgeGlyph } from '@chainspot/alg/detectors/threeFactor/digits/badgeGlyph';
import { predictProbs } from '@chainspot/alg/detectors/threeFactor/digits/logisticInference';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const model = require('@chainspot/alg/detectors/threeFactor/assets/logistic.json');

const [, , pngPath, courseName] = process.argv;
const png = PNG.sync.read(readFileSync(pngPath));
const image = { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data) };

const scorer = {
	name: 'logistic',
	scores: (mask) => predictProbs(model, mask)
};

const stage = runBadgeStage(image);
const readings = readCourseBadges(stage, scorer, DEFAULT_DIGITS_KNOBS);

// Reproduce makeBadges' ordering (cy, then cx) so detIds match the engine.
const entries = readings
	.map((reading, index) => ({ reading, index }))
	.sort(
		(a, b) =>
			a.reading.badge.cy - b.reading.badge.cy ||
			a.reading.badge.cx - b.reading.badge.cx ||
			a.index - b.index
	);

// Reproduce measure.ts labelCandidates verbatim.
function labelCandidates(reading) {
	if (!reading.digits.length) return [];
	const candidates = Array.from({ length: 18 }, (_, i) => i + 1)
		.filter((label) => String(label).length === reading.digits.length)
		.map((label) => {
			const confidence = [...String(label)].reduce(
				(product, digit, index) => product * (reading.digits[index]?.scores[Number(digit)] ?? 0),
				1
			);
			return { label, confidence };
		})
		.sort((a, b) => b.confidence - a.confidence || a.label - b.label);
	const total = candidates.reduce((s, c) => s + c.confidence, 0);
	return candidates.map((c) => ({ label: c.label, confidence: total > 0 ? c.confidence / total : 0 }));
}

console.log(`=== ${courseName} :: ${pngPath} (${png.width}x${png.height}) ===`);
console.log(`badges: ${stage.badges.length}\n`);

const emitted = [];
for (const [detIndex, entry] of entries.entries()) {
	const r = entry.reading;
	const detId = `badge-${detIndex}`;
	const b = r.badge;
	const glyph = extractBadgeGlyph(b, stage.brightMask, stage.darkMask, stage.brightLabels);
	const seg = glyph.mask.width > 0 ? segmentDigits(glyph.mask, DEFAULT_DIGITS_KNOBS) : { digits: [], notes: ['empty glyph'] };
	const cands = labelCandidates(r);
	const label = cands[0] ? String(cands[0].label) : r.label || null;
	emitted.push({ detId, label, nDigits: r.digits.length, conf: r.confidence });

	console.log(`--- ${detId} plate@(${b.cx.toFixed(1)},${b.cy.toFixed(1)}) bbox=[${b.bboxX},${b.bboxY},${b.bboxW},${b.bboxH}] area=${b.area}`);
	console.log(`    glyph interior bbox = [${glyph.interiorBbox.join(', ')}]`);
	console.log(`    segmentation: ${r.digits.length} digit candidate(s)`);
	for (const n of seg.notes) console.log(`      note: ${n}`);
	for (const [i, d] of r.digits.entries()) {
		const s = d.scores;
		const ranked = s
			.map((v, k) => ({ k, v }))
			.sort((a, b2) => b2.v - a.v)
			.slice(0, 3)
			.map((e) => `${e.k}:${e.v.toFixed(4)}`)
			.join(' ');
		console.log(
			`      digit[${i}] bbox=[${d.candidate.bbox.join(',')}] ${d.candidate.bbox[2]}x${d.candidate.bbox[3]} method=${d.candidate.method} -> '${d.predicted}' margin=${d.margin.toFixed(4)} top3={${ranked}}`
		);
	}
	console.log(`    raw reading.label = "${r.label}"  reading.confidence(min margin) = ${r.confidence === Infinity ? 'Infinity' : r.confidence.toFixed(4)}`);
	console.log(`    labelCandidates(1-18, len==${r.digits.length}) -> ${cands.length} candidate(s)${cands.length ? ': ' + cands.slice(0, 3).map((c) => `${c.label}@${c.confidence.toFixed(4)}`).join(' ') : '  << EMPTY: cap bypassed, raw label falls through'}`);
	console.log(`    EMITTED BadgeEvidence.label = ${label === null ? 'null' : `"${label}"`}\n`);
}

console.log('=== EMITTED LABEL SUMMARY ===');
const byLabel = new Map();
for (const e of emitted) {
	if (!byLabel.has(e.label)) byLabel.set(e.label, []);
	byLabel.get(e.label).push(e.detId);
}
for (const e of emitted) {
	const dup = byLabel.get(e.label).length > 1 ? `  <<< COLLISION with ${byLabel.get(e.label).filter((d) => d !== e.detId).join(',')}` : '';
	const oob = e.label !== null && !(Number(e.label) >= 1 && Number(e.label) <= 18) ? '  <<< OUT OF VOCAB 1-18' : '';
	console.log(`${e.detId} -> "${e.label}" (${e.nDigits} digits, minMargin=${e.conf === Infinity ? 'Inf' : e.conf.toFixed(4)})${oob}${dup}`);
}
const seen = [...byLabel.keys()].filter((l) => l !== null && Number(l) >= 1 && Number(l) <= 18).map(Number);
const missing = Array.from({ length: 18 }, (_, i) => i + 1).filter((h) => !seen.includes(h));
console.log(`\nin-vocab labels present: ${seen.sort((a, b) => a - b).join(',')}`);
console.log(`labels 1-18 ABSENT from this course: ${missing.join(',') || '(none)'}`);
