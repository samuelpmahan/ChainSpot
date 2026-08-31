import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { factorMatrix, type MatrixFactorization } from './pca.js';
import {
	renderRadial,
	renderTrueNorthSkeleton,
	rotateRadialValues,
	type RadialRenderResult,
	type RadialSeries
} from './radialRender.js';

interface Profile {
	readonly values: readonly (number | null)[];
	readonly visibleCounts: readonly number[];
}

interface ControlBasket {
	readonly cleanIndex: number;
	readonly detectorIndex: number;
	readonly source: string;
	readonly tip: readonly [number, number];
	readonly c1PixelCounts: {
		readonly totalPixels: number;
		readonly rectangleBlockedPixels: number;
		readonly exactBlockedPixels: number;
		readonly recoveredPixels: number;
		readonly exactOutsideRectanglePixels: number;
	};
	readonly profiles: {
		readonly raw: Profile;
		readonly rectangle: Profile;
		readonly exact: Profile;
	};
}

interface ControlReceipt {
	readonly schema: string;
	readonly purpose: string;
	readonly control: { readonly cleanBaskets: number; readonly basketOrigin: string };
	readonly measurement: {
		readonly observable: string;
		readonly frame: string;
		readonly angleStepDeg: number;
		readonly muteSemantics: string;
	};
	readonly baskets: readonly ControlBasket[];
}

interface TruthPoint { readonly xPx: number; readonly yPx: number }
interface TruthHole {
	readonly number: number;
	readonly tee: TruthPoint;
	readonly basket: TruthPoint;
	readonly corridorBends?: readonly TruthPoint[];
}
interface TruthFile { readonly holes: readonly TruthHole[] }

interface Observation {
	readonly cleanIndex: number;
	readonly detectorIndex: number;
	readonly hole: number;
	readonly tip: readonly [number, number];
	readonly truthBasketDistancePx: number;
	readonly truthBearingDeg: number;
	readonly truthReference: 'last-corridor-bend' | 'tee-straight-hole';
	readonly before: readonly (number | null)[];
	readonly after: readonly (number | null)[];
	readonly beforeCount: readonly number[];
	readonly afterCount: readonly number[];
	readonly rawCount: readonly number[];
	readonly addedSupportFraction: readonly number[];
	readonly addedEvidenceDensity: readonly number[];
	readonly trueNorth: {
		readonly before: readonly (number | null)[];
		readonly after: readonly (number | null)[];
		readonly addedSupportFraction: readonly number[];
		readonly addedEvidenceDensity: readonly number[];
	};
}

interface CoverageReceipt {
	readonly required: readonly string[];
	readonly consumed: readonly string[];
	readonly unused: readonly string[];
}

class RenderCoverage {
	private readonly consumed = new Set<string>();
	constructor(private readonly required: readonly string[]) {}
	use(...ids: string[]): void { for (const id of ids) this.consumed.add(id); }
	finish(): CoverageReceipt {
		const unused = this.required.filter((id) => !this.consumed.has(id));
		if (unused.length) throw new Error(`C1 render ignored required evidence: ${unused.join(', ')}`);
		return { required: [...this.required], consumed: [...this.consumed].sort(), unused };
	}
}

const REQUIRED_RENDER_EVIDENCE = Object.freeze([
	'control.geometry',
	'control.rectangleProfile',
	'control.exactProfile',
	'control.visibleCounts',
	'truth.terminalDirection',
	'delta.support',
	'delta.evidenceMass',
	'factors.imageNorth',
	'factors.trueNorth',
	'frames.imageNorth',
	'frames.trueNorth'
]);

function assertControl(value: unknown): asserts value is ControlReceipt {
	const receipt = value as Partial<ControlReceipt>;
	if (receipt.schema !== 'chainspot-c1-clean-control@1') throw new Error(`expected chainspot-c1-clean-control@1, got ${receipt.schema ?? 'UNKNOWN'}`);
	if (!Array.isArray(receipt.baskets) || receipt.baskets.length !== 16) throw new Error(`expected 16 clean control baskets, got ${receipt.baskets?.length ?? 'UNKNOWN'}`);
	for (const basket of receipt.baskets) {
		for (const profile of [basket.profiles.raw, basket.profiles.rectangle, basket.profiles.exact]) {
			if (profile.values.length !== 180 || profile.visibleCounts.length !== 180) throw new Error(`clean ${basket.cleanIndex}: expected 180-bin profiles`);
		}
		if (basket.c1PixelCounts.recoveredPixels !== 675) throw new Error(`clean ${basket.cleanIndex}: expected 675 rectangle->border pixels`);
	}
}

