import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { ChainSpotCvConfig } from '../src/lib/autoAnnotation/cvConfig';
import { CV_PARAM_SCHEMA, DEFAULT_CV_CONFIG } from '../src/lib/autoAnnotation/cvConfig';
import type { CvStageId, PancakeResult, StageExecutionRecord } from '../src/lib/autoAnnotation/cvPipeline';
import { DEFAULT_RIBBON_MASS_PARAMS, nearestComponentLabel } from '../src/lib/autoAnnotation/ribbonMass';
import type { RibbonMassSegmentation } from '../src/lib/autoAnnotation/ribbonMass';
import { score } from '../src/lib/autoAnnotation/p6AssignmentScoring';
import type { TruthHole } from '../src/lib/autoAnnotation/p6AssignmentScoring';
import type { RawMaskBasket, RawMaskTee } from '../src/lib/autoAnnotation/rawObjectMask';
import type { LoadedCvImage } from './lib/cvReplayCore';
import { loadCvReplayContext, loadExternalTruth, runCvReplayPipeline } from './lib/cvReplayCore';

type TophRuntime = typeof import('/workspace/toph/src/runtime/index.js');
type TophReplay = typeof import('/workspace/toph/src/replay/index.js');
type TraceRun = import('/workspace/toph/src/runtime/index.js').TraceRun;
type ReplayAdapter = import('/workspace/toph/src/replay/index.js').ReplayAdapter;
type AdapterRunOutput = import('/workspace/toph/src/replay/index.js').AdapterRunOutput;
type ParamSpec = import('/workspace/toph/src/replay/index.js').ParamSpec;
type EvidenceShape = import('/workspace/toph/src/runtime/index.js').EvidenceShape;

async function importToph(tophDir: string): Promise<{ runtime: TophRuntime; replay: TophReplay }> {
	const runtimeUrl = pathToFileURL(resolve(tophDir, 'src/runtime/index.ts')).href;
	const replayUrl = pathToFileURL(resolve(tophDir, 'src/replay/index.ts')).href;
	const runtime = (await import(runtimeUrl)) as TophRuntime;
	const replay = (await import(replayUrl)) as TophReplay;
	if (typeof runtime.recordEvidence !== 'function') {
		throw new Error('Toph checkout does not expose recordEvidence(); use the evidence-first viewer branch.');
	}
	return { runtime, replay };
}

const STAGE_ORDER: readonly CvStageId[] = [
	'source',
	'p1.rawObjectMask',
	'p2.holeNumbers',
	'p3.ownership',
	'p4.ribbonSegmentation',
	'p4.ribbonOwnership',
	'p5.sparseAssignment',
	'p6.lowParAssignment',
	'p6.swapAdjudication',
	'final.displayGrammar'
];
const STAGE_NUMERIC_ID = new Map<CvStageId, number>(STAGE_ORDER.map((id, index) => [id, index + 1]));

const ENTITY_KIND = { hole: 1, basket: 2, tee: 3 } as const;
const CHECK_P1_BASKET_AREA = 1;
const CHECK_P6_FORWARD_ANGLE = 2;
const CHECK_P6_SWAP_IMPROVEMENT = 3;
const BRIGHT_LABELMAP_ASSET_ID = 1;

