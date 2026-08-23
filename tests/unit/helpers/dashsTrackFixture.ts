// Test-only fixture loader for the DashsTrack bottom-up gate sweep
// (tests/unit/dashsTrackSweep.test.ts). Not imported by any engine/source
// file — this is the one place in the repo that decodes a real corpus
// photo into an RgbaRaster, which is why `jpeg-js` was added as a
// devDependency (see package.json; justification: decode corpus photos for
// ground-truth tests, nothing else uses it).
//
// Source layout assumed: `chainspot-corpus` checked out as a SIBLING of
// this repo (`<workspace>/chainspot-corpus`, `<workspace>/ChainSpot-chspt-82`),
// matching how the corpus is referenced elsewhere in this repo's docs/LAB
// registry. `dev/DashsTrack/` and `dev/Annotated/DashsTrack/` hold
// byte-identical copies of both the image and its annotation; this loader
// uses the non-`Annotated` path.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import type { RgbaRaster } from '$lib/detect';

const HERE = dirname(fileURLToPath(import.meta.url));
// tests/unit/helpers -> repo root is 3 levels up; chainspot-corpus is a
// sibling of the repo root, one level further up.
const CORPUS_ROOT = resolve(HERE, '../../../../chainspot-corpus');
const DASHSTRACK_DIR = resolve(CORPUS_ROOT, 'dev/DashsTrack');
const IMAGE_PATH = resolve(DASHSTRACK_DIR, 'DashsTrack-full.jpg');
const ANNOTATION_PATH = resolve(DASHSTRACK_DIR, 'DashsTrack-full.annotation.json');

export interface DashsTrackHoleTruth {
	readonly number: number;
	readonly tee: { readonly xPx: number; readonly yPx: number };
	readonly basket: { readonly xPx: number; readonly yPx: number };
}

interface DashsTrackAnnotation {
	readonly schemaVersion: number;
	readonly sourceImage: {
		readonly fileName: string;
		readonly widthPx: number;
		readonly heightPx: number;
		readonly sha256: string;
	};
	readonly holes: readonly DashsTrackHoleTruth[];
}

function readFileOrThrow(path: string, what: string): Buffer {
	try {
		return readFileSync(path);
	} catch (err) {
		throw new Error(
			`dashsTrackFixture: could not read ${what} at ${path}. This suite expects ` +
				`\`chainspot-corpus\` checked out as a sibling of this repo ` +
				`(<workspace>/chainspot-corpus). Original error: ${(err as Error).message}`
		);
	}
}

/** Loads DashsTrack-full.jpg from the sibling chainspot-corpus checkout as an RgbaRaster. */
export function loadDashsTrackRaster(): RgbaRaster {
	const bytes = readFileOrThrow(IMAGE_PATH, 'DashsTrack-full.jpg');
	const imageId = createHash('sha256').update(bytes).digest('hex');
	const decoded = jpeg.decode(bytes, { useTArray: true, maxMemoryUsageInMB: 2048 });
	return {
		imageId,
		widthPx: decoded.width,
		heightPx: decoded.height,
		rgba: new Uint8ClampedArray(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength)
	};
}

/** Loads the frozen 18-hole DashsTrack ground truth (tee/basket positions, hole numbers). */
export function loadDashsTrackTruth(): DashsTrackAnnotation {
	const raw = readFileOrThrow(ANNOTATION_PATH, 'DashsTrack-full.annotation.json');
	const parsed = JSON.parse(raw.toString('utf8')) as DashsTrackAnnotation;
	if (!Array.isArray(parsed.holes) || parsed.holes.length === 0) {
		throw new Error('dashsTrackFixture: annotation has no holes');
	}
	return parsed;
}
