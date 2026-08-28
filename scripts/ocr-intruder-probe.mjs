/**
 * Names the non-glyph component that corrupts a badge's glyph mask, and
 * renders a 6x reconciliation crop a human can accept on sight.
 *
 * Read-only: imports dist/, writes only PNGs under the given out dir.
 *   node scripts/ocr-intruder-probe.mjs <canonical.png> <outDir> <cy,cx> ...
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { PNG } from 'pngjs';
import { runBadgeStage } from '@chainspot/alg/detectors/threeFactor/badgeStage';
import { extractBadgeGlyph } from '@chainspot/alg/detectors/threeFactor/digits/badgeGlyph';
import { extractComponents } from '@chainspot/alg/detectors/threeFactor/components';

const [, , pngPath, outDir, ...targets] = process.argv;
mkdirSync(outDir, { recursive: true });
const png = PNG.sync.read(readFileSync(pngPath));
const image = { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data) };
const stage = runBadgeStage(image);

const ordered = [...stage.badges].sort((a, b) => a.cy - b.cy || a.cx - b.cx);
const { components: brightComps } = { components: [] }; // placeholder, use stage labels

for (const t of targets) {
	const idx = Number(t);
	const badge = ordered[idx];
	if (!badge) continue;
	const glyph = extractBadgeGlyph(badge, stage.brightMask, stage.darkMask, stage.brightLabels);
	const [ix, iy, iw, ih] = glyph.interiorBbox;
	console.log(`\n=== badge-${idx} plate bbox=[${badge.bboxX},${badge.bboxY},${badge.bboxW},${badge.bboxH}] plateArea=${badge.area} label=${badge.label}`);
	console.log(`    interior bbox=[${ix},${iy},${iw},${ih}]  (plate inset = ${ix - badge.bboxX}px left, ${iy - badge.bboxY}px top)`);

	// Which bright components contribute pixels to the glyph mask?
	const contrib = new Map();
	for (let y = 0; y < ih; y++) {
		for (let x = 0; x < iw; x++) {
			const i = (iy + y) * stage.brightMask.width + (ix + x);
			if (!stage.brightMask.data[i]) continue;
			const lab = stage.brightLabels[i];
			if (lab === badge.label) continue;
			if (!contrib.has(lab)) contrib.set(lab, { n: 0, minX: 1e9, maxX: -1, minY: 1e9, maxY: -1 });
			const c = contrib.get(lab);
			c.n++;
			c.minX = Math.min(c.minX, x); c.maxX = Math.max(c.maxX, x);
			c.minY = Math.min(c.minY, y); c.maxY = Math.max(c.maxY, y);
		}
	}
	console.log(`    bright components feeding the glyph mask (label | pxInInterior | bbox-in-interior | wxh | signature):`);
	for (const [lab, c] of [...contrib.entries()].sort((a, b) => b[1].n - a[1].n)) {
		const w = c.maxX - c.minX + 1, h = c.maxY - c.minY + 1;
		let sig = 'UNKNOWN';
		if (w === 7 && h === 21) sig = "digit '1' (7x21, engram signature)";
		else if (w >= 13 && w <= 17 && h >= 19 && h <= 23) sig = 'digit glyph (14-16x21, engram signature)';
		else if (w >= 0.9 * iw && h >= 0.9 * ih) sig = '*** NON-GLYPH INTRUDER: spans the whole interior ***';
		else if (h < 8) sig = 'sliver / antialias remnant';
		console.log(`      ${String(lab).padStart(6)} | ${String(c.n).padStart(5)} | [${c.minX},${c.minY}] | ${w}x${h} | ${sig}`);
	}

	// 6x crop with bright pixels tinted green, glyph-mask pixels tinted magenta.
	const pad = 8, Z = 6;
	const cx0 = Math.max(0, badge.bboxX - pad), cy0 = Math.max(0, badge.bboxY - pad);
	const cw = Math.min(png.width - cx0, badge.bboxW + 2 * pad), ch = Math.min(png.height - cy0, badge.bboxH + 2 * pad);
	const out = new PNG({ width: cw * Z, height: ch * Z });
	for (let y = 0; y < ch * Z; y++) {
		for (let x = 0; x < cw * Z; x++) {
			const sx = cx0 + Math.floor(x / Z), sy = cy0 + Math.floor(y / Z);
			const si = (sy * png.width + sx) * 4, di = (y * out.width + x) * 4;
			let [r, g, b] = [png.data[si], png.data[si + 1], png.data[si + 2]];
			const mi = sy * stage.brightMask.width + sx;
			const inInterior = sx >= ix && sx < ix + iw && sy >= iy && sy < iy + ih;
			if (stage.brightMask.data[mi]) {
				if (inInterior && stage.brightLabels[mi] !== badge.label) { r = 255; g = 0; b = 255; } // glyph-mask input
				else { r = 0; g = 255; b = 0; } // other bright
			}
			out.data[di] = r; out.data[di + 1] = g; out.data[di + 2] = b; out.data[di + 3] = 255;
		}
	}
	const p = `${outDir}/badge-${idx}.crop6x.png`;
	writeFileSync(p, PNG.sync.write(out));
	console.log(`    crop: ${p}  (magenta = pixels fed to segmentDigits, green = other bright)`);
}