function buildManifest(): unknown {
	return {
		stages: STAGE_ORDER.map((id) => ({
			id: STAGE_NUMERIC_ID.get(id),
			name: id,
			kind: 'filter',
			source: { file: 'src/lib/autoAnnotation/cvPipeline.ts', line: 0 }
		})),
		checks: [
			{ id: CHECK_P1_BASKET_AREA, stageId: STAGE_NUMERIC_ID.get('p1.rawObjectMask'), code: 'p1.basket.area.min', label: 'Basket component area', operator: 'gte', unit: 'px', source: { file: 'src/lib/autoAnnotation/rawObjectMask.ts', line: 0 } },
			{ id: CHECK_P6_FORWARD_ANGLE, stageId: STAGE_NUMERIC_ID.get('p6.lowParAssignment'), code: 'p6.forwardAngleDeg <= forwardGateAngleDeg', label: 'Forward gate angle', operator: 'lte', unit: 'deg', source: { file: 'src/lib/autoAnnotation/p6LowParBasketAssignment.ts', line: 0 } },
			{ id: CHECK_P6_SWAP_IMPROVEMENT, stageId: STAGE_NUMERIC_ID.get('p6.swapAdjudication'), code: 'ribbonImprovementPx >= minRibbonImprovementPx', label: 'Ribbon improvement', operator: 'gte', unit: 'px', source: { file: 'src/lib/autoAnnotation/p6LowParBasketAssignment.ts', line: 0 } }
		],
		assets: [{ id: BRIGHT_LABELMAP_ASSET_ID, name: 'P1 bright-mask components', kind: 'mask' }],
		entityKinds: [
			{ id: ENTITY_KIND.hole, name: 'Hole', source: { file: 'src/lib/autoAnnotation/cvPipeline.ts', line: 0 } },
			{ id: ENTITY_KIND.basket, name: 'Basket', source: { file: 'src/lib/autoAnnotation/rawObjectMask.ts', line: 0 } },
			{ id: ENTITY_KIND.tee, name: 'Tee', source: { file: 'src/lib/autoAnnotation/rawObjectMask.ts', line: 0 } }
		],
		summaryLabels: {
			wallMs: 'Wall time (ms)',
			holes: 'Holes',
			assignedByLowPar: 'Assigned by low-par (P6.1)',
			lockedByP4: 'Locked by P4',
			unresolved: 'Unresolved',
			'p62.swapsApplied': 'Swaps applied (P6.2)',
			'p62.changedHoles': 'Holes changed by swap'
		}
	};
}

interface BrightComponent {
	readonly label: number;
	readonly minX: number;
	readonly minY: number;
	readonly maxX: number;
	readonly maxY: number;
	readonly widthPx: number;
	readonly heightPx: number;
	readonly areaPx: number;
	readonly centroidX: number;
	readonly centroidY: number;
}

interface BrightLabelmapBuild {
	readonly labels: Int32Array;
	readonly components: readonly BrightComponent[];
}

/**
 * Replays P1's exact bright-mask predicate + 8-connected flood fill over the same decoded
 * source bytes. This is observational only. We fail closed if the reproduced component count
 * differs from P1's own diagnostics, so Toph never draws a mask that silently disagrees with
 * the pipeline it claims to explain.
 */
export function buildP1BrightLabelmap(image: LoadedCvImage, brightValueMin: number, brightSaturationMax: number): BrightLabelmapBuild {
	const { rgba, widthPx: width, heightPx: height } = image;
	const pixelCount = width * height;
	const mask = new Uint8Array(pixelCount);
	for (let index = 0; index < pixelCount; index += 1) {
		const offset = index * 4;
		const r = rgba[offset];
		const g = rgba[offset + 1];
		const b = rgba[offset + 2];
		const max = r > g ? (r > b ? r : b) : g > b ? g : b;
		const min = r < g ? (r < b ? r : b) : g < b ? g : b;
		const saturation = max === 0 ? 0 : Math.round(((max - min) * 255) / max);
		if (max > brightValueMin && saturation < brightSaturationMax) mask[index] = 1;
	}

	const labels = new Int32Array(pixelCount);
	const queue = new Int32Array(pixelCount);
	const components: BrightComponent[] = [];
	let nextLabel = 1;
	for (let seed = 0; seed < pixelCount; seed += 1) {
		if (mask[seed] !== 1 || labels[seed] !== 0) continue;
		let head = 0;
		let tail = 0;
		queue[tail++] = seed;
		labels[seed] = nextLabel;
		let minX = width;
		let minY = height;
		let maxX = -1;
		let maxY = -1;
		let area = 0;
		let sumX = 0;
		let sumY = 0;
		while (head < tail) {
			const index = queue[head++];
			const x = index % width;
			const y = (index - x) / width;
			area += 1;
			sumX += x;
			sumY += y;
			if (x < minX) minX = x;
			if (x > maxX) maxX = x;
			if (y < minY) minY = y;
			if (y > maxY) maxY = y;
			const y0 = Math.max(0, y - 1);
			const y1 = Math.min(height - 1, y + 1);
			const x0 = Math.max(0, x - 1);
			const x1 = Math.min(width - 1, x + 1);
			for (let ny = y0; ny <= y1; ny += 1) {
				const row = ny * width;
				for (let nx = x0; nx <= x1; nx += 1) {
					if (nx === x && ny === y) continue;
					const neighbor = row + nx;
					if (mask[neighbor] !== 1 || labels[neighbor] !== 0) continue;
					labels[neighbor] = nextLabel;
					queue[tail++] = neighbor;
				}
			}
		}
		const widthPx = maxX - minX + 1;
		const heightPx = maxY - minY + 1;
		components.push({ label: nextLabel, minX, minY, maxX, maxY, widthPx, heightPx, areaPx: area, centroidX: sumX / area, centroidY: sumY / area });
		nextLabel += 1;
	}
	return { labels, components };
}

