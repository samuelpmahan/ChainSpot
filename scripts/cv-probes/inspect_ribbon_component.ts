/**
 * Human-verification aid for ribbon-mass component claims: given a course +
 * hole number, prints the badge/basket seeds' component-label agreement,
 * that component's size/bbox and which OTHER seeds (if any) fall inside its
 * bbox, and (with --render) writes an isolated full-opacity mask PNG of
 * just that one component so it can be eyeballed with zero photo-blend
 * ambiguity -- component-label-equality alone ("badge X and basket X map to
 * the same label") doesn't tell you whether that's a real winding corridor,
 * a two-fragments-glued-by-a-blocky-badge-box false bridge, or something
 * else; only looking at the isolated shape does. Grew out of checking
 * whether GoldenTeeSet hole 13's "regression" under badge-prefill-spike.ts's
 * tight-box variant was a real repair being broken, or a same-mechanism
 * false positive that just happened not to trip the multi-hole-seed check
 * (see badge-prefill-findings.md).
 *
 * Usage:
 *   npx tsx scripts/cv-probes/inspect_ribbon_component.ts <CourseName> <holeNumber> [--render]
 *   npx tsx scripts/cv-probes/inspect_ribbon_component.ts GoldenTeeSet 13 --render
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { DEFAULT_RIBBON_MASS_PARAMS, placeSeeds, segmentRibbonMass } from '../../src/lib/autoAnnotation/ribbonMass';
import { FIXTURE_COURSES, loadFixtureRaster } from './ribbonMassFixtures';

const [, , courseName, holeArg] = process.argv;
if (!courseName || !holeArg) {
	console.error('usage: inspect_ribbon_component.ts <CourseName> <holeNumber> [--render]');
	process.exit(1);
}
const holeNumber = Number(holeArg);

const course = FIXTURE_COURSES.find((c) => c.name === courseName);
if (!course) {
	console.error(`unknown course "${courseName}"; known: ${FIXTURE_COURSES.map((c) => c.name).join(', ')}`);
	process.exit(1);
}

const raster = loadFixtureRaster(join(process.cwd(), course.zip));
const badgeBoxes = course.badges.map(([, xPx, yPx]) => ({ xPx, yPx }));
const seg = segmentRibbonMass(raster, badgeBoxes, DEFAULT_RIBBON_MASS_PARAMS);

const seeds = [
	...course.badges.map(([n, xPx, yPx]) => ({ seedId: `badge-${n}`, kind: 'badge' as const, holeNumber: n, xPx, yPx })),
	...course.truth.map(([n, , , bx, by]) => ({
		seedId: `basket-${n}`,
		kind: 'basket' as const,
		holeNumber: n,
		xPx: bx,
		yPx: by
	}))
];
const placements = placeSeeds(seg, seeds, DEFAULT_RIBBON_MASS_PARAMS.seedRadiusPx);

const badgeSeed = placements.find((p) => p.seedId === `badge-${holeNumber}`);
const basketSeed = placements.find((p) => p.seedId === `basket-${holeNumber}`);
if (!badgeSeed || !basketSeed) {
	console.error(`hole ${holeNumber} not found in ${courseName}'s fixture seeds`);
	process.exit(1);
}
console.log(`badge-${holeNumber} label`, badgeSeed.componentLabel, `basket-${holeNumber} label`, basketSeed.componentLabel);

const label = badgeSeed.componentLabel;
if (label === null) {
	console.log('badge seed did not land in any kept component -- nothing to render.');
	process.exit(0);
}

let count = 0;
let minX = Infinity,
	minY = Infinity,
	maxX = -Infinity,
	maxY = -Infinity;
for (let y = 0; y < seg.heightEv; y += 1) {
	for (let x = 0; x < seg.widthEv; x += 1) {
		if (seg.labels[y * seg.widthEv + x] !== label) continue;
		count += 1;
		minX = Math.min(minX, x);
		maxX = Math.max(maxX, x);
		minY = Math.min(minY, y);
		maxY = Math.max(maxY, y);
	}
}
const scale = seg.scale;
console.log(`component ${label}: ${count} evidence-px`);
console.log(
	`  bbox in SOURCE px: [${minX * scale},${minY * scale}]-[${maxX * scale},${maxY * scale}] size ${(maxX - minX) * scale}x${(maxY - minY) * scale}`
);
for (const s of seeds) {
	const inBbox = s.xPx >= minX * scale && s.xPx <= maxX * scale && s.yPx >= minY * scale && s.yPx <= maxY * scale;
	if (inBbox) console.log(`  ${s.seedId} falls within this component's bbox`);
}

if (process.argv.includes('--render')) {
	const { widthPx, heightPx } = raster;
	const png = new PNG({ width: widthPx, height: heightPx });
	raster.data.forEach((v, i) => {
		png.data[i] = v;
	});
	const set = (x: number, y: number) => {
		const p = (y * widthPx + x) * 4;
		if (p < 0 || p >= png.data.length) return;
		png.data[p] = 255;
		png.data[p + 1] = 0;
		png.data[p + 2] = 255;
	};
	for (let y = 0; y < seg.heightEv; y += 1) {
		for (let x = 0; x < seg.widthEv; x += 1) {
			if (seg.labels[y * seg.widthEv + x] !== label) continue;
			for (let sy = 0; sy < scale; sy += 1)
				for (let sx = 0; sx < scale; sx += 1) set(x * scale + sx, y * scale + sy);
		}
	}
	const outPath = join(process.cwd(), `scripts/cv-probes/ribbon-mass-results-ts/${courseName}-hole${holeNumber}-label${label}-only.png`);
	writeFileSync(outPath, PNG.sync.write(png));
	console.log(`  wrote ${outPath} (full-opacity, this component only -- no photo-blend ambiguity)`);
}
