// Post-G4 object-acquisition probe, recreated per 11b7bcc: materialize exact
// black+white component ownership for ONE clean basket and punch the owned
// pixels transparent, so whatever ghost remains in the crop is the un-owned
// basket-caused fringe (the missing ~10%). Receipt ends with render paths.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { measureThreeFactor } from '../../../packages/alg/dist/detectors/threeFactor/index.js';
import { extractComponents } from '../../../packages/alg/dist/detectors/threeFactor/components.js';
import { acquireObjectGraphV1 } from '../../../packages/alg/dist/detectors/threeFactor/objects.js';

const require = createRequire(import.meta.url);
const { PNG } = require('pngjs');

const [rgbaPath, outPrefix, basketArg] = process.argv.slice(2);
const WIDTH = 1290, HEIGHT = 2083;
const rgba = new Uint8ClampedArray(readFileSync(rgbaPath).buffer.slice(0));
if (rgba.length !== WIDTH * HEIGHT * 4) throw new Error(`rgba size ${rgba.length} != ${WIDTH * HEIGHT * 4}`);

const image = { imageId: 'dashs-canonical-sweep-artifact', widthPx: WIDTH, heightPx: HEIGHT, rgba };
const t0 = Date.now();
const measurement = measureThreeFactor(image, {});
const bright = extractComponents(measurement.brightMask);
const dark = extractComponents(measurement.darkMask);
const graph = acquireObjectGraphV1(measurement, {
	width: WIDTH,
	height: HEIGHT,
	brightLabels: bright.labels,
	darkLabels: dark.labels,
	brightComponents: bright.components,
	darkComponents: dark.components
});
const elapsedMs = Date.now() - t0;

const assembled = graph.baskets.filter((b) => b.raster.componentAssembly?.status === 'assembled');
const failed = graph.baskets.filter((b) => b.raster.componentAssembly?.status !== 'assembled');
console.log('BASKET TRANSPARENCY PROBE');
console.log(`pipeline: measureThreeFactor(defaults) + extractComponents + acquireObjectGraphV1 in ${elapsedMs}ms`);
console.log(`baskets: ${graph.baskets.length} total, ${assembled.length} assembled, ${failed.length} assembly-failed`);
for (const b of failed) console.log(`  FAILED ${b.id}: ${b.raster.componentAssembly?.reason ?? 'UNKNOWN'}`);

const pick = basketArg
	? assembled.find((b) => b.id === basketArg)
	: assembled[0];
if (!pick) throw new Error(`no assembled basket ${basketArg ?? ''}`);
const asm = pick.raster.componentAssembly;
const [bx0, by0, bw, bh] = asm.bbox; // [x, y, w, h]
const bx1 = bx0 + bw - 1, by1 = by0 + bh - 1;
console.log(`subject: ${pick.id} bbox=[${asm.bbox}] ownedPixels=${asm.ownedPixels.length} perimeterPixels=${asm.perimeterPixels.length}`);

// Crop with margin; side A = original, side B = owned pixels punched to checkerboard.
const M = 30;
const cx0 = Math.max(0, bx0 - M), cy0 = Math.max(0, by0 - M);
const cx1 = Math.min(WIDTH - 1, bx1 + M), cy1 = Math.min(HEIGHT - 1, by1 + M);
const cw = cx1 - cx0 + 1, ch = cy1 - cy0 + 1;
const owned = new Set(asm.ownedPixels);

const SCALE = 6, GAP = 12;
const png = new PNG({ width: (cw * 2 + Math.ceil(GAP / SCALE)) * SCALE, height: ch * SCALE });
png.data.fill(200);
function put(px, py, r, g, b) {
	for (let dy = 0; dy < SCALE; dy++)
		for (let dx = 0; dx < SCALE; dx++) {
			const i = ((py * SCALE + dy) * png.width + px * SCALE + dx) * 4;
			png.data[i] = r; png.data[i + 1] = g; png.data[i + 2] = b; png.data[i + 3] = 255;
		}
}
for (let y = cy0; y <= cy1; y++)
	for (let x = cx0; x <= cx1; x++) {
		const si = (y * WIDTH + x) * 4;
		const lx = x - cx0, ly = y - cy0;
		put(lx, ly, rgba[si], rgba[si + 1], rgba[si + 2]);
		const rx = lx + cw + Math.ceil(GAP / SCALE);
		if (owned.has(y * WIDTH + x)) {
			const checker = ((x + y) & 1) ? 235 : 170; // punched: transparency checker
			put(rx, ly, checker, checker, ((x + y) & 1) ? 245 : 190);
		} else {
			put(rx, ly, rgba[si], rgba[si + 1], rgba[si + 2]);
		}
	}
const outPath = `${outPrefix}-${pick.id}.png`;
writeFileSync(outPath, PNG.sync.write(png));
console.log(`render saved to ${outPath} — display alongside this receipt`);
