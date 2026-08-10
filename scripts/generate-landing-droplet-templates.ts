/**
 * Regenerates the bundled round-landing-marker glyph templates
 * (`static/resources/chainspot_cv_templates/round-landing-glyph-*.png`) from
 * a real, hand-labeled UDisc round screenshot.
 *
 * This intentionally does NOT learn templates at runtime (see
 * `src/lib/autoAnnotation/landingDropletDetection.ts`'s module doc): this
 * script is a one-time/occasional offline step, run and committed by a
 * developer, not part of the production detection path. It exists so the
 * bundled templates are reproducible from checked-in code and a real
 * fixture, rather than a hand-authored image.
 *
 * The reference labels below were confirmed against
 * `resources/real-capture/ReferenceStitch.png` by inspecting the actual
 * droplet crops (see the landing-droplet implementation notes). If the
 * reference image changes, re-derive these labels first.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { loadCv } from '../src/lib/stitch/cvMatch';
import {
	buildInteriorGlyphSignature,
	findLandingDroplets,
	LANDING_GLYPH_TEMPLATE_SIZE
} from '../src/lib/autoAnnotation/landingDropletDetection';
import type { LandingDropletCv, LandingDropletRaster, LandingMarkerKind } from '../src/lib/autoAnnotation/landingDropletDetection';

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(scriptPath), '..');
const referenceImagePath = join(projectRoot, 'resources', 'real-capture', 'ReferenceStitch.png');
const templateDir = join(projectRoot, 'static', 'resources', 'chainspot_cv_templates');

/** Known tip coordinates -> class label for `resources/real-capture/ReferenceStitch.png` at its native resolution. */
const KNOWN_REFERENCE_LABELS = new Map<string, LandingMarkerKind>([
	['889,991', 'c1'],
	['966,1007', 'c2'],
	['1282,1090', 'off-fairway'],
	['1353,1197', 'c1']
]);

function loadRaster(path: string): LandingDropletRaster {
	const decoded = PNG.sync.read(readFileSync(path));
	return { rgba: new Uint8Array(decoded.data), widthPx: decoded.width, heightPx: decoded.height, sourceScale: 1 };
}

function writeMaskPng(path: string, mask: Float32Array, size: number): void {
	const png = new PNG({ width: size, height: size });
	for (let index = 0; index < mask.length; index += 1) {
		const value = mask[index] >= 0.5 ? 255 : 0;
		const offset = index * 4;
		png.data[offset] = value;
		png.data[offset + 1] = value;
		png.data[offset + 2] = value;
		png.data[offset + 3] = 255;
	}
	writeFileSync(path, PNG.sync.write(png));
}

async function main(): Promise<void> {
	const cv = (await loadCv()) as unknown as LandingDropletCv;
	const raster = loadRaster(referenceImagePath);
	const { droplets } = findLandingDroplets(cv, raster);

	const samples = new Map<LandingMarkerKind, Float32Array[]>();
	for (const droplet of droplets) {
		const key = `${Math.round(droplet.xPx)},${Math.round(droplet.yPx)}`;
		const label = KNOWN_REFERENCE_LABELS.get(key);
		if (!label) {
			console.warn(`No known reference label for detected tip (${key}); skipping.`);
			continue;
		}
		const signature = buildInteriorGlyphSignature(raster, droplet.boundsPx, LANDING_GLYPH_TEMPLATE_SIZE);
		const existing = samples.get(label) ?? [];
		existing.push(signature);
		samples.set(label, existing);
	}

	const missing = (['c1', 'c2', 'off-fairway'] as const).filter((kind) => !samples.get(kind)?.length);
	if (missing.length > 0) {
		throw new Error(`Reference image did not yield samples for: ${missing.join(', ')}.`);
	}

	mkdirSync(templateDir, { recursive: true });
	for (const [kind, signatures] of samples) {
		const averaged = new Float32Array(LANDING_GLYPH_TEMPLATE_SIZE * LANDING_GLYPH_TEMPLATE_SIZE);
		for (const signature of signatures) {
			for (let index = 0; index < averaged.length; index += 1) averaged[index] += signature[index] / signatures.length;
		}
		const outputPath = join(templateDir, `round-landing-glyph-${kind}.png`);
		writeMaskPng(outputPath, averaged, LANDING_GLYPH_TEMPLATE_SIZE);
		console.log(`Wrote ${outputPath} from ${signatures.length} sample(s).`);
	}
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