function encodeLabelmapRle(labels: Int32Array, widthPx: number, heightPx: number, entityIds: readonly (number | undefined)[]): unknown {
	const runs: Array<[number, number]> = [];
	let value = labels.length > 0 ? labels[0] : 0;
	let count = 0;
	for (let i = 0; i < labels.length; i += 1) {
		const next = labels[i];
		if (next === value) { count += 1; continue; }
		runs.push([value, count]);
		value = next;
		count = 1;
	}
	if (count > 0) runs.push([value, count]);
	return { assetId: BRIGHT_LABELMAP_ASSET_ID, widthPx, heightPx, encoding: 'rle', space: 'source', entityIds, runs };
}

function matchBasketComponent(basket: RawMaskBasket, components: readonly BrightComponent[]): BrightComponent | undefined {
	return components.find((component) =>
		component.areaPx === basket.areaPx && component.widthPx === basket.widthPx && component.heightPx === basket.heightPx &&
		Math.abs((component.minX + component.maxX) / 2 - basket.centerXPx) < 1e-9 &&
		Math.abs((component.minY + component.maxY) / 2 - basket.centerYPx) < 1e-9
	);
}

function matchTeeComponent(tee: RawMaskTee, components: readonly BrightComponent[]): BrightComponent | undefined {
	return components.find((component) =>
		component.areaPx === tee.areaPx && component.widthPx === tee.widthPx && component.heightPx === tee.heightPx &&
		Math.abs(component.centroidX - tee.xPx) < 1e-9 && Math.abs(component.centroidY - tee.yPx) < 1e-9
	);
}

interface NearestComponentPoint {
	readonly xPx: number;
	readonly yPx: number;
	readonly distancePx: number;
}

/** Exact singleton-label counterpart of ribbonMass.nearestKeptDistancePx, retaining the winning pixel. */
export function nearestRibbonComponentPoint(segmentation: Pick<RibbonMassSegmentation, 'labels' | 'widthEv' | 'heightEv' | 'scale'>, componentLabel: number, xSrcPx: number, ySrcPx: number): NearestComponentPoint | null {
	const { labels, widthEv, heightEv, scale } = segmentation;
	const xi = Math.min(Math.max(Math.round(xSrcPx / scale), 0), widthEv - 1);
	const yi = Math.min(Math.max(Math.round(ySrcPx / scale), 0), heightEv - 1);
	let bestD2 = Infinity;
	let bestX = -1;
	let bestY = -1;
	for (let y = 0; y < heightEv; y += 1) {
		const dy = y - yi;
		if (dy * dy >= bestD2) continue;
		for (let x = 0; x < widthEv; x += 1) {
			if (labels[y * widthEv + x] !== componentLabel) continue;
			const dx = x - xi;
			const d2 = dx * dx + dy * dy;
			if (d2 < bestD2) { bestD2 = d2; bestX = x; bestY = y; }
		}
	}
	if (!Number.isFinite(bestD2)) return null;
	return { xPx: bestX * scale, yPx: bestY * scale, distancePx: Math.sqrt(bestD2) * scale };
}

function angleDeg(dx: number, dy: number): number {
	return (Math.atan2(dy, dx) * 180) / Math.PI;
}

function assertDistance(label: string, expected: number | null, actual: NearestComponentPoint | null): void {
	if (expected === null) return;
	if (!actual || Math.abs(expected - actual.distancePx) > 1e-9) {
		throw new Error(`Toph evidence drift at ${label}: pipeline=${expected}, reproduced=${actual?.distancePx ?? 'null'}`);
	}
}

function decisiveSwapPairs(pipeline: PancakeResult) {
	const pairs = [...(pipeline.p6LowParBasketAssignment.swapAdjudication?.pairs ?? [])];
	const applied = pairs.filter((pair) => pair.swapApplied);
	if (applied.length > 0) return applied;
	return pairs
		.filter((pair) => pair.ribbonImprovementPx !== null)
		.sort((a, b) => (b.ribbonImprovementPx ?? -Infinity) - (a.ribbonImprovementPx ?? -Infinity))
		.slice(0, 1);
}

