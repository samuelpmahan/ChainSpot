// Generalized corpus fixture loader for the multi-course gate sweep
// (tests/unit/corpusSweep.test.ts). Same decode-and-load approach as
// tests/unit/helpers/dashsTrackFixture.ts (which stays untouched — the
// DashsTrack suite is unmodified per CHSPT-82 scale-out instructions),
// generalized to more than one course and to PNG sources.
//
// Source layout assumed: `chainspot-corpus` checked out as a SIBLING of
// this repo (<workspace>/chainspot-corpus, <workspace>/ChainSpot-chspt-82).

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import type { RgbaRaster } from '$lib/detect';
import { autocropLikeIntake } from './intakeAutocrop';

const HERE = dirname(fileURLToPath(import.meta.url));
// tests/unit/helpers -> repo root is 3 levels up; chainspot-corpus is a
// sibling of the repo root, one level further up.
const CORPUS_ROOT = resolve(HERE, '../../../../chainspot-corpus');
const ANNOTATED_ROOT = resolve(CORPUS_ROOT, 'dev/Annotated');

export interface CourseHoleTruth {
	readonly number: number;
	readonly tee: { readonly xPx: number; readonly yPx: number };
	readonly basket: { readonly xPx: number; readonly yPx: number };
}

interface SourceImageAnnotation {
	readonly schemaVersion: number;
	readonly sourceImage: {
		readonly fileName: string;
		readonly mimeType: string;
		readonly widthPx: number;
		readonly heightPx: number;
		readonly sha256: string;
	};
	readonly holes: readonly CourseHoleTruth[];
}

export interface CourseSpec {
	readonly name: string;
	/** subdirectory name under chainspot-corpus/dev/Annotated */
	readonly dir: string;
	readonly imageFile: string;
	readonly annotationFile: string;
}

/** The 4 in-scope full-course (18-hole) fixtures. AlexClark is deliberately
 * excluded — see tests/unit/corpusSweep.test.ts's header comment. */
export const COURSES: readonly CourseSpec[] = [
	{ name: 'Heritage', dir: 'Heritage', imageFile: 'HeritagePark-full.png', annotationFile: 'HeritagePark-full.annotation.json' },
	{ name: 'Lenard', dir: 'Lenard', imageFile: 'Lenard-full.PNG', annotationFile: 'Lenard-full.annotation.json' },
	{ name: 'TowneLake', dir: 'TowneLake', imageFile: 'TowneLake-full.png', annotationFile: 'TowneLake-full.annotation.json' }
];

function readFileOrThrow(path: string, what: string): Buffer {
	try {
		return readFileSync(path);
	} catch (err) {
		throw new Error(
			`courseFixture: could not read ${what} at ${path}. This suite expects ` +
				`\`chainspot-corpus\` checked out as a sibling of this repo ` +
				`(<workspace>/chainspot-corpus). Original error: ${(err as Error).message}`
		);
	}
}

function decode(bytes: Buffer, imagePath: string): { width: number; height: number; rgba: Uint8ClampedArray } {
	const ext = extname(imagePath).toLowerCase();
	if (ext === '.png') {
		const png = PNG.sync.read(bytes);
		return {
			width: png.width,
			height: png.height,
			rgba: new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.byteLength)
		};
	}
	const decoded = jpeg.decode(bytes, { useTArray: true, maxMemoryUsageInMB: 2048 });
	return {
		width: decoded.width,
		height: decoded.height,
		rgba: new Uint8ClampedArray(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength)
	};
}

/**
 * Loads a course's raster, autocropping it to the annotation's frame when
 * the raw file's dimensions don't already match (Heritage/Lenard/TowneLake
 * ship the raw, un-autocropped phone screenshot — see intakeAutocrop.ts's
 * header for why this is required, not optional, for those three).
 */
export function loadCourseRaster(spec: CourseSpec): RgbaRaster {
	const imagePath = resolve(ANNOTATED_ROOT, spec.dir, spec.imageFile);
	const bytes = readFileOrThrow(imagePath, `${spec.name} image`);
	const imageId = createHash('sha256').update(bytes).digest('hex');
	const decoded = decode(bytes, imagePath);

	const truth = loadCourseTruth(spec);
	const target = truth.sourceImage;
	if (decoded.width === target.widthPx && decoded.height === target.heightPx) {
		return { imageId, widthPx: decoded.width, heightPx: decoded.height, rgba: decoded.rgba };
	}

	const cropped = autocropLikeIntake({ rgba: decoded.rgba, widthPx: decoded.width, heightPx: decoded.height });
	if (cropped.widthPx !== target.widthPx || cropped.heightPx !== target.heightPx) {
		throw new Error(
			`courseFixture: ${spec.name} frame mismatch — raw ${decoded.width}x${decoded.height} ` +
				`autocrops to ${cropped.widthPx}x${cropped.heightPx} (top ${cropped.topPx}, bottom ${cropped.bottomPx}) ` +
				`but the annotation was made on ${target.widthPx}x${target.heightPx}`
		);
	}
	return { imageId, widthPx: cropped.widthPx, heightPx: cropped.heightPx, rgba: cropped.rgba };
}

/** Loads a course's frozen ground truth (tee/basket positions, hole numbers). */
export function loadCourseTruth(spec: CourseSpec): SourceImageAnnotation {
	const annotationPath = resolve(ANNOTATED_ROOT, spec.dir, spec.annotationFile);
	const raw = readFileOrThrow(annotationPath, `${spec.name} annotation`);
	const parsed = JSON.parse(raw.toString('utf8')) as SourceImageAnnotation;
	if (!Array.isArray(parsed.holes) || parsed.holes.length === 0) {
		throw new Error(`courseFixture: ${spec.name} annotation has no holes`);
	}
	return parsed;
}
