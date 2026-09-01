#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import jpeg from 'jpeg-js';
import threeFactor from '@chainspot/alg/detectors/threeFactor';
import badgeEvidenceModule from '@chainspot/alg/detectors/threeFactor/badgeEvidence';
import badgeStageModule from '@chainspot/alg/detectors/threeFactor/badgeStage';
import componentFieldModule from '@chainspot/alg/detectors/threeFactor/componentField';
import objectsModule from '@chainspot/alg/detectors/threeFactor/objects';

const {
	DEFAULT_EXECUTION,
	THREE_FACTOR_ALGO,
	THREE_FACTOR_ALGO_VERSION,
	canonicalJson,
	runThreeFactor
} = threeFactor;
const { materializeBadgeEvidence } = badgeEvidenceModule;
const { runBadgeStage } = badgeStageModule;
const { groupBrightDarkComponentFields } = componentFieldModule;
const { acquireObjectGraphV1, requireComponentAssembly } = objectsModule;

const corpusRoot = process.env.CHAINSPOT_CORPUS_ROOT
	? resolve(process.env.CHAINSPOT_CORPUS_ROOT)
	: resolve('../chainspot-corpus');
const imagePath = resolve(corpusRoot, 'dev', 'DashsTrack', 'DashsTrack-full.jpg');
const encoded = readFileSync(imagePath);
const imageId = createHash('sha256').update(encoded).digest('hex');
const decoded = jpeg.decode(encoded, { useTArray: true, maxMemoryUsageInMB: 2048 });
const image = {
	imageId,
	widthPx: decoded.width,
	heightPx: decoded.height,
	rgba: new Uint8ClampedArray(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength)
};
const stageImage = { width: image.widthPx, height: image.heightPx, data: image.rgba };
const stage = runBadgeStage(stageImage);
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
const paramsHash = createHash('sha256')
	.update(canonicalJson({ name: 'frozen-default', execution: DEFAULT_EXECUTION, features: {} }))
	.digest('hex');
const provenance = {
	imageId,
	paramsHash,
	detector: THREE_FACTOR_ALGO,
	detectorVersion: THREE_FACTOR_ALGO_VERSION
};

const specimens = graph.badges.flatMap((object) => {
	if (object.raster.componentAssembly?.status !== 'assembled') return [];
	return [
		materializeBadgeEvidence(
			stageImage,
			fields,
			object.evidence,
			requireComponentAssembly(object),
			provenance
		)
	];
});
if (specimens.length < 3)
	throw new Error(`expected several materialized badges; got ${specimens.length}`);
if (new Set(specimens.map((specimen) => specimen.id)).size !== specimens.length)
	throw new Error('materialized badge ids are not unique within the run');
for (const specimen of specimens) {
	const owned = new Set(specimen.ownedBwPixels);
	const aa = new Set(specimen.aaPixels);
	const residue = new Set(specimen.residuePixels);
	if ([...owned].some((pixel) => aa.has(pixel) || residue.has(pixel)))
		throw new Error(`${specimen.id}: owned pixels overlap refinement/residue`);
	if ([...aa].some((pixel) => residue.has(pixel)))
		throw new Error(`${specimen.id}: AA pixels overlap residue`);
	const regionPixels = specimen.region.bbox[2] * specimen.region.bbox[3];
	if (owned.size + aa.size + residue.size !== regionPixels)
		throw new Error(`${specimen.id}: ownership + residue does not reconstruct its region`);
	if (specimen.measurements.bwOwnedPixelCount !== owned.size)
		throw new Error(`${specimen.id}: B+W count drifted during refinement`);
}

const pin = specimens.find((specimen) => specimen.id === 'badge-0');
if (!pin) throw new Error('badge-0 did not materialize');
const actualPin = [
	pin.measurements.bwOwnedPixelCount,
	pin.measurements.aaAddedPixelCount,
	pin.measurements.residueAfter
];
if (actualPin.join('/') !== '2096/278/90')
	throw new Error(`badge-0 pin drifted: expected 2096/278/90, got ${actualPin.join('/')}`);

console.log(
	JSON.stringify({
		schema: pin.schema,
		imageId,
		paramsHash,
		materialized: specimens.length,
		badge0: {
			bwOwned: actualPin[0],
			aaAdded: actualPin[1],
			residueBefore: pin.measurements.residueBefore,
			residueAfter: actualPin[2]
		},
		ids: specimens.map((specimen) => specimen.id)
	})
);