function preSwapBasketByHole(pipeline: PancakeResult): Map<number, number> {
	const result = new Map<number, number>();
	for (const assignment of pipeline.p6LowParBasketAssignment.assignments) {
		if (assignment.assignedBasketIndex !== null) result.set(assignment.holeNumber, assignment.assignedBasketIndex);
	}
	for (const pair of pipeline.p6LowParBasketAssignment.swapAdjudication?.pairs ?? []) {
		if (!pair.swapApplied) continue;
		result.set(pair.holeA, pair.basketX);
		result.set(pair.holeB, pair.basketY);
	}
	return result;
}

interface SynthesizedTrace {
	readonly trace: TraceRun;
	readonly labelmaps: readonly unknown[];
}

function synthesizeTrace(runtime: TophRuntime, pipeline: PancakeResult, stageRecords: readonly StageExecutionRecord[], config: ChainSpotCvConfig, source: LoadedCvImage): SynthesizedTrace {
	runtime.startTrace({ pipeline: 'chainspot.pancake' });
	const holeRefByNumber = new Map(pipeline.p2LabeledBadges.map((badge) => [badge.holeNumber, badge]));
	const basketRefs = pipeline.rawMaskObjects.baskets;
	const teeRefs = pipeline.rawMaskObjects.tees;
	const basketEntityIds: number[] = [];
	const teeEntityIds: number[] = [];
	const holeEntityIdByNumber = new Map<number, number>();
	const p1 = buildP1BrightLabelmap(source, pipeline.rawMaskObjects.diagnostics.thresholds.brightValueMin, pipeline.rawMaskObjects.diagnostics.thresholds.brightSaturationMax);
	if (p1.components.length !== pipeline.rawMaskObjects.diagnostics.brightComponentCount) {
		throw new Error(`Toph P1 evidence drift: reproduced ${p1.components.length} bright components, pipeline reported ${pipeline.rawMaskObjects.diagnostics.brightComponentCount}`);
	}
	const labelEntityIds: Array<number | undefined> = new Array(p1.components.length).fill(undefined);
	const preSwap = preSwapBasketByHole(pipeline);
	const decisivePairs = decisiveSwapPairs(pipeline);
	const decisiveHoleNumbers = new Set(decisivePairs.flatMap((pair) => [pair.holeA, pair.holeB]));

	for (const record of stageRecords) {
		const stageId = STAGE_NUMERIC_ID.get(record.id);
		if (stageId === undefined) continue;
		const invocationId = runtime.enterStage(stageId);
		for (const [name, value] of Object.entries(record.summary)) runtime.recordMeasure(invocationId, name, value);

		if (record.id === 'p1.rawObjectMask') {
			basketEntityIds.push(...runtime.spawnEntities(ENTITY_KIND.basket, basketRefs as unknown as readonly unknown[]));
			teeEntityIds.push(...runtime.spawnEntities(ENTITY_KIND.tee, teeRefs as unknown as readonly unknown[]));
			basketRefs.forEach((basket, index) => {
				const component = matchBasketComponent(basket, p1.components);
				if (!component) throw new Error(`Toph P1 evidence could not resolve basket ${index} back to its bright component.`);
				labelEntityIds[component.label - 1] = basketEntityIds[index];
				const el = runtime.enterElement(invocationId, basket);
				const pass = runtime.gte(el, CHECK_P1_BASKET_AREA, basket.areaPx, 80);
				if (pass) runtime.keep(el);
				runtime.recordEvidence({
					stageInvocationId: invocationId,
					entityId: basketEntityIds[index],
					label: 'P1 bright-mask basket component',
					checkId: CHECK_P1_BASKET_AREA,
					value: basket.areaPx,
					unit: 'px',
					operator: 'gte',
					threshold: 80,
					decision: pass ? 'PASS' : 'FAIL',
					role: 'measured',
					shapes: [
						{ t: 'component', assetId: BRIGHT_LABELMAP_ASSET_ID, label: component.label },
						{ t: 'bbox', x: component.minX, y: component.minY, w: component.widthPx, h: component.heightPx, label: 'bright component bbox' }
					]
				});
			});
			teeRefs.forEach((tee, index) => {
				const component = matchTeeComponent(tee, p1.components);
				if (component) labelEntityIds[component.label - 1] = teeEntityIds[index];
			});
		}

		if (record.id === 'p2.holeNumbers') {
			const ids = runtime.spawnEntities(ENTITY_KIND.hole, pipeline.p2LabeledBadges as unknown as readonly unknown[]);
			pipeline.p2LabeledBadges.forEach((badge, index) => holeEntityIdByNumber.set(badge.holeNumber, ids[index]));
		}

		if (record.id === 'p6.lowParAssignment') {
			for (const [holeNumber, basketIndex] of preSwap) {
				const assignment = pipeline.p6LowParBasketAssignment.assignments.find((candidate) => candidate.holeNumber === holeNumber);
				const holeRef = holeRefByNumber.get(holeNumber);
				const holeEntityId = holeEntityIdByNumber.get(holeNumber);
				const basket = basketRefs[basketIndex];
				const basketEntityId = basketEntityIds[basketIndex];
				const tee = assignment?.teeIndex === null || assignment?.teeIndex === undefined ? undefined : teeRefs[assignment.teeIndex];
				if (!assignment || !holeRef || !holeEntityId || !basket || !basketEntityId || !tee) continue;
				runtime.recordDataflow({ t: 'relate', stage: invocationId, left: basketEntityId, right: holeEntityId, relation: 'assigned' });
				const candidate = pipeline.p6LowParBasketAssignment.candidates.find((c) => c.holeNumber === holeNumber && c.basketIndex === basketIndex);
				if (!candidate) continue;
				const el = runtime.enterElement(invocationId, basket);
				const pass = runtime.lte(el, CHECK_P6_FORWARD_ANGLE, candidate.forwardAngleDeg, config.p6.forwardGateAngleDeg);
				if (pass) runtime.keep(el);
				const axisDeg = angleDeg(holeRef.xPx - tee.xPx, holeRef.yPx - tee.yPx);
				const candidateDeg = angleDeg(basket.centerXPx - holeRef.xPx, basket.centerYPx - holeRef.yPx);
				const radius = Math.min(140, Math.max(55, Math.hypot(basket.centerXPx - holeRef.xPx, basket.centerYPx - holeRef.yPx) * 0.25));
				runtime.recordEvidence({
					stageInvocationId: invocationId,
					entityId: basketEntityId,
					label: `Forward gate angle — Hole ${holeNumber}`,
					checkId: CHECK_P6_FORWARD_ANGLE,
					value: candidate.forwardAngleDeg,
					unit: 'deg',
					operator: 'lte',
					threshold: config.p6.forwardGateAngleDeg,
					decision: pass ? 'PASS' : assignment.gateFallbackUsed ? 'FALLBACK' : 'FAIL',
					role: decisiveHoleNumbers.has(holeNumber) ? 'current' : 'context',
					shapes: [
						{ t: 'segment', x1: tee.xPx, y1: tee.yPx, x2: holeRef.xPx, y2: holeRef.yPx, label: 'tee → badge forward axis' },
						{ t: 'segment', x1: holeRef.xPx, y1: holeRef.yPx, x2: basket.centerXPx, y2: basket.centerYPx, label: 'badge → candidate basket' },
						{ t: 'angle', x: holeRef.xPx, y: holeRef.yPx, fromDeg: axisDeg, toDeg: candidateDeg, radius, label: `${candidate.forwardAngleDeg.toFixed(1)}°` }
					]
				});
			}
		}

		if (record.id === 'p6.swapAdjudication') {
			const swap = pipeline.p6LowParBasketAssignment.swapAdjudication;
			const segmentation = pipeline.ribbonSegmentation;
			const badgeByHole = new Map(pipeline.p2LabeledBadges.map((badge) => [badge.holeNumber, badge]));
			for (const pair of swap?.pairs ?? []) {
				if (pair.ribbonImprovementPx === null) continue;
				const pairElementId = runtime.enterElement(invocationId);
				const pass = runtime.gte(pairElementId, CHECK_P6_SWAP_IMPROVEMENT, pair.ribbonImprovementPx, config.p6.swap.minRibbonImprovementPx);
				if (pair.swapApplied) runtime.keep(pairElementId);
				if (!decisivePairs.includes(pair)) continue;
				const badgeA = badgeByHole.get(pair.holeA);
				const badgeB = badgeByHole.get(pair.holeB);
				const basketX = basketRefs[pair.basketX];
				const basketY = basketRefs[pair.basketY];
				if (!badgeA || !badgeB || !basketX || !basketY) continue;
				const componentA = nearestComponentLabel(segmentation.labels, segmentation.widthEv, segmentation.heightEv, segmentation.scale, badgeA.xPx, badgeA.yPx, DEFAULT_RIBBON_MASS_PARAMS.seedRadiusPx);
				const componentB = nearestComponentLabel(segmentation.labels, segmentation.widthEv, segmentation.heightEv, segmentation.scale, badgeB.xPx, badgeB.yPx, DEFAULT_RIBBON_MASS_PARAMS.seedRadiusPx);
				if (componentA === null || componentB === null) continue;
				const ax = nearestRibbonComponentPoint(segmentation, componentA, basketX.centerXPx, basketX.centerYPx);
				const ay = nearestRibbonComponentPoint(segmentation, componentA, basketY.centerXPx, basketY.centerYPx);
				const bx = nearestRibbonComponentPoint(segmentation, componentB, basketX.centerXPx, basketX.centerYPx);
				const by = nearestRibbonComponentPoint(segmentation, componentB, basketY.centerXPx, basketY.centerYPx);
				assertDistance(`H${pair.holeA}↔basket${pair.basketX}`, pair.ribbonAX, ax);
				assertDistance(`H${pair.holeA}↔basket${pair.basketY}`, pair.ribbonAY, ay);
				assertDistance(`H${pair.holeB}↔basket${pair.basketX}`, pair.ribbonBX, bx);
				assertDistance(`H${pair.holeB}↔basket${pair.basketY}`, pair.ribbonBY, by);
				const distanceEvidence: Array<{ label: string; value: number | null; role: 'current' | 'proposed'; basketIndex: number; point: NearestComponentPoint | null }> = [
					{ label: `Hole ${pair.holeA} ribbon ↔ current basket`, value: pair.ribbonAX, role: 'current', basketIndex: pair.basketX, point: ax },
					{ label: `Hole ${pair.holeB} ribbon ↔ current basket`, value: pair.ribbonBY, role: 'current', basketIndex: pair.basketY, point: by },
					{ label: `Hole ${pair.holeA} ribbon ↔ swapped basket`, value: pair.ribbonAY, role: 'proposed', basketIndex: pair.basketY, point: ay },
					{ label: `Hole ${pair.holeB} ribbon ↔ swapped basket`, value: pair.ribbonBX, role: 'proposed', basketIndex: pair.basketX, point: bx }
				];
				for (const evidence of distanceEvidence) {
					if (evidence.value === null || !evidence.point) continue;
					const basket = basketRefs[evidence.basketIndex];
					const basketEntityId = basketEntityIds[evidence.basketIndex];
					const shapes: EvidenceShape[] = [
						{ t: 'segment', x1: basket.centerXPx, y1: basket.centerYPx, x2: evidence.point.xPx, y2: evidence.point.yPx, label: `${evidence.value.toFixed(1)} px` },
						{ t: 'point', x: evidence.point.xPx, y: evidence.point.yPx, label: 'nearest ribbon-component pixel' }
					];
					runtime.recordEvidence({ stageInvocationId: invocationId, entityId: basketEntityId, label: evidence.label, value: evidence.value, unit: 'px', role: evidence.role, shapes });
				}
				runtime.recordMeasure(invocationId, `H${pair.holeA}/H${pair.holeB} current ribbon cost`, pair.currentRibbonCost, 'px');
				runtime.recordMeasure(invocationId, `H${pair.holeA}/H${pair.holeB} swapped ribbon cost`, pair.swappedRibbonCost, 'px');
				runtime.recordMeasure(invocationId, `H${pair.holeA}/H${pair.holeB} ribbon improvement`, pair.ribbonImprovementPx, 'px');
				runtime.recordEvidence({
					stageInvocationId: invocationId,
					label: `Ribbon swap improvement — Holes ${pair.holeA}/${pair.holeB}`,
					checkId: CHECK_P6_SWAP_IMPROVEMENT,
					value: pair.ribbonImprovementPx,
					unit: 'px',
					operator: 'gte',
					threshold: config.p6.swap.minRibbonImprovementPx,
					decision: pair.swapApplied ? 'SWAP' : 'KEEP',
					role: pair.swapApplied ? 'proposed' : 'current',
					shapes: []
				});
			}

			const changed = new Set(swap?.changedHoleNumbers ?? []);
			for (const assignment of pipeline.p6LowParBasketAssignment.assignments) {
				if (!changed.has(assignment.holeNumber) || assignment.assignedBasketIndex === null) continue;
				const holeEntityId = holeEntityIdByNumber.get(assignment.holeNumber);
				const basketEntityId = basketEntityIds[assignment.assignedBasketIndex];
				if (!holeEntityId || !basketEntityId) continue;
				runtime.recordDataflow({ t: 'relate', stage: invocationId, left: basketEntityId, right: holeEntityId, relation: 'reassigned' });
			}
		}
	}

	const labelmaps = [encodeLabelmapRle(p1.labels, source.widthPx, source.heightPx, labelEntityIds)];
	return { trace: runtime.finishTrace(), labelmaps };
}

