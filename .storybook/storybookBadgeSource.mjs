import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import jpeg from 'jpeg-js';
import * as threeFactorNamespace from '@chainspot/alg/detectors/threeFactor';
import * as badgeStageNamespace from '@chainspot/alg/detectors/threeFactor/badgeStage';
import * as componentFieldNamespace from '@chainspot/alg/detectors/threeFactor/componentField';
import * as objectsNamespace from '@chainspot/alg/detectors/threeFactor/objects';

const runThreeFactor =
	threeFactorNamespace.runThreeFactor ?? threeFactorNamespace.default?.runThreeFactor;
const runBadgeStage =
	badgeStageNamespace.runBadgeStage ?? badgeStageNamespace.default?.runBadgeStage;
const groupBrightDarkComponentFields =
	componentFieldNamespace.groupBrightDarkComponentFields ??
	componentFieldNamespace.default?.groupBrightDarkComponentFields;
const acquireObjectGraphV1 =
	objectsNamespace.acquireObjectGraphV1 ?? objectsNamespace.default?.acquireObjectGraphV1;

function unavailableLibrary(imagePath) {
	return {
		status: 'unavailable',
		note: `Real E materialization unavailable: ${imagePath} does not exist. Set CHAINSPOT_BADGE_IMAGE or place chainspot-corpus beside ChainSpot.`,
		source: imagePath,
		specimens: [
			{
				id: 'unavailable',
				title: 'E unavailable',
				course: 'UNKNOWN',
				detectorId: 'UNKNOWN',
				holeLabel: null,
				sourceSha256: 'UNKNOWN',
				crop: { x: 0, y: 0, width: 1, height: 1 },
				sourceRgba: [245, 245, 245, 255],
				brightMask: [0],
				darkMask: [0],
				ownedMask: [0],
				aaMask: [0],
				residueBeforeMask: [1],
				residueAfterMask: [1],
				metrics: { ownedBw: 0, aaAdded: 0, residueBefore: 1, residueAfter: 1 },
				provenance: [
					'No detector execution occurred. This specimen only keeps the Storybook build compilable.'
				]
			}
		]
	};
}

function cropByteMask(mask, imageWidth, x0, y0, width, height) {
	const out = new Array(width * height).fill(0);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++)
			out[y * width + x] = mask[(y0 + y) * imageWidth + x0 + x] ? 1 : 0;
	}
	return out;
}

function cropRgba(rgba, imageWidth, x0, y0, width, height) {
	const out = new Array(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const source = ((y0 + y) * imageWidth + x0 + x) * 4;
			const target = (y * width + x) * 4;
			out[target] = rgba[source];
			out[target + 1] = rgba[source + 1];
			out[target + 2] = rgba[source + 2];
			out[target + 3] = rgba[source + 3];
		}
	}
	return out;
}

