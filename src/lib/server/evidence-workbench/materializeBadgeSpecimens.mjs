import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import * as threeFactorNamespace from '@chainspot/alg/detectors/threeFactor';
import * as badgeEvidenceNamespace from '@chainspot/alg/detectors/threeFactor/badgeEvidence';
import * as m1RepresentationNamespace from '@chainspot/alg/detectors/threeFactor/m1Representation';
import * as configNamespace from '@chainspot/alg/detectors/threeFactor/config';
import * as measureNamespace from '@chainspot/alg/detectors/threeFactor/measure';
import * as featureTypesNamespace from '@chainspot/alg/detectors/threeFactor/features/types';
import * as execNamespace from '@chainspot/alg/exec';
import * as nodeIntakeNamespace from '@chainspot/alg/exec/node-intake';

function exported(namespace, name) {
	return namespace[name] ?? namespace.default?.[name];
}

const DEFAULT_EXECUTION = exported(threeFactorNamespace, 'DEFAULT_EXECUTION');
const canonicalJson = exported(threeFactorNamespace, 'canonicalJson');
const decodeMaterializedBadgeEvidence = exported(
	badgeEvidenceNamespace,
	'decodeMaterializedBadgeEvidence'
);
const decodeMaterializedM1Representation = exported(
	m1RepresentationNamespace,
	'decodeMaterializedM1Representation'
);
const parseConfig = exported(configNamespace, 'parseConfig');
const resolveConfig = exported(configNamespace, 'resolveConfig');
const seedBoard = exported(measureNamespace, 'seedBoard');
const nullFeatureContext = exported(featureTypesNamespace, 'nullFeatureContext');
const compileExecutionPlan = exported(execNamespace, 'compileExecutionPlan');
const createMemorySink = exported(execNamespace, 'createMemorySink');
const executeCompiledPlan = exported(execNamespace, 'executeCompiledPlan');
const composePcr = exported(execNamespace, 'composePcr');
const executeNodeCanonicalInputTick = exported(
	nodeIntakeNamespace,
	'executeNodeCanonicalInputTick'
);