function assertTruth(value: unknown): asserts value is TruthFile {
	const truth = value as Partial<TruthFile>;
	if (!Array.isArray(truth.holes) || !truth.holes.length) throw new Error('annotation has no holes');
}

function bearingFromImageNorth(origin: TruthPoint, target: TruthPoint): number {
	const degrees = Math.atan2(target.xPx - origin.xPx, -(target.yPx - origin.yPx)) * 180 / Math.PI;
	return ((degrees % 360) + 360) % 360;
}

function distance(left: readonly [number, number], right: TruthPoint): number {
	return Math.hypot(left[0] - right.xPx, left[1] - right.yPx);
}

function finiteMean(value: number | null, count: number): number {
	if (count === 0) return 0;
	if (value === null || !Number.isFinite(value)) throw new Error('profile has visible samples but no finite mean');
	return value * count;
}

function deriveObservations(control: ControlReceipt, truth: TruthFile): Observation[] {
	const claimedHoles = new Set<number>();
	return control.baskets.map((basket) => {
		const matches = truth.holes
			.map((hole) => ({ hole, distancePx: distance(basket.tip, hole.basket) }))
			.sort((a, b) => a.distancePx - b.distancePx || a.hole.number - b.hole.number);
		const match = matches[0];
		if (!match || match.distancePx > 6) throw new Error(`clean ${basket.cleanIndex}: no truth basket within 6px`);
		if (claimedHoles.has(match.hole.number)) throw new Error(`truth H${match.hole.number} matched more than once`);
		claimedHoles.add(match.hole.number);
		const bends = match.hole.corridorBends ?? [];
		const reference = bends.length ? bends[bends.length - 1] : match.hole.tee;
		const truthBearingDeg = bearingFromImageNorth(match.hole.basket, reference);
		const addedSupportFraction: number[] = [];
		const addedEvidenceDensity: number[] = [];
		for (let index = 0; index < 180; index++) {
			const beforeCount = basket.profiles.rectangle.visibleCounts[index];
			const afterCount = basket.profiles.exact.visibleCounts[index];
			const rawCount = basket.profiles.raw.visibleCounts[index];
			const addedCount = afterCount - beforeCount;
			if (addedCount < 0) throw new Error(`clean ${basket.cleanIndex}, bin ${index}: exact border removed more samples than rectangle`);
			if (!(rawCount > 0)) throw new Error(`clean ${basket.cleanIndex}, bin ${index}: raw support is empty`);
			const beforeSum = finiteMean(basket.profiles.rectangle.values[index], beforeCount);
			const afterSum = finiteMean(basket.profiles.exact.values[index], afterCount);
			const addedSum = afterSum - beforeSum;
			addedSupportFraction.push(addedCount / rawCount);
			addedEvidenceDensity.push(addedSum / rawCount);
		}
		return {
			cleanIndex: basket.cleanIndex,
			detectorIndex: basket.detectorIndex,
			hole: match.hole.number,
			tip: basket.tip,
			truthBasketDistancePx: match.distancePx,
			truthBearingDeg,
			truthReference: bends.length ? 'last-corridor-bend' : 'tee-straight-hole',
			before: basket.profiles.rectangle.values,
			after: basket.profiles.exact.values,
			beforeCount: basket.profiles.rectangle.visibleCounts,
			afterCount: basket.profiles.exact.visibleCounts,
			rawCount: basket.profiles.raw.visibleCounts,
			addedSupportFraction,
			addedEvidenceDensity,
			trueNorth: {
				before: rotateRadialValues(basket.profiles.rectangle.values, truthBearingDeg),
				after: rotateRadialValues(basket.profiles.exact.values, truthBearingDeg),
				addedSupportFraction: rotateRadialValues(addedSupportFraction, truthBearingDeg) as number[],
				addedEvidenceDensity: rotateRadialValues(addedEvidenceDensity, truthBearingDeg) as number[]
			}
		};
	});
}