function materializeOneBadge(badge, assembly, image, fields, sourceSha256) {
	const imageWidth = image.widthPx;
	const imageHeight = image.heightPx;
	const owned = new Set(assembly.ownedPixels);
	const aa = new Set();
	for (const pixel of assembly.perimeterPixels) {
		const x = pixel % imageWidth;
		const y = (pixel - x) / imageWidth;
		for (let dy = -1; dy <= 1; dy++) {
			for (let dx = -1; dx <= 1; dx++) {
				if (!dx && !dy) continue;
				const xx = x + dx;
				const yy = y + dy;
				if (xx < 0 || yy < 0 || xx >= imageWidth || yy >= imageHeight) continue;
				const neighbor = yy * imageWidth + xx;
				if (owned.has(neighbor)) continue;
				if (fields.bright.mask.data[neighbor] || fields.dark.mask.data[neighbor]) continue;
				aa.add(neighbor);
			}
		}
	}

	const [bboxX, bboxY, bboxWidth, bboxHeight] = assembly.bbox;
	const x0 = Math.max(0, bboxX - 1);
	const y0 = Math.max(0, bboxY - 1);
	const x1 = Math.min(imageWidth, bboxX + bboxWidth + 1);
	const y1 = Math.min(imageHeight, bboxY + bboxHeight + 1);
	const width = x1 - x0;
	const height = y1 - y0;
	const ownedFull = new Uint8Array(imageWidth * imageHeight);
	const aaFull = new Uint8Array(imageWidth * imageHeight);
	for (const pixel of owned) ownedFull[pixel] = 1;
	for (const pixel of aa) aaFull[pixel] = 1;

	const ownedMask = cropByteMask(ownedFull, imageWidth, x0, y0, width, height);
	const aaMask = cropByteMask(aaFull, imageWidth, x0, y0, width, height);
	const residueBeforeMask = ownedMask.map((value) => (value ? 0 : 1));
	const residueAfterMask = ownedMask.map((value, index) => (value || aaMask[index] ? 0 : 1));
	const metrics = {
		ownedBw: ownedMask.reduce((sum, value) => sum + value, 0),
		aaAdded: aaMask.reduce((sum, value) => sum + value, 0),
		residueBefore: residueBeforeMask.reduce((sum, value) => sum + value, 0),
		residueAfter: residueAfterMask.reduce((sum, value) => sum + value, 0)
	};

	return {
		id: badge.id,
		title: `${badge.id}${badge.evidence.label ? ` · hole ${badge.evidence.label}` : ' · UNREAD'}`,
		course: 'DashsTrack',
		detectorId: badge.id,
		holeLabel: badge.evidence.label,
		sourceSha256,
		crop: { x: x0, y: y0, width, height },
		sourceRgba: cropRgba(image.rgba, imageWidth, x0, y0, width, height),
		brightMask: cropByteMask(fields.bright.mask.data, imageWidth, x0, y0, width, height),
		darkMask: cropByteMask(fields.dark.mask.data, imageWidth, x0, y0, width, height),
		ownedMask,
		aaMask,
		residueBeforeMask,
		residueAfterMask,
		metrics,
		provenance: [
			`source sha256:${sourceSha256}`,
			`B+W ownership: acquireObjectGraphV1(${badge.id}).componentAssembly.ownedPixels`,
			'AA: neutral pixels in the 8-neighborhood of the exact owned perimeter',
			'residue frame: exact component-assembly bbox plus one source pixel on each available side'
		]
	};
}

export async function materializeBadgeSpecimens() {
	const imagePath = resolve(
		process.env.CHAINSPOT_BADGE_IMAGE ?? '../chainspot-corpus/dev/DashsTrack/DashsTrack-full.jpg'
	);
	if (!existsSync(imagePath)) return unavailableLibrary(imagePath);

	const bytes = readFileSync(imagePath);
	const sourceSha256 = createHash('sha256').update(bytes).digest('hex');
	const decoded = jpeg.decode(bytes, { useTArray: true, maxMemoryUsageInMB: 2048 });
	const image = {
		imageId: sourceSha256,
		widthPx: decoded.width,
		heightPx: decoded.height,
		rgba: new Uint8ClampedArray(
			decoded.data.buffer,
			decoded.data.byteOffset,
			decoded.data.byteLength
		)
	};
	const stage = runBadgeStage({ width: image.widthPx, height: image.heightPx, data: image.rgba });
	const fields = groupBrightDarkComponentFields({ bright: stage.brightMask, dark: stage.darkMask });
	const run = runThreeFactor(image);
	const graph = acquireObjectGraphV1(run.measurement, {
		width: image.widthPx,
		height: image.heightPx,
		brightLabels: fields.bright.labels,
		darkLabels: fields.dark.labels,
		brightComponents: fields.bright.components,
		darkComponents: fields.dark.components
	});
	const specimens = graph.badges.flatMap((badge) => {
		const assembly = badge.raster.componentAssembly;
		return assembly?.status === 'assembled'
			? [materializeOneBadge(badge, assembly, image, fields, sourceSha256)]
			: [];
	});
	const pinned = specimens.find((specimen) => specimen.id === 'badge-0');
	if (!pinned) throw new Error('DashsTrack badge-0 did not materialize');
	const pin = pinned.metrics;
	if (pin.ownedBw !== 2096 || pin.aaAdded !== 278 || pin.residueAfter !== 90) {
		throw new Error(
			`DashsTrack badge-0 pin moved: owned=${pin.ownedBw}, aa=${pin.aaAdded}, residueAfter=${pin.residueAfter}`
		);
	}
	return {
		status: 'materialized',
		note: `${specimens.length} real badges recomputed from the live algorithm; no Storybook fixture file`,
		source: imagePath,
		specimens
	};
}
