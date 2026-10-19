/**
 * Headless demo of the toolkit boundary: a `chainspot.course-geometry` file, parsed by `parseCourseGeometry`, drawn by the
 * product's own hole-graphic renderer (`planHoleGraphic` / `buildHoleGraphicMarkup`), written as one SVG per hole.
 *
 *   npx tsx scripts/course-geometry-demo.ts <course-geometry.json> <screenshot.jpg> <outDir>
 *
 * There is no clean basemap in this demo, so the "target" image is the user's own screenshot and the source-to-target transform is
 * the identity: the graphic shows where the CV put each hole's tee, bends and basket on the screenshot it read. The info card shows
 * no length (no ground scale is known).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCourseGeometry } from '../src/lib/import/courseGeometry';
import { buildHoleGraphicMarkup, planHoleGraphic } from '../src/lib/holeGraphics';
import type { SerializableTransform } from '../src/lib/alignment/types';

const [geometryPath, imagePath, outDir] = process.argv.slice(2);
if (!geometryPath || !imagePath || !outDir) {
	console.error('usage: tsx scripts/course-geometry-demo.ts <course-geometry.json> <screenshot.jpg> <outDir>');
	process.exit(2);
}

const parsed = parseCourseGeometry(readFileSync(geometryPath, 'utf8'));
if (!parsed.ok) {
	console.error(`${parsed.error.code} at ${parsed.error.path}: ${parsed.error.message}`);
	process.exit(1);
}
const { source } = parsed.geometry;
const mime = imagePath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
const href = `data:${mime};base64,${readFileSync(imagePath).toString('base64')}`;
const identity: SerializableTransform = {
	model: 'similarity',
	coefficients: [1, 0, 0, 1, 0, 0],
	isInvertible: true,
	determinant: 1,
	orientation: 1,
	majorAxisScale: 1,
	minorAxisScale: 1,
	anisotropy: 1,
	shear: 0
};

mkdirSync(outDir, { recursive: true });
const written: string[] = [];
for (const hole of parsed.state.holes) {
	const plan = planHoleGraphic(hole, identity, source.widthPx, source.heightPx);
	if (!plan) continue;
	const file = join(outDir, `hole-${String(hole.number).padStart(2, '0')}.svg`);
	writeFileSync(file, buildHoleGraphicMarkup(plan, href));
	written.push(file);
}
console.log(JSON.stringify({ holes: parsed.state.holes.length, svgs: written.length, needsReview: parsed.needsReview.map((e) => `${e.holeId}:${e.status}/${e.confidence.level}`), outDir }));