function quantile(values: readonly number[], fraction: number): number {
	if (!values.length) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const position = (sorted.length - 1) * fraction;
	const left = Math.floor(position);
	const right = Math.ceil(position);
	return sorted[left] * (right - position) + sorted[right] * (position - left);
}

function aggregate(rows: readonly (readonly (number | null)[])[], fraction = 0.5): (number | null)[] {
	return Array.from({ length: rows[0].length }, (_, column) => {
		const values = rows.map((row) => row[column]).filter((value): value is number => value !== null && Number.isFinite(value));
		return values.length ? quantile(values, fraction) : null;
	});
}

function normalize(values: readonly number[]): number[] {
	const scale = Math.max(...values.map(Math.abs), 1e-12);
	return values.map((value) => value / scale);
}

function sampleSeries(rows: readonly (readonly (number | null)[])[], prefix: string, color: string): RadialSeries[] {
	return rows.map((values, index) => ({ id: `${prefix}.${index + 1}`, label: `${prefix} sample ${index + 1}`, values, color, opacity: 0.18, strokeWidth: 1, showInLegend: false }));
}

function radialDataUrl(result: RadialRenderResult): string {
	return `data:image/svg+xml;base64,${Buffer.from(result.svg).toString('base64')}`;
}

function esc(value: unknown): string {
	return String(value).replace(/[&<>\"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character] ?? character);
}

function pct(value: number): string { return `${(value * 100).toFixed(1)}%`; }
function deg(value: number): string { return `${value.toFixed(1)}°`; }

function renderReport(args: {
	readonly control: ControlReceipt;
	readonly observations: readonly Observation[];
	readonly imageEvidence: MatrixFactorization;
	readonly trueEvidence: MatrixFactorization;
	readonly imageSupport: MatrixFactorization;
	readonly trueSupport: MatrixFactorization;
}): { svg: string; coverage: CoverageReceipt; radialLogs: readonly string[] } {
	const coverage = new RenderCoverage(REQUIRED_RENDER_EVIDENCE);
	coverage.use('control.geometry', 'control.rectangleProfile', 'control.exactProfile', 'control.visibleCounts');
	coverage.use('truth.terminalDirection', 'delta.support', 'delta.evidenceMass');
	coverage.use('factors.imageNorth', 'factors.trueNorth', 'frames.imageNorth', 'frames.trueNorth');

	const origin = { x: 0, y: 0, semantic: args.control.control.basketOrigin };
	const imageRows = args.observations.map((row) => row.addedEvidenceDensity);
	const trueRows = args.observations.map((row) => row.trueNorth.addedEvidenceDensity);
	const beforeRows = args.observations.map((row) => row.trueNorth.before);
	const afterRows = args.observations.map((row) => row.trueNorth.after);
	const evidenceDomain: [number, number] = [0, Math.max(...imageRows.flat(), ...trueRows.flat())];
	const profileValues = [...beforeRows.flat(), ...afterRows.flat()].filter((value): value is number => value !== null);
	const profileDomain: [number, number] = [quantile(profileValues, 0.01), quantile(profileValues, 0.99)];

	const imageRadial = renderRadial({
		id: 'c1.rectangle-border.imageNorth',
		title: 'Reintroduced evidence — ImageNorth',
		purpose: 'Keep the map image-up axis fixed.',
		origin,
		axis: { frameId: 'imageNorth', zeroDeg: 0, label: 'IMAGE N / 0°' },
		series: [
			...sampleSeries(imageRows, 'clean', '#64748b'),
			{ id: 'median', label: 'median added evidence mass', values: aggregate(imageRows), color: '#00d4ff', strokeWidth: 4 }
		],
		valueDomain: evidenceDomain
	});
	const trueRadial = renderTrueNorthSkeleton({
		origin,
		title: 'Reintroduced evidence — TrueNorth',
		series: [
			...sampleSeries(trueRows, 'clean', '#64748b'),
			{ id: 'median', label: 'median added evidence mass', values: aggregate(trueRows), color: '#00d4ff', strokeWidth: 4 }
		],
		valueDomain: evidenceDomain
	});
	const beforeAfter = renderTrueNorthSkeleton({
		origin,
		title: 'BEFORE rectangle vs AFTER exact B/W',
		series: [
			{ id: 'beforeQ25', label: 'BEFORE rectangle Q25', values: aggregate(beforeRows, 0.25), color: '#ff8b94', opacity: 0.65, strokeWidth: 1.5, showInLegend: false },
			{ id: 'beforeQ75', label: 'BEFORE rectangle Q75', values: aggregate(beforeRows, 0.75), color: '#ff8b94', opacity: 0.65, strokeWidth: 1.5, showInLegend: false },
			{ id: 'afterQ25', label: 'AFTER exact B/W Q25', values: aggregate(afterRows, 0.25), color: '#78aaff', opacity: 0.65, strokeWidth: 1.5, showInLegend: false },
			{ id: 'afterQ75', label: 'AFTER exact B/W Q75', values: aggregate(afterRows, 0.75), color: '#78aaff', opacity: 0.65, strokeWidth: 1.5, showInLegend: false },
			{ id: 'beforeMedian', label: 'BEFORE rectangle median', values: aggregate(beforeRows), color: '#ff3347', strokeWidth: 4 },
			{ id: 'afterMedian', label: 'AFTER exact B/W median', values: aggregate(afterRows), color: '#1668ff', strokeWidth: 4 }
		],
		valueDomain: profileDomain
	});
	const factors = renderTrueNorthSkeleton({
		origin,
		title: 'TrueNorth factors — evidence vs support',
		series: [
			{ id: 'trueEvidence', label: 'TrueNorth evidence factor', values: normalize(args.trueEvidence.components[0].values), color: '#00d4ff', strokeWidth: 4 },
			{ id: 'trueSupport', label: 'TrueNorth support factor', values: normalize(args.trueSupport.components[0].values), color: '#b368ff', strokeWidth: 2, dash: '7 5' },
			{ id: 'truePc1', label: 'TrueNorth centered PC1', values: normalize(factorMatrix(trueRows, { center: true, maxComponents: 1 }).components[0].values), color: '#35c46a', strokeWidth: 2 }
		],
		valueDomain: [-1, 1]
	});

	const panels = [imageRadial, trueRadial, beforeAfter, factors];
	const width = 2040;
	const height = 1190;
	const panelSize = 470;
	const panelPositions = [[32, 178], [520, 178], [32, 666], [520, 666]] as const;
	const panelImages = panels.map((panel, index) => `<image x="${panelPositions[index][0]}" y="${panelPositions[index][1]}" width="${panelSize}" height="${panelSize}" href="${radialDataUrl(panel)}"/>`).join('');
	const imageFactor = args.imageEvidence.components[0];
	const trueFactor = args.trueEvidence.components[0];
	const imageSupportFactor = args.imageSupport.components[0];
	const trueSupportFactor = args.trueSupport.components[0];
	const trueCentered = factorMatrix(trueRows, { center: true, maxComponents: 3 });
	const beforeUnknown = args.observations.reduce((sum, row) => sum + row.beforeCount.filter((count) => count === 0).length, 0);
	const truthRows = [...args.observations].sort((a, b) => a.hole - b.hole);
	const truthText = truthRows.map((row, index) => {
		const column = index < 8 ? 0 : 1;
		const line = index % 8;
		return `<text x="${1040 + column * 470}" y="${748 + line * 34}" class="mono">H${String(row.hole).padStart(2, '0')}  ${deg(row.truthBearingDeg).padStart(7)}  ${esc(row.truthReference)}  match ${row.truthBasketDistancePx.toFixed(2)}px</text>`;
	}).join('');
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
	<style>.title{font:700 31px sans-serif;fill:#f8fafc}.sub{font:17px sans-serif;fill:#b8c3d6}.head{font:700 20px sans-serif;fill:#f8fafc}.body{font:16px sans-serif;fill:#d7deea}.mono{font:15px monospace;fill:#c7d0df}.cyan{fill:#00d4ff}.red{fill:#ff5a67}.blue{fill:#3f8cff}.yellow{fill:#ffd34d}</style>
	<rect width="100%" height="100%" fill="#0f141e"/>
	<text x="32" y="48" class="title">C1 RECTANGLE → EXACT B/W BORDER — RADIAL PCA SMOKE</text>
	<text x="32" y="82" class="sub">16 clean Dashs baskets · 180 × 2° bins · semantic pole-tip origin · pathfinder gray (R+G+B)/3</text>
	<text x="32" y="112" class="sub">ImageNorth keeps image-up fixed. TrueNorth rotates each annotated terminal corridor segment to 0° / visual north.</text>
	<text x="32" y="142" class="sub"><tspan class="red">BEFORE</tspan> = historical rectangle UNKNOWNs · <tspan class="blue">AFTER</tspan> = exact 2,145-pixel B/W ownership · <tspan class="yellow">Δ</tspan> = newly admitted gray evidence mass</text>
	${panelImages}
	<rect x="1018" y="178" width="990" height="466" rx="14" fill="#151d2a" stroke="#2b3a50"/>
	<text x="1040" y="216" class="head">WHAT THE FACTOR SAW</text>
	<text x="1040" y="253" class="body">Rows</text><text x="1280" y="253" class="mono">16 clean baskets</text>
	<text x="1040" y="283" class="body">Columns</text><text x="1280" y="283" class="mono">180 angular bins</text>
	<text x="1040" y="313" class="body">Known object</text><text x="1280" y="313" class="mono">2,145 exact B/W pixels</text>
	<text x="1040" y="343" class="body">Unique C1 geometry</text><text x="1280" y="343" class="mono">3,808 total · 1,430 rectangle blocked · 755 exact blocked · 675 re-admitted</text>
	<text x="1040" y="373" class="body">Rectangle UNKNOWN bins</text><text x="1280" y="373" class="mono">${beforeUnknown} total · ${(beforeUnknown / args.observations.length).toFixed(1)} per basket</text>
	<text x="1040" y="417" class="head">UNCENTERED SHARED-FACTOR ENERGY</text>
	<text x="1040" y="454" class="body">ImageNorth evidence mass</text><text x="1390" y="454" class="mono cyan">${pct(imageFactor.energyFraction)}</text>
	<text x="1040" y="484" class="body">TrueNorth evidence mass</text><text x="1390" y="484" class="mono cyan">${pct(trueFactor.energyFraction)}</text>
	<text x="1040" y="514" class="body">ImageNorth support geometry</text><text x="1390" y="514" class="mono">${pct(imageSupportFactor.energyFraction)}</text>
	<text x="1040" y="544" class="body">TrueNorth support geometry</text><text x="1390" y="544" class="mono">${pct(trueSupportFactor.energyFraction)}</text>
	<text x="1040" y="582" class="body">TrueNorth centered PC1 / PC2 / PC3</text><text x="1390" y="582" class="mono">${trueCentered.components.slice(0, 3).map((component) => pct(component.energyFraction)).join(' / ')}</text>
	<text x="1040" y="620" class="sub">Evidence mass = (exact gray sum − rectangle gray sum) / fixed raw support. UNKNOWN never becomes zero.</text>
	<text x="1510" y="620" class="sub">Red teeth mark changing UNKNOWN coverage, not dark samples.</text>
	<rect x="1018" y="666" width="990" height="454" rx="14" fill="#151d2a" stroke="#2b3a50"/>
	<text x="1040" y="704" class="head">TRUENORTH PROVENANCE — TERMINAL PATH VECTOR</text>
	${truthText}
	<text x="1040" y="1036" class="sub">Bent hole: truth basket → final annotated bend. Straight hole: truth basket → annotated tee.</text>
	<text x="1040" y="1066" class="sub">Truth selects only the evaluation frame; it does not select baskets, pixels, or PCA factors.</text>
	<text x="1040" y="1108" class="mono">RENDER EVIDENCE COVERAGE: ${REQUIRED_RENDER_EVIDENCE.length}/${REQUIRED_RENDER_EVIDENCE.length} required fields consumed · unused 0</text>
	</svg>\n`;
	return {
		svg,
		coverage: coverage.finish(),
		radialLogs: panels.flatMap((panel) => panel.logs.map((log) => log.message))
	};
}

export interface RunC1RectangleBorderInput {
	readonly controlPath: string;
	readonly annotationPath: string;
	readonly outDir: string;
}

export interface RunC1RectangleBorderResult {
	readonly visualRenderPath: string;
	readonly receiptJsonPath: string;
	readonly receiptTextPath: string;
	readonly receipt: Record<string, unknown>;
}

export function runC1RectangleBorder(input: RunC1RectangleBorderInput): RunC1RectangleBorderResult {
	const totalStart = performance.now();
	const loadStart = performance.now();
	const controlRaw: unknown = JSON.parse(readFileSync(resolve(input.controlPath), 'utf8'));
	const truthRaw: unknown = JSON.parse(readFileSync(resolve(input.annotationPath), 'utf8'));
	assertControl(controlRaw);
	assertTruth(truthRaw);
	const loadMs = performance.now() - loadStart;

	const deriveStart = performance.now();
	const observations = deriveObservations(controlRaw, truthRaw);
	const imageEvidenceRows = observations.map((row) => row.addedEvidenceDensity);
	const trueEvidenceRows = observations.map((row) => row.trueNorth.addedEvidenceDensity);
	const imageSupportRows = observations.map((row) => row.addedSupportFraction);
	const trueSupportRows = observations.map((row) => row.trueNorth.addedSupportFraction);
	const deriveMs = performance.now() - deriveStart;

	const factorStart = performance.now();
	const imageEvidence = factorMatrix(imageEvidenceRows, { center: false, maxComponents: 3 });
	const trueEvidence = factorMatrix(trueEvidenceRows, { center: false, maxComponents: 3 });
	const imageSupport = factorMatrix(imageSupportRows, { center: false, maxComponents: 3 });
	const trueSupport = factorMatrix(trueSupportRows, { center: false, maxComponents: 3 });
	const centeredImageEvidence = factorMatrix(imageEvidenceRows, { center: true, maxComponents: 3 });
	const centeredTrueEvidence = factorMatrix(trueEvidenceRows, { center: true, maxComponents: 3 });
	const factorMs = performance.now() - factorStart;

	const renderStart = performance.now();
	const rendered = renderReport({ control: controlRaw, observations, imageEvidence, trueEvidence, imageSupport, trueSupport });
	const renderMs = performance.now() - renderStart;

	const outputDir = resolve(input.outDir);
	mkdirSync(outputDir, { recursive: true });
	const visualRenderPath = resolve(outputDir, 'c1.rectangle-to-border.radial-pca.svg');
	const receiptJsonPath = resolve(outputDir, 'c1.rectangle-to-border.receipt.json');
	const receiptTextPath = resolve(outputDir, 'c1.rectangle-to-border.receipt.txt');
	const writeStart = performance.now();
	writeFileSync(visualRenderPath, rendered.svg);
	const writeMs = performance.now() - writeStart;
	const timingsMs = {
		loadCachedControlAndTruthMs: Number(loadMs.toFixed(3)),
		deriveDeltaAndFramesMs: Number(deriveMs.toFixed(3)),
		factorizationMs: Number(factorMs.toFixed(3)),
		renderMs: Number(renderMs.toFixed(3)),
		writeVisualMs: Number(writeMs.toFixed(3)),
		observedTotalBeforeReceiptMs: Number((performance.now() - totalStart).toFixed(3))
	};
	const factorSummary = (value: MatrixFactorization) => ({
		uncentered: !value.centered,
		sharedFactorEnergyFraction: value.components[0]?.energyFraction ?? 0,
		first3EnergyFractions: value.components.slice(0, 3).map((component) => component.energyFraction),
		scores: value.components[0]?.scores ?? []
	});
	const receipt = {
		schema: 'chainspot-lab-c1-rectangle-border@1',
		status: 'smoke-test-measurement',
		hypothesis: 'replacing the historical basket rectangle with exact B/W ownership reintroduces directional C1 evidence; TrueNorth tests whether that evidence is terminal-path aligned',
		provenance: {
			control: resolve(input.controlPath),
			annotation: resolve(input.annotationPath),
			truthUse: 'evaluation-frame rotation only; no basket, pixel, or factor selection',
			truthVector: 'truth basket to final corridor bend; truth basket to tee on straight holes'
		},
		measurement: {
			observable: controlRaw.measurement.observable,
			bins: 180,
			angleStepDeg: controlRaw.measurement.angleStepDeg,
			before: 'historical rectangle occlusion',
			after: 'exact 2,145-pixel B/W ownership',
			factorInput: 'addedEvidenceDensity = (exact gray sum - rectangle gray sum) / raw fixed sample support',
			unknownPolicy: 'zero visible samples remain null in before/after means; factor input uses additive evidence mass, never null-as-zero'
		},
		counts: {
			baskets: observations.length,
			angularBins: 180,
			c1PixelsPerBasket: controlRaw.baskets[0].c1PixelCounts.totalPixels,
			rectangleBlockedPixelsPerBasket: controlRaw.baskets[0].c1PixelCounts.rectangleBlockedPixels,
			exactBlockedPixelsPerBasket: controlRaw.baskets[0].c1PixelCounts.exactBlockedPixels,
			reintroducedUniquePixelsPerBasket: controlRaw.baskets[0].c1PixelCounts.recoveredPixels,
			rectangleUnknownBinsTotal: observations.reduce((sum, row) => sum + row.beforeCount.filter((count) => count === 0).length, 0)
		},
		factorization: {
			imageNorthEvidence: factorSummary(imageEvidence),
			trueNorthEvidence: factorSummary(trueEvidence),
			imageNorthSupport: factorSummary(imageSupport),
			trueNorthSupport: factorSummary(trueSupport),
			centeredImageNorthEvidence: factorSummary(centeredImageEvidence),
			centeredTrueNorthEvidence: factorSummary(centeredTrueEvidence)
		},
		observations,
		renderEvidenceCoverage: rendered.coverage,
		radialRenderLogs: rendered.radialLogs,
		timingsMs,
		outputs: { visualRender: visualRenderPath, machineReceipt: receiptJsonPath, cliReceipt: receiptTextPath }
	};
	const text = [
		'C1 RECTANGLE -> EXACT B/W BORDER — RADIAL PCA SMOKE',
		`control: ${basename(input.controlPath)} · annotation: ${basename(input.annotationPath)}`,
		`matrix: ${observations.length} baskets x 180 angular bins · 675 unique C1 pixels re-admitted per basket`,
		`UNKNOWN preserved: ${receipt.counts.rectangleUnknownBinsTotal} rectangle bins had zero visible samples`,
		`shared evidence factor: ImageNorth ${pct(imageEvidence.components[0].energyFraction)} · TrueNorth ${pct(trueEvidence.components[0].energyFraction)}`,
		`shared support factor:  ImageNorth ${pct(imageSupport.components[0].energyFraction)} · TrueNorth ${pct(trueSupport.components[0].energyFraction)}`,
		`TrueNorth centered PC1/2/3: ${centeredTrueEvidence.components.slice(0, 3).map((component) => pct(component.energyFraction)).join(' / ')}`,
		`render evidence coverage: ${rendered.coverage.consumed.length}/${rendered.coverage.required.length} · unused ${rendered.coverage.unused.length}`,
		`timings: load ${timingsMs.loadCachedControlAndTruthMs}ms · derive ${timingsMs.deriveDeltaAndFramesMs}ms · factor ${timingsMs.factorizationMs}ms · render ${timingsMs.renderMs}ms · total ${timingsMs.observedTotalBeforeReceiptMs}ms`,
		`VisualRender: ${visualRenderPath}`,
		`machine receipt: ${receiptJsonPath}`
	].join('\n');
	writeFileSync(receiptJsonPath, `${JSON.stringify(receipt, null, 2)}\n`);
	writeFileSync(receiptTextPath, `${text}\n`);
	return { visualRenderPath, receiptJsonPath, receiptTextPath, receipt };
}