export interface CreateChainSpotReplayAdapterOptions {
	readonly imagePath: string;
	readonly projectRoot: string;
	readonly tophDir: string;
	readonly truthPath?: string;
}

function gitRevisionSync(cwd: string): string {
	try { return execSync('git rev-parse HEAD', { cwd }).toString().trim(); }
	catch { return 'unknown'; }
}

export async function createChainSpotReplayAdapterWithEvidence(options: CreateChainSpotReplayAdapterOptions): Promise<ReplayAdapter> {
	const { runtime } = await importToph(options.tophDir);
	const context = await loadCvReplayContext(options.imagePath, options.projectRoot, options.truthPath);
	const truthHoles: readonly TruthHole[] | undefined = context.truthHoles;
	const chainspotRev = gitRevisionSync(options.projectRoot);
	const tophRev = gitRevisionSync(options.tophDir);
	return {
		pipelineId: 'chainspot.pancake',
		codeVersion: { chainspot: chainspotRev, toph: tophRev },
		source: { name: context.image.fileName, sha256: context.sha256, widthPx: context.image.widthPx, heightPx: context.image.heightPx },
		defaults: DEFAULT_CV_CONFIG,
		paramSchema: CV_PARAM_SCHEMA as unknown as readonly ParamSpec[],
		async execute(effectiveConfig: object): Promise<AdapterRunOutput> {
			const config = effectiveConfig as ChainSpotCvConfig;
			const stageRecords: StageExecutionRecord[] = [];
			const { wallMs, pipeline, correctness } = await runCvReplayPipeline(context, config, (record) => stageRecords.push(record));
			const { trace, labelmaps } = synthesizeTrace(runtime, pipeline, stageRecords, config, context.image);
			const p6 = pipeline.p6LowParBasketAssignment;
			const swap = p6.swapAdjudication;
			const summary: Record<string, number | string | boolean | null> = {
				wallMs,
				holes: pipeline.grammar.holes.length,
				assignedByLowPar: p6.assignedByLowPar,
				lockedByP4: p6.lockedByP4,
				unresolved: p6.unresolved,
				'p62.swapsApplied': swap?.swapsApplied ?? 0,
				'p62.changedHoles': (swap?.changedHoleNumbers ?? []).join(',')
			};
			if (truthHoles && truthHoles.length > 0 && correctness) {
				summary['assignment.correct'] = correctness.correct;
				summary['assignment.incorrect'] = correctness.incorrect.length;
				summary['assignment.scoredAgainst'] = options.truthPath ?? context.image.fileName;
			}
			const final = p6.assignments.map((assignment) => {
				const basket = assignment.assignedBasketIndex !== null ? pipeline.rawMaskObjects.baskets[assignment.assignedBasketIndex] : undefined;
				return { holeNumber: assignment.holeNumber, teeIndex: assignment.teeIndex, assignedBasketIndex: assignment.assignedBasketIndex, basketXPx: basket?.centerXPx ?? null, basketYPx: basket?.centerYPx ?? null, status: assignment.status, assignmentReason: assignment.assignmentReason };
			});
			return { trace, manifest: buildManifest(), labelmaps: [...labelmaps], summary, final };
		}
	};
}

export { loadExternalTruth, score };
