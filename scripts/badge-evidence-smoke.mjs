#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import jpeg from 'jpeg-js';
import threeFactor from '@chainspot/alg/detectors/threeFactor';
import badgeEvidenceModule from '@chainspot/alg/detectors/threeFactor/badgeEvidence';
import configModule from '@chainspot/alg/detectors/threeFactor/config';
import measureModule from '@chainspot/alg/detectors/threeFactor/measure';
import featureTypesModule from '@chainspot/alg/detectors/threeFactor/features/types';
import execModule from '@chainspot/alg/exec';

const { DEFAULT_EXECUTION, canonicalJson } = threeFactor;
const { decodeMaterializedBadgeEvidence } = badgeEvidenceModule;
const { parseConfig, resolveConfig } = configModule;
const { seedBoard } = measureModule;
const { nullFeatureContext } = featureTypesModule;
const { compileExecutionPlan, createExecBoard, createMemorySink, executeCompiledPlan } = execModule;

const corpusRoot = process.env.CHAINSPOT_CORPUS_ROOT
	? resolve(process.env.CHAINSPOT_CORPUS_ROOT)
	: resolve('../chainspot-corpus');
const imagePath = resolve(corpusRoot, 'dev', 'DashsTrack', 'DashsTrack-full.jpg');
const encoded = readFileSync(imagePath);
const encodedImageId = createHash('sha256').update(encoded).digest('hex');
const decoded = jpeg.decode(encoded, { useTArray: true, maxMemoryUsageInMB: 2048 });
const image = {
	width: decoded.width,
	height: decoded.height,
	data: new Uint8ClampedArray(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength)
};

const defaultConfig = parseConfig(
	JSON.parse(
		readFileSync(resolve('packages/alg/src/detectors/threeFactor/configs/default.json'), 'utf8')
	)
);
const baselineConfig = resolveConfig(defaultConfig, DEFAULT_EXECUTION);
const measurementIndex = baselineConfig.execution.indexOf('measurement');
if (measurementIndex < 0) throw new Error('default execution has no measurement unit');
const resolvedConfig = {
	...baselineConfig,
	name: 'badge-evidence-proof',
	execution: [
		...baselineConfig.execution.slice(0, measurementIndex + 1),
		'badgeEvidence',
		...baselineConfig.execution.slice(measurementIndex + 1)
	]
};
const paramsHash = createHash('sha256').update(canonicalJson(resolvedConfig)).digest('hex');
const plan = compileExecutionPlan(resolvedConfig, paramsHash);
const board = createExecBoard();
seedBoard(board, image, undefined);
board.set('paramsHash', paramsHash);
board.set('recoveredTees', []);
board.set('straightTestTruthAssistance', { mode: 'blind', locks: [] });
const sink = createMemorySink();
const receipts = executeCompiledPlan(plan, board, nullFeatureContext, sink);

const materializeReceipt = receipts.find((receipt) => receipt.opId === 'badgeEvidence.materialize');
if (!materializeReceipt) throw new Error('badge evidence materialization receipt is missing');
const specimens = materializeReceipt.artifacts.map((ref) => {
	if (ref.kind !== 'badgeEvidence')
		throw new Error(`${ref.id}: unexpected artifact kind ${ref.kind}`);
	const blob = sink.blobs.get(ref.id);
	if (!blob) throw new Error(`${ref.id}: memory sink lost its content-addressed payload`);
	return decodeMaterializedBadgeEvidence(blob);
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
	if (specimen.provenance.paramsHash !== paramsHash)
		throw new Error(`${specimen.id}: params provenance drifted from the compiled plan`);
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
		encodedImageId,
		rasterImageId: pin.provenance.imageId,
		paramsHash,
		artifactSha256: materializeReceipt.artifacts[0]?.sha256,
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