function unavailableLibrary(sourceId) {
	return {
		status: 'unavailable',
		note: `Real E materialization unavailable: ${sourceId} does not exist. Set CHAINSPOT_BADGE_IMAGE or place chainspot-corpus beside ChainSpot.`,
		source: sourceId,
		m1: null,
		pcrs: [],
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

function asStorybookM1(value, artifact) {
	return {
		artifact: { id: artifact.id, sha256: artifact.sha256 },
		raster: value.raster,
		components: value.components.map((component) => ({
			...component,
			pixels: Array.from(component.pixels)
		})),
		relationships: value.relationships,
		basketShellFamilies: value.basketShellFamilies,
		objects: value.objects.map((object) => ({
			...object,
			accounting:
				object.accounting.status === 'known'
					? {
							...object.accounting,
							availablePixels: Array.from(object.accounting.availablePixels),
							explainedPixels: Array.from(object.accounting.explainedPixels),
							unexplainedPixels: Array.from(object.accounting.unexplainedPixels)
						}
					: object.accounting
		}))
	};
}

function localMask(specimen, pixels) {
	const [x0, y0, width, height] = specimen.region.bbox;
	const mask = new Array(width * height).fill(0);
	for (const pixel of pixels) {
		const x = pixel % specimen.raster.width;
		const y = (pixel - x) / specimen.raster.width;
		if (x >= x0 && y >= y0 && x < x0 + width && y < y0 + height)
			mask[(y - y0) * width + x - x0] = 1;
	}
	return mask;
}

function asStorybookSpecimen(specimen, artifact) {
	const [x, y, width, height] = specimen.region.bbox;
	const ownedMask = localMask(specimen, specimen.ownedBwPixels);
	const aaMask = localMask(specimen, specimen.aaPixels);
	const residueAfterMask = localMask(specimen, specimen.residuePixels);
	return {
		id: specimen.id,
		title: `${specimen.id}${specimen.badge.label ? ` · hole ${specimen.badge.label}` : ' · UNREAD'}`,
		course: 'DashsTrack',
		detectorId: specimen.badge.detId,
		holeLabel: specimen.badge.label,
		sourceSha256: specimen.provenance.imageId,
		crop: { x, y, width, height },
		sourceRgba: Array.from(specimen.region.rgba),
		brightMask: Array.from(specimen.region.brightMask),
		darkMask: Array.from(specimen.region.darkMask),
		ownedMask,
		aaMask,
		residueBeforeMask: ownedMask.map((value) => (value ? 0 : 1)),
		residueAfterMask,
		metrics: {
			ownedBw: specimen.measurements.bwOwnedPixelCount,
			aaAdded: specimen.measurements.aaAddedPixelCount,
			residueBefore: specimen.measurements.residueBefore,
			residueAfter: specimen.measurements.residueAfter
		},
		provenance: [
			`artifact ${artifact.id} sha256:${artifact.sha256}`,
			`schema ${specimen.schema}`,
			`raster ${specimen.provenance.imageId}`,
			`params ${specimen.provenance.paramsHash}`,
			`${specimen.provenance.detector}@${specimen.provenance.detectorVersion}`
		]
	};
}

/** Execute the opt-in E producer, then consume only its content-addressed artifacts. */
export async function materializeBadgeSpecimens() {
	const configuredImage = process.env.CHAINSPOT_BADGE_IMAGE;
	const imagePath = resolve(
		configuredImage ?? '../chainspot-corpus/dev/DashsTrack/DashsTrack-full.jpg'
	);
	const sourceId =
		process.env.CHAINSPOT_BADGE_SOURCE_ID ??
		(configuredImage
			? `configured/${basename(configuredImage)}`
			: 'chainspot-corpus/dev/DashsTrack/DashsTrack-full.jpg');
	if (!existsSync(imagePath)) return unavailableLibrary(sourceId);

	const intake = await executeNodeCanonicalInputTick(imagePath);
	const board = intake.pxc;
	const image = {
		width: intake.input.widthPx,
		height: intake.input.heightPx,
		data: intake.input.rgba
	};
	const intakePcr = composePcr(
		{
			id: 'intake-pcr',
			title: 'Canonical Input PCR',
			tickIds: [intake.testimony.opId]
		},
		intake.plan,
		[intake.testimony]
	);
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
		name: 'storybook-badge-e',
		execution: [
			...baselineConfig.execution.slice(0, measurementIndex + 1),
			'badgeEvidence',
			...baselineConfig.execution.slice(measurementIndex + 1)
		]
	};
	const paramsHash = createHash('sha256').update(canonicalJson(resolvedConfig)).digest('hex');
	const plan = compileExecutionPlan(resolvedConfig, paramsHash);
	// Seed the engine's established aliases over the exact canonical RGBA bytes
	// already held by PxC. S1 does not decode or normalize a second copy.
	seedBoard(board, image, undefined);
	board.set('paramsHash', paramsHash);
	board.set('recoveredTees', []);
	board.set('straightTestTruthAssistance', { mode: 'blind', locks: [] });
	const sink = createMemorySink();
	const receipts = executeCompiledPlan(plan, board, nullFeatureContext, sink);
	const badgePcr = composePcr(
		{
			id: 'badge-pcr',
			title: 'Badge PCR',
			tickIds: [
				'badgeStage.masks',
				'badgeStage.components',
				'badgeStage.family',
				'badgeStage.badges',
				'badges',
				'badgeEvidence.materialize'
			]
		},
		plan,
		receipts
	);
	const basketPcr = composePcr(
		{
			id: 'basket-pcr',
			title: 'Basket PCR',
			tickIds: ['baskets', 'badgeEvidence.materialize']
		},
		plan,
		receipts
	);
	const visibleTeePcr = composePcr(
		{
			id: 'visible-tee-pcr',
			title: 'Visible Tee PCR',
			tickIds: ['tees.ringMeasure', 'tees.exclusion', 'teeFamily']
		},
		plan,
		receipts
	);
	const teeBasketLineworkPcr = composePcr(
		{
			id: 'tee-basket-linework-pcr',
			title: 'TeeBasket Linework PCR',
			tickIds: [
				'supportField',
				'badgeOcclusionPatch',
				'rawPairs',
				'measurement',
				'assignment.pairs',
				'assignment.scoring',
				'assignment.ranking',
				'assignment.selection'
			]
		},
		plan,
		receipts
	);
	const teeRecoveryPcr = composePcr(
		{
			id: 'tee-recovery-pcr',
			title: 'Tee Recovery PCR',
			tickIds: ['teeRecovery', 'teeBadgeLock']
		},
		plan,
		receipts
	);
	const receipt = receipts.find((candidate) => candidate.opId === 'badgeEvidence.materialize');
	if (!receipt) throw new Error('E emitted no badgeEvidence.materialize receipt');
	const specimens = receipt.artifacts
		.filter((artifact) => artifact.kind === 'badgeEvidence')
		.map((artifact) => {
			const bytes = sink.blobs.get(artifact.id);
			if (!bytes) throw new Error(`${artifact.id}: E sink lost its artifact bytes`);
			return asStorybookSpecimen(decodeMaterializedBadgeEvidence(bytes), artifact);
		});
	const m1Artifact = receipt.artifacts.find((artifact) => artifact.kind === 'm1Representation');
	if (!m1Artifact) throw new Error('E emitted no M1 representation artifact');
	const m1Bytes = sink.blobs.get(m1Artifact.id);
	if (!m1Bytes) throw new Error(`${m1Artifact.id}: E sink lost its artifact bytes`);
	return {
		status: 'materialized',
		note: `${specimens.length} badges decoded from content-addressed E artifacts`,
		source: sourceId,
		pcrs: [intakePcr, badgePcr, basketPcr, visibleTeePcr, teeBasketLineworkPcr, teeRecoveryPcr],
		specimens,
		m1: asStorybookM1(decodeMaterializedM1Representation(m1Bytes), m1Artifact)
	};
}
