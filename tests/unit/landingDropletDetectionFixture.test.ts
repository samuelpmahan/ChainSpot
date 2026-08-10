import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PNG } from 'pngjs';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadCv } from '../../src/lib/stitch/cvMatch';
import {
	classifyLandingDropletGlyphs,
	findLandingDroplets,
	landingDropletGlyphTemplateFromMask
} from '../../src/lib/autoAnnotation/landingDropletDetection';
import type {
	LandingDropletCv,
	LandingDropletGlyphTemplate,
	LandingDropletRaster,
	LandingMarkerKind
} from '../../src/lib/autoAnnotation/landingDropletDetection';

/**
 * Pins the PR's central "4/4 detected, correctly classified, no false
 * positives" claim to an actual assertion against the one real fixture in
 * this repo, instead of leaving it as a docs-only claim that could silently
 * drift (e.g. if a future change to the localizer or the bundled templates
 * regresses detection/classification without any test noticing).
 */

const FIXTURE_PATH = resolve(process.cwd(), 'resources', 'real-capture', 'ReferenceStitch.png');
const TEMPLATE_DIR = resolve(process.cwd(), 'static', 'resources', 'chainspot_cv_templates');
const GLYPH_KINDS: readonly LandingMarkerKind[] = ['c1', 'c2', 'off-fairway'];
const TIP_TOLERANCE_PX = 2;

let cv: LandingDropletCv;
let raster: LandingDropletRaster;
let templates: readonly LandingDropletGlyphTemplate[];

beforeAll(async () => {
	cv = (await loadCv()) as unknown as LandingDropletCv;
	const decoded = PNG.sync.read(readFileSync(FIXTURE_PATH));
	raster = { rgba: new Uint8Array(decoded.data), widthPx: decoded.width, heightPx: decoded.height, sourceScale: 1 };
	templates = GLYPH_KINDS.map((kind) => {
		const templatePng = PNG.sync.read(readFileSync(join(TEMPLATE_DIR, `round-landing-glyph-${kind}.png`)));
		const gray = new Uint8Array(templatePng.width * templatePng.height);
		for (let pixel = 0, offset = 0; pixel < gray.length; pixel += 1, offset += 4) gray[pixel] = templatePng.data[offset];
		return landingDropletGlyphTemplateFromMask(kind, gray, templatePng.width, templatePng.height);
	});
});

describe('findLandingDroplets + classifyLandingDropletGlyphs: real fixture', () => {
	it('detects exactly 4 standalone droplets with correct tips, no deferred overlaps, and correct C1/C2/OFF_FAIRWAY classification', () => {
		const { droplets, deferredOverlaps } = findLandingDroplets(cv, raster);

		expect(deferredOverlaps).toHaveLength(0);
		expect(droplets).toHaveLength(4);

		// Known tips for resources/real-capture/ReferenceStitch.png, confirmed by
		// inspecting the actual droplet crops (see docs/cv-landing-droplet-detection.md).
		// Tolerance allows for the connected-components bottom-row-averaging
		// remaining stable across incidental algorithm tweaks without pinning
		// exact pixels.
		const expectedTips = [
			{ xPx: 889, yPx: 991 },
			{ xPx: 966, yPx: 1007 },
			{ xPx: 1282, yPx: 1090 },
			{ xPx: 1353, yPx: 1197 }
		];
		droplets.forEach((droplet, index) => {
			expect(Math.abs(droplet.xPx - expectedTips[index].xPx)).toBeLessThanOrEqual(TIP_TOLERANCE_PX);
			expect(Math.abs(droplet.yPx - expectedTips[index].yPx)).toBeLessThanOrEqual(TIP_TOLERANCE_PX);
		});

		const candidates = classifyLandingDropletGlyphs(raster, droplets, templates);
		expect(candidates.map((candidate) => candidate.kind)).toEqual(['c1', 'c2', 'off-fairway', 'c1']);
		for (const candidate of candidates) {
			expect(candidate.glyphConfidence).toBeGreaterThan(0.5);
		}
	});

	it('never publishes a bounding-box center or centroid as the tip for any real droplet', () => {
		const { droplets } = findLandingDroplets(cv, raster);
		for (const droplet of droplets) {
			const boxCenterX = droplet.boundsPx.xPx + droplet.boundsPx.widthPx / 2;
			const boxBottomY = droplet.boundsPx.yPx + droplet.boundsPx.heightPx;
			// The tip is the bottom edge of the box (allowing a small margin for
			// the bottom-2-rows averaging), never somewhere in the box interior.
			expect(droplet.yPx).toBeGreaterThanOrEqual(boxBottomY - 2);
			// Real droplets are slightly asymmetric pins; the tip's x should be
			// close to, but not required to exactly equal, the box's horizontal center.
			expect(Math.abs(droplet.xPx - boxCenterX)).toBeLessThan(droplet.boundsPx.widthPx);
		}
	});
});
