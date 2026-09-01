#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import jpeg from 'jpeg-js';
import threeFactor from '@chainspot/alg/detectors/threeFactor';
import badgeEvidenceModule from '@chainspot/alg/detectors/threeFactor/badgeEvidence';
import m1RepresentationModule from '@chainspot/alg/detectors/threeFactor/m1Representation';
import objectsModule from '@chainspot/alg/detectors/threeFactor/objects';
import configModule from '@chainspot/alg/detectors/threeFactor/config';
import measureModule from '@chainspot/alg/detectors/threeFactor/measure';
import featureTypesModule from '@chainspot/alg/detectors/threeFactor/features/types';
import execModule from '@chainspot/alg/exec';

const { DEFAULT_EXECUTION, canonicalJson } = threeFactor;
const { decodeMaterializedBadgeEvidence } = badgeEvidenceModule;
const { decodeMaterializedM1Representation } = m1RepresentationModule;
const { acquireObjectGraphV1 } = objectsModule;
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
const specimens = materializeReceipt.artifacts
	.filter((ref) => ref.kind === 'badgeEvidence')
	.map((ref) => {
		const blob = sink.blobs.get(ref.id);
		if (!blob) throw new Error(`${ref.id}: memory sink lost its content-addressed payload`);
		return decodeMaterializedBadgeEvidence(blob);
	});
const m1Ref = materializeReceipt.artifacts.find((ref) => ref.kind === 'm1Representation');
if (!m1Ref) throw new Error('badge evidence materialization emitted no M1 representation');
const m1Bytes = sink.blobs.get(m1Ref.id);
if (!m1Bytes) throw new Error(`${m1Ref.id}: memory sink lost the M1 payload`);
const m1 = decodeMaterializedM1Representation(m1Bytes);
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

const fields = board.get('badgeStage.components');
const measurement = board.get('measurement');
const graph = acquireObjectGraphV1(measurement, {
	width: image.width,
	height: fields.bright.mask.height,
	brightLabels: fields.bright.labels,
	darkLabels: fields.dark.labels,
	brightComponents: fields.bright.components,
	darkComponents: fields.dark.components
});
const expectedObjects = new Map(
	[...graph.badges, ...graph.baskets].map((object) => [object.id, object])
);
if (m1.components.length !== fields.bright.components.length + fields.dark.components.length)
	throw new Error('M1 primitive inventory drifted from the coherent bright/dark ComponentFields');
if (new Set(m1.components.map((component) => component.id)).size !== m1.components.length)
	throw new Error('M1 primitive ids are not unique');
for (const component of m1.components) {
	if (component.pixels.length !== component.area)
		throw new Error(
			`${component.id}: exact pixel count ${component.pixels.length} != ComponentField area ${component.area}`
		);
}
for (const object of m1.objects) {
	const expected = expectedObjects.get(object.id);
	if (!expected) throw new Error(`${object.id}: M1 invented an object absent from V1 acquisition`);
	const expectedAssembly = expected.raster.componentAssembly;
	if (!expectedAssembly || expectedAssembly.status === 'failed') {
		if (
			object.accounting.status !== 'unknown' ||
			object.componentUses.length ||
			object.relationshipIds.length
		)
			throw new Error(`${object.id}: failed V1 assembly gained fabricated M1 ownership`);
		continue;
	}
	if (object.accounting.status !== 'known')
		throw new Error(`${object.id}: assembled V1 object lost M1 accounting`);
	const expectedPixels = [...expectedAssembly.ownedPixels];
	if (JSON.stringify([...object.accounting.availablePixels]) !== JSON.stringify(expectedPixels))
		throw new Error(`${object.id}: M1 available pixels drifted from V1 assembly ownership`);
	if (JSON.stringify([...object.accounting.explainedPixels]) !== JSON.stringify(expectedPixels))
		throw new Error(`${object.id}: M1 explained pixels drifted from V1 assembly ownership`);
	if (object.accounting.unexplainedPixels.length)
		throw new Error(`${object.id}: clean M1 assembly fabricated unexplained B+W pixels`);
	for (const use of object.componentUses) {
		const primitive = m1.components.find((component) => component.id === use.componentId);
		if (
			!primitive?.consumers.some(
				(consumer) => consumer.objectId === object.id && consumer.role === use.role
			)
		)
			throw new Error(`${object.id}: missing reverse consumer provenance for ${use.componentId}`);
	}
}
const unconsumed = m1.components.filter((component) => component.consumers.length === 0);
if (!unconsumed.length)
	throw new Error('M1 retained no independently addressable unconsumed primitives');
const assembledBadge = m1.objects.find(
	(object) => object.kind === 'badge' && object.accounting.status === 'known'
);
const assembledBasket = m1.objects.find(
	(object) => object.kind === 'basket' && object.accounting.status === 'known'
);
if (!assembledBadge || !assembledBasket)
	throw new Error('M1 proof needs one assembled Badge and Basket');
const setHash = (pixels) =>
	createHash('sha256')
		.update(JSON.stringify([...pixels]))
		.digest('hex');
const summarize = (object) => ({
	id: object.id,
	components: object.componentUses,
	relationships: object.relationshipIds.map((id) =>
		m1.relationships.find((value) => value.id === id)
	),
	available: object.accounting.availablePixels.length,
	explained: object.accounting.explainedPixels.length,
	unexplained: object.accounting.unexplainedPixels.length,
	coverage: object.accounting.availablePixels.length
		? object.accounting.explainedPixels.length / object.accounting.availablePixels.length
		: null,
	pixelSetSha256: setHash(object.accounting.availablePixels)
});

console.log(
	JSON.stringify({
		schema: pin.schema,
		encodedImageId,
		rasterImageId: pin.provenance.imageId,
		paramsHash,
		artifactSha256: materializeReceipt.artifacts[0]?.sha256,
		m1ArtifactSha256: m1Ref.sha256,
		materialized: specimens.length,
		m1: {
			primitiveComponents: m1.components.length,
			unconsumedPrimitiveComponents: unconsumed.length,
			objects: m1.objects.length,
			assembled: m1.objects.filter((object) => object.accounting.status === 'known').length,
			unknown: m1.objects.filter((object) => object.accounting.status === 'unknown').length,
			badge: summarize(assembledBadge),
			basket: summarize(assembledBasket),
			unconsumedExample: {
				id: unconsumed[0].id,
				pixels: unconsumed[0].pixels.length,
				consumers: unconsumed[0].consumers
			}
		},
		badge0: {
			bwOwned: actualPin[0],
			aaAdded: actualPin[1],
			residueBefore: pin.measurements.residueBefore,
			residueAfter: actualPin[2]
		},
		ids: specimens.map((specimen) => specimen.id)
	})
);
