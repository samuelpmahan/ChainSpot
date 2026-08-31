import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { PNG } from 'pngjs';

export type BasketPcrTick = 'T1' | 'T2' | 'T3' | 'T4' | 'T5';

export interface BasketCompositionPcrInput {
	readonly runDir: string;
	readonly outDir: string;
	readonly through: BasketPcrTick;
}

export interface BasketCompositionPcrResult {
	readonly visualRenderPath: string;
	readonly receiptJsonPath: string;
	readonly receiptTextPath: string;
	readonly receipt: Record<string, unknown>;
}

interface RunReceipt {
	readonly schema: string;
	readonly config?: { readonly name?: string; readonly paramsHash?: string; readonly planFingerprint?: string };
	readonly intake: {
		readonly widthPx: number;
		readonly heightPx: number;
		readonly canonicalImageId?: string;
		readonly sources?: readonly string[];
	};
}

interface ComponentLike {
	readonly label: number;
	readonly area: number;
	readonly bboxX: number;
	readonly bboxY: number;
	readonly bboxW: number;
	readonly bboxH: number;
}

interface ComponentStage {
	readonly components: readonly ComponentLike[];
	readonly labels: Int32Array | Uint32Array;
}

interface BasketLike {
	readonly x: number;
	readonly y: number;
	readonly tipX: number;
	readonly tipY: number;
	readonly source: string;
}

interface BasketTemplateLike { readonly width: number; readonly height: number }

interface DerivedBasket {
	readonly detectorIndex: number;
	readonly basket: BasketLike;
	readonly body?: ComponentLike;
	readonly shell?: ComponentLike;
	readonly shellMargins?: readonly number[];
}

interface Specimen {
	readonly id: string;
	readonly detectorIndex: number;
	readonly basketSource: string;
	readonly origin: readonly [number, number];
	readonly sourceCrop: Uint8Array;
	readonly mask1: Uint8Array;
	readonly mask1Count: number;
	readonly mask2?: Uint8Array;
	readonly mask2Count?: number;
}

interface FamilyEvidence {
	readonly width: number;
	readonly height: number;
	readonly mask: Uint8Array; // 0 unknown, 1 bright, 2 dark
	readonly mean: Uint8Array;
	readonly memberCount: number;
	readonly brightPixels: number;
	readonly darkPixels: number;
	readonly unknownPixels: number;
	readonly cleanRows: readonly DerivedBasket[];
	readonly overlapRows: readonly DerivedBasket[];
}

interface BorderEvidence {
	readonly image: Uint8Array;
	readonly width: number;
	readonly height: number;
	readonly origin: readonly [number, number];
	readonly upperDetectorIndex: number;
	readonly lowerDetectorIndex: number;
	readonly fusedComponentLabel: number;
	readonly bluePixels: number;
	readonly redPixels: number;
	readonly sharedPixels: number;
	readonly residualPixels: number;
}

interface SubtractionEvidence {
	readonly image: Uint8Array;
	readonly composedPixels: number;
	readonly unclaimedPixels: number;
}

interface EvidenceCoverage {
	readonly required: readonly string[];
	readonly consumed: readonly string[];
	readonly unused: readonly string[];
}

interface RenderInputs {
	readonly control: Specimen;
	readonly cropWidth: number;
	readonly cropHeight: number;
	readonly shellMargins: readonly number[];
	readonly timings: Record<string, number>;
	readonly through: BasketPcrTick;
	readonly family?: FamilyEvidence;
	readonly border?: BorderEvidence;
	readonly subtraction?: SubtractionEvidence;
}

const require = createRequire(import.meta.url);
const CONTRACT_PATH = 'docs/contracts/progressive-composition-render.md';
const MOAT_PX = 5;
const TICK_SEQUENCE: readonly BasketPcrTick[] = ['T1', 'T2', 'T3', 'T4', 'T5'];
const BLUE = [22, 119, 255] as const;
const RED = [255, 51, 77] as const;
const PURPLE = [190, 70, 255] as const;
const YELLOW = [255, 210, 0] as const;

const TICK_EVIDENCE: Readonly<Record<BasketPcrTick, readonly string[]>> = Object.freeze({
	T1: ['source.canonicalRgba', 'source.dimensions', 'control.basketIdentity', 'control.selectionRule', 'alignment.transforms', 'tick1.mask1Pixels', 'tick1.mask1Counts', 'progression.order', 'timings'],
	T2: ['tick2.mask2Pixels', 'tick2.mask2Counts'],
	T3: ['tick3.memberIdentities', 'tick3.alignedVotes', 'tick3.familyPixels', 'tick3.familyCounts'],
	T4: ['tick4.overlapIdentities', 'tick4.fusedComponentPixels', 'tick4.mappingClasses', 'tick4.mappingCounts'],
	T5: ['tick5.evaluationRegion', 'tick5.composedPixels', 'tick5.unclaimedPixels', 'tick5.subtractionCounts']
});

export function ticksThrough(through: BasketPcrTick): readonly BasketPcrTick[] {
	const index = TICK_SEQUENCE.indexOf(through);
	if (index < 0) throw new Error(`unknown basket PCR tick ${through}`);
	return TICK_SEQUENCE.slice(0, index + 1);
}

function requiredRenderEvidence(through: BasketPcrTick): readonly string[] {
	return ticksThrough(through).flatMap((tick) => TICK_EVIDENCE[tick]);
}

export function reconcileEvidence(required: readonly string[], consumed: readonly string[]): EvidenceCoverage {
	const uniqueConsumed = [...new Set(consumed)].sort();
	const unused = required.filter((id) => !uniqueConsumed.includes(id));
	if (unused.length) throw new Error(`basket PCR render ignored required evidence: ${unused.join(', ')}`);
	return { required: [...required], consumed: uniqueConsumed, unused };
}

function loadDetectorRuntime(): {
	readonly extractComponents: (mask: { width: number; height: number; data: Uint8Array }) => ComponentStage;
	readonly matchBasketSpritesSmart: (
		bright: { width: number; height: number; data: Uint8Array },
		dark: { width: number; height: number; data: Uint8Array },
		objects: readonly unknown[],
		template: BasketTemplateLike
	) => readonly BasketLike[];
	readonly basketTemplate: BasketTemplateLike;
} {
	const components = require('../../../packages/alg/dist/detectors/threeFactor/components.js') as {
		extractComponents: (mask: { width: number; height: number; data: Uint8Array }) => ComponentStage;
	};
	const smartBasket = require('../../../packages/alg/dist/detectors/threeFactor/smartBasket.js') as {
		matchBasketSpritesSmart: (
			bright: { width: number; height: number; data: Uint8Array },
			dark: { width: number; height: number; data: Uint8Array },
			objects: readonly unknown[],
			template: BasketTemplateLike
		) => readonly BasketLike[];
	};
	const basketTemplate = require('../../../packages/alg/dist/detectors/threeFactor/assets/basket-sprite.json') as BasketTemplateLike;
	return { ...components, ...smartBasket, basketTemplate };
}

function assertRunReceipt(value: unknown): asserts value is RunReceipt {
	const receipt = value as Partial<RunReceipt>;
	if (receipt.schema !== 'chainspot-lab-run-receipt@1') throw new Error(`expected chainspot-lab-run-receipt@1, got ${receipt.schema ?? 'UNKNOWN'}`);
	if (!receipt.intake?.widthPx || !receipt.intake.heightPx) throw new Error('run receipt does not declare canonical dimensions');
}

function contains(outer: ComponentLike, inner: ComponentLike): boolean {
	return outer.bboxX <= inner.bboxX && outer.bboxY <= inner.bboxY &&
		outer.bboxX + outer.bboxW >= inner.bboxX + inner.bboxW &&
		outer.bboxY + outer.bboxH >= inner.bboxY + inner.bboxH;
}

function enclosingDark(darkComponents: readonly ComponentLike[], body: ComponentLike): ComponentLike | undefined {
	return darkComponents.filter((component) => contains(component, body)).sort((left, right) =>
		left.bboxW * left.bboxH - right.bboxW * right.bboxH || right.area - left.area || left.label - right.label
	)[0];
}

function shellMargins(shell: ComponentLike, body: ComponentLike): readonly number[] {
	return [body.bboxX - shell.bboxX, body.bboxY - shell.bboxY, shell.bboxX + shell.bboxW - (body.bboxX + body.bboxW), shell.bboxY + shell.bboxH - (body.bboxY + body.bboxH)];
}

function cropRgba(source: Uint8Array, sourceWidth: number, sourceHeight: number, originX: number, originY: number, width: number, height: number): Uint8Array {
	const output = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
		const target = (y * width + x) * 4;
		const sourceX = originX + x;
		const sourceY = originY + y;
		if (sourceX < 0 || sourceX >= sourceWidth || sourceY < 0 || sourceY >= sourceHeight) { output[target + 3] = 255; continue; }
		const input = (sourceY * sourceWidth + sourceX) * 4;
		output.set(source.subarray(input, input + 4), target);
	}
	return output;
}

function cropMask(source: Uint8Array, sourceWidth: number, sourceHeight: number, originX: number, originY: number, width: number, height: number): Uint8Array {
	const output = new Uint8Array(width * height);
	for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
		const sourceX = originX + x;
		const sourceY = originY + y;
		if (sourceX >= 0 && sourceX < sourceWidth && sourceY >= 0 && sourceY < sourceHeight) output[y * width + x] = source[sourceY * sourceWidth + sourceX] ? 1 : 0;
	}
	return output;
}

function blendPixel(output: Uint8Array, index: number, color: readonly [number, number, number], alpha: number): void {
	const pixel = index * 4;
	for (let channel = 0; channel < 3; channel++) output[pixel + channel] = Math.round(output[pixel + channel] * (1 - alpha) + color[channel] * alpha);
	output[pixel + 3] = 255;
}

function overlayMask(source: Uint8Array, mask: Uint8Array, color: readonly [number, number, number], alpha = 0.82): Uint8Array {
	const output = source.slice();
	for (let index = 0; index < mask.length; index++) if (mask[index]) blendPixel(output, index, color, alpha);
	return output;
}

function meanRgba(crops: readonly Uint8Array[]): Uint8Array {
	if (!crops.length) throw new Error('cannot average an empty family');
	const output = new Uint8Array(crops[0].length);
	for (let index = 0; index < output.length; index += 4) {
		for (let channel = 0; channel < 3; channel++) output[index + channel] = Math.round(crops.reduce((sum, crop) => sum + crop[index + channel], 0) / crops.length);
		output[index + 3] = 255;
	}
	return output;
}

function pngDataUrl(rgba: Uint8Array, width: number, height: number): string {
	const png = new PNG({ width, height });
	png.data = Buffer.from(rgba);
	return `data:image/png;base64,${PNG.sync.write(png).toString('base64')}`;
}

function esc(value: unknown): string {
	return String(value).replace(/[&<>\"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;' })[character] ?? character);
}

function requireValue<T>(value: T | undefined, message: string): T {
	if (value === undefined) throw new Error(message);
	return value;
}

function deriveFamily(args: {
	readonly rows: readonly DerivedBasket[]; readonly rgba: Uint8Array; readonly bright: Uint8Array; readonly dark: Uint8Array;
	readonly sourceWidth: number; readonly sourceHeight: number; readonly cropWidth: number; readonly cropHeight: number;
	readonly modalKey: string; readonly margins: readonly number[];
}): FamilyEvidence {
	const cleanRows = args.rows.filter((row) => row.shellMargins?.join(',') === args.modalKey);
	const overlapRows = args.rows.filter((row) => row.shellMargins?.join(',') !== args.modalKey);
	if (cleanRows.length !== 16 || overlapRows.length !== 2) throw new Error(`expected Dashs 16 clean + 2 overlap baskets, got ${cleanRows.length} + ${overlapRows.length}`);
	const brightVotes = new Uint16Array(args.cropWidth * args.cropHeight);
	const darkVotes = new Uint16Array(args.cropWidth * args.cropHeight);
	const sourceCrops: Uint8Array[] = [];
	for (const row of cleanRows) {
		const body = requireValue(row.body, `basket ${row.detectorIndex} has no bright body`);
		const originX = body.bboxX - args.margins[0] - MOAT_PX;
		const originY = body.bboxY - args.margins[1] - MOAT_PX;
		const brightCrop = cropMask(args.bright, args.sourceWidth, args.sourceHeight, originX, originY, args.cropWidth, args.cropHeight);
		const darkCrop = cropMask(args.dark, args.sourceWidth, args.sourceHeight, originX, originY, args.cropWidth, args.cropHeight);
		sourceCrops.push(cropRgba(args.rgba, args.sourceWidth, args.sourceHeight, originX, originY, args.cropWidth, args.cropHeight));
		for (let index = 0; index < brightVotes.length; index++) { brightVotes[index] += brightCrop[index]; darkVotes[index] += darkCrop[index]; }
	}
	const mask = new Uint8Array(args.cropWidth * args.cropHeight);
	let brightPixels = 0;
	let darkPixels = 0;
	for (let index = 0; index < mask.length; index++) {
		const bright = brightVotes[index];
		const dark = darkVotes[index];
		const neither = cleanRows.length - bright - dark;
		if (bright > dark && bright > neither) { mask[index] = 1; brightPixels++; }
		else if (dark > bright && dark > neither) { mask[index] = 2; darkPixels++; }
	}
	return { width: args.cropWidth, height: args.cropHeight, mask, mean: meanRgba(sourceCrops), memberCount: cleanRows.length, brightPixels, darkPixels, unknownPixels: mask.length - brightPixels - darkPixels, cleanRows, overlapRows };
}

function familyOverlay(family: FamilyEvidence): Uint8Array {
	const output = family.mean.slice();
	for (let index = 0; index < family.mask.length; index++) {
		if (family.mask[index] === 1) blendPixel(output, index, RED, 0.82);
		else if (family.mask[index] === 2) blendPixel(output, index, BLUE, 0.82);
		else blendPixel(output, index, [55, 61, 72], 0.55);
	}
	return output;
}

function deriveBorder(args: {
	readonly family: FamilyEvidence; readonly rgba: Uint8Array; readonly sourceWidth: number; readonly sourceHeight: number;
	readonly darkLabels: Int32Array | Uint32Array; readonly margins: readonly number[];
}): BorderEvidence {
	const withFusedShell = args.family.overlapRows.find((row) => row.shell);
	const recovered = args.family.overlapRows.find((row) => !row.shell);
	if (!withFusedShell?.shell || !recovered) throw new Error('expected one fused-shell basket and one recovered basket');
	const owners = [withFusedShell, recovered] as const;
	const origins = owners.map((row) => [row.basket.x - args.margins[0] - MOAT_PX, row.basket.y - args.margins[1] - MOAT_PX] as const);
	const pad = 8;
	const x0 = Math.max(0, Math.min(origins[0][0], origins[1][0]) - pad);
	const y0 = Math.max(0, Math.min(origins[0][1], origins[1][1]) - pad);
	const x1 = Math.min(args.sourceWidth, Math.max(origins[0][0], origins[1][0]) + args.family.width + pad);
	const y1 = Math.min(args.sourceHeight, Math.max(origins[0][1], origins[1][1]) + args.family.height + pad);
	const width = x1 - x0;
	const height = y1 - y0;
	const image = cropRgba(args.rgba, args.sourceWidth, args.sourceHeight, x0, y0, width, height);
	const claim = (owner: 0 | 1, x: number, y: number, expected: 1 | 2): boolean => {
		const localX = x - origins[owner][0];
		const localY = y - origins[owner][1];
		return localX >= 0 && localY >= 0 && localX < args.family.width && localY < args.family.height && args.family.mask[localY * args.family.width + localX] === expected;
	};
	for (let owner = 0 as 0 | 1; owner < 2; owner = (owner + 1) as 0 | 1) for (let localY = 0; localY < args.family.height; localY++) for (let localX = 0; localX < args.family.width; localX++) {
		if (args.family.mask[localY * args.family.width + localX] !== 1) continue;
		const targetX = origins[owner][0] + localX - x0;
		const targetY = origins[owner][1] + localY - y0;
		if (targetX >= 0 && targetY >= 0 && targetX < width && targetY < height) blendPixel(image, targetY * width + targetX, owner === 0 ? [80, 190, 255] : [255, 120, 130], 0.72);
	}
	let bluePixels = 0;
	let redPixels = 0;
	let sharedPixels = 0;
	let residualPixels = 0;
	const shell = withFusedShell.shell;
	for (let y = shell.bboxY; y < shell.bboxY + shell.bboxH; y++) for (let x = shell.bboxX; x < shell.bboxX + shell.bboxW; x++) {
		if (args.darkLabels[y * args.sourceWidth + x] !== shell.label) continue;
		const blue = claim(0, x, y, 2);
		const red = claim(1, x, y, 2);
		const color = blue && red ? PURPLE : blue ? BLUE : red ? RED : YELLOW;
		if (blue && red) sharedPixels++; else if (blue) bluePixels++; else if (red) redPixels++; else residualPixels++;
		blendPixel(image, (y - y0) * width + x - x0, color, 0.94);
	}
	return { image, width, height, origin: [x0, y0], upperDetectorIndex: withFusedShell.detectorIndex, lowerDetectorIndex: recovered.detectorIndex, fusedComponentLabel: shell.label, bluePixels, redPixels, sharedPixels, residualPixels };
}

function deriveSubtraction(control: Specimen, family: FamilyEvidence): SubtractionEvidence {
	const image = control.sourceCrop.slice();
	let composedPixels = 0;
	let unclaimedPixels = 0;
	for (let index = 0; index < family.mask.length; index++) {
		if (family.mask[index] === 1) { blendPixel(image, index, RED, 0.82); composedPixels++; }
		else if (family.mask[index] === 2) { blendPixel(image, index, BLUE, 0.82); composedPixels++; }
		else { blendPixel(image, index, YELLOW, 0.38); unclaimedPixels++; }
	}
	return { image, composedPixels, unclaimedPixels };
}

function panel(args: { x: number; y: number; w: number; h: number; title: string; subtitle: string; image: string; imageW?: number; imageH?: number; titleClass?: string }): string {
	const imageW = args.imageW ?? args.w - 28;
	const imageH = args.imageH ?? args.h - 92;
	return `<g><rect x="${args.x}" y="${args.y}" width="${args.w}" height="${args.h}" rx="10" class="card"/>
	<text x="${args.x + 14}" y="${args.y + 27}" class="head ${args.titleClass ?? ''}">${esc(args.title)}</text>
	<image x="${args.x + (args.w - imageW) / 2}" y="${args.y + 42}" width="${imageW}" height="${imageH}" href="${args.image}" class="pixel"/>
	<text x="${args.x + 14}" y="${args.y + args.h - 18}" class="mono">${esc(args.subtitle)}</text></g>`;
}

function renderProgression(args: RenderInputs): { svg: string; coverage: EvidenceCoverage } {
	const completed = ticksThrough(args.through);
	const consumed = completed.flatMap((tick) => TICK_EVIDENCE[tick]);
	const coverage = reconcileEvidence(requiredRenderEvidence(args.through), consumed);
	const t1Url = pngDataUrl(overlayMask(args.control.sourceCrop, args.control.mask1, BLUE), args.cropWidth, args.cropHeight);
	const t2Url = completed.includes('T2') ? pngDataUrl(overlayMask(args.control.sourceCrop, requireValue(args.control.mask2, 'T2 missing Mask2'), RED), args.cropWidth, args.cropHeight) : undefined;
	const familyUrl = args.family ? pngDataUrl(familyOverlay(args.family), args.family.width, args.family.height) : undefined;
	const borderUrl = args.border ? pngDataUrl(args.border.image, args.border.width, args.border.height) : undefined;
	const subtractionUrl = args.subtraction ? pngDataUrl(args.subtraction.image, args.cropWidth, args.cropHeight) : undefined;
	const width = 1660;
	const margin = 30;
	const panelTop = 186;
	const panelWidth = 300;
	const panelHeight = 482;
	const gap = 18;
	const panels: string[] = [];
	panels.push(panel({ x: margin, y: panelTop, w: panelWidth, h: panelHeight, title: 'T1 · MASK1', subtitle: `one control · dark ${args.control.mask1Count} px`, image: t1Url, titleClass: 'blue' }));
	if (t2Url) panels.push(panel({ x: margin + panelWidth + gap, y: panelTop, w: panelWidth, h: panelHeight, title: 'T2 · MASK2', subtitle: `same control · bright ${args.control.mask2Count ?? 0} px`, image: t2Url, titleClass: 'red' }));
	if (familyUrl && args.family) panels.push(panel({ x: margin + 2 * (panelWidth + gap), y: panelTop, w: panelWidth, h: panelHeight, title: 'T3 · SUPERPOSITION', subtitle: `${args.family.memberCount} clean → ${args.family.brightPixels}R + ${args.family.darkPixels}B`, image: familyUrl }));
	if (borderUrl && args.border) panels.push(panel({ x: margin + 3 * (panelWidth + gap), y: panelTop, w: panelWidth, h: panelHeight, title: 'T4 · BORDER MAP', subtitle: `B${args.border.bluePixels} R${args.border.redPixels} P${args.border.sharedPixels} Y${args.border.residualPixels}`, image: borderUrl }));
	if (subtractionUrl && args.subtraction) panels.push(panel({ x: margin + 4 * (panelWidth + gap), y: panelTop, w: panelWidth, h: panelHeight, title: 'T5 · B+W SUBTRACTION', subtitle: `owned ${args.subtraction.composedPixels} · unknown ${args.subtraction.unclaimedPixels}`, image: subtractionUrl }));
	const timingText = Object.entries(args.timings).map(([name, value]) => `${name} ${value.toFixed(1)}ms`).join(' · ');
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="760" viewBox="0 0 ${width} 760">
	<style>.bg{fill:#0d131d}.card{fill:#141d29;stroke:#314054}.title{font:700 28px sans-serif;fill:#f8fafc}.sub{font:16px sans-serif;fill:#bac6d7}.head{font:700 17px sans-serif;fill:#f3f6fa}.mono{font:12px monospace;fill:#c5d0df}.small{font:12px sans-serif;fill:#91a0b4}.blue{fill:#4b99ff}.red{fill:#ff5368}.pixel{image-rendering:pixelated}</style>
	<rect width="100%" height="100%" class="bg"/>
	<text x="${margin}" y="42" class="title">BASKET COMPOSITION PCR — THROUGH ${args.through}</text>
	<text x="${margin}" y="74" class="sub">One basket until T3. Then family superposition → overlap border mapping → exact B+W subtraction.</text>
	<text x="${margin}" y="104" class="sub">Blue/red before T3 are mask observations, not ownership. T4 purple = shared; yellow = residue. T5 yellow = UNKNOWN, not “basket.”</text>
	<text x="${margin}" y="134" class="sub">Control ${esc(args.control.id)} · origin ${args.control.origin.join(',')} · crop ${args.cropWidth}×${args.cropHeight} · shell [${args.shellMargins.join(',')}] · truth used NO</text>
	<text x="${margin}" y="164" class="small">${esc(timingText)}</text>
	${panels.join('\n')}
	<text x="${margin}" y="714" class="mono">progression ${completed.join(' → ')} · future ${TICK_SEQUENCE.slice(completed.length).join('/') || 'NONE'} · evidence ${coverage.consumed.length}/${coverage.required.length} · unused ${coverage.unused.length}</text>
	<text x="${margin}" y="740" class="small">This frame defines the handoff spine. It does not claim the family, mapping, or remainder is accepted production behavior.</text>
	</svg>\n`;
	return { svg, coverage };
}

export function runBasketCompositionPcr(input: BasketCompositionPcrInput): BasketCompositionPcrResult {
	const totalStart = performance.now();
	const completedTicks = ticksThrough(input.through);
	const runDir = resolve(input.runDir);
	const outDir = resolve(input.outDir);
	const loadStart = performance.now();
	const runReceiptRaw: unknown = JSON.parse(readFileSync(resolve(runDir, 'run.receipt.json'), 'utf8'));
	assertRunReceipt(runReceiptRaw);
	const width = runReceiptRaw.intake.widthPx;
	const height = runReceiptRaw.intake.heightPx;
	const rgba = new Uint8Array(readFileSync(resolve(runDir, 'artifacts/rgba/badgeStage.masks.localImage.bin')));
	const bright = new Uint8Array(readFileSync(resolve(runDir, 'artifacts/mask/badgeStage.masks.bright.bin')));
	const dark = new Uint8Array(readFileSync(resolve(runDir, 'artifacts/mask/badgeStage.masks.dark.bin')));
	if (rgba.length !== width * height * 4 || bright.length !== width * height || dark.length !== width * height) throw new Error('cached raster/mask byte lengths do not match declared canonical dimensions');
	const loadMs = performance.now() - loadStart;

	const deriveStart = performance.now();
	const runtime = loadDetectorRuntime();
	const brightMask = { width, height, data: bright };
	const darkMask = { width, height, data: dark };
	const baskets = runtime.matchBasketSpritesSmart(brightMask, darkMask, [], runtime.basketTemplate);
	const brightStage = runtime.extractComponents(brightMask);
	const darkStage = runtime.extractComponents(darkMask);
	const brightByLabel = new Map(brightStage.components.map((component) => [component.label, component]));
	const rows: DerivedBasket[] = baskets.map((basket, detectorIndex) => {
		const sourceMatch = /^bright-component:(\d+)$/.exec(basket.source);
		const body = sourceMatch ? brightByLabel.get(Number(sourceMatch[1])) : undefined;
		const shell = body ? enclosingDark(darkStage.components, body) : undefined;
		return { detectorIndex, basket, body, shell, shellMargins: body && shell ? shellMargins(shell, body) : undefined };
	});
	const controlRow = requireValue(rows.find((row) => row.body && row.shell && row.shellMargins), 'no independently enclosed control basket exists');
	const controlBody = requireValue(controlRow.body, 'control body missing');
	const controlMargins = requireValue(controlRow.shellMargins, 'control shell margins missing');
	const cropWidth = runtime.basketTemplate.width + controlMargins[0] + controlMargins[2] + MOAT_PX * 2;
	const cropHeight = runtime.basketTemplate.height + controlMargins[1] + controlMargins[3] + MOAT_PX * 2;
	const controlOriginX = controlBody.bboxX - controlMargins[0] - MOAT_PX;
	const controlOriginY = controlBody.bboxY - controlMargins[1] - MOAT_PX;
	const controlMask1 = cropMask(dark, width, height, controlOriginX, controlOriginY, cropWidth, cropHeight);
	const controlMask2 = completedTicks.includes('T2') ? cropMask(bright, width, height, controlOriginX, controlOriginY, cropWidth, cropHeight) : undefined;
	const control: Specimen = {
		id: `basket ${String(controlRow.detectorIndex + 1).padStart(2, '0')} · detector ordinal`, detectorIndex: controlRow.detectorIndex,
		basketSource: controlRow.basket.source, origin: [controlOriginX, controlOriginY],
		sourceCrop: cropRgba(rgba, width, height, controlOriginX, controlOriginY, cropWidth, cropHeight),
		mask1: controlMask1, mask1Count: controlMask1.reduce((sum, value) => sum + value, 0), mask2: controlMask2,
		mask2Count: controlMask2?.reduce((sum, value) => sum + value, 0)
	};

	let modalKey: string | undefined;
	let modalSupport: number | undefined;
	let family: FamilyEvidence | undefined;
	let border: BorderEvidence | undefined;
	let subtraction: SubtractionEvidence | undefined;
	if (completedTicks.includes('T3')) {
		const counts = new Map<string, number>();
		for (const row of rows) if (row.shellMargins) { const key = row.shellMargins.join(','); counts.set(key, (counts.get(key) ?? 0) + 1); }
		const modal = requireValue([...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0], 'no basket shell-margin family exists');
		modalKey = modal[0];
		modalSupport = modal[1];
		const modalMargins = modalKey.split(',').map(Number);
		if (modalMargins.join(',') !== controlMargins.join(',')) throw new Error(`control margins [${controlMargins}] disagree with family [${modalMargins}]`);
		family = deriveFamily({ rows, rgba, bright, dark, sourceWidth: width, sourceHeight: height, cropWidth, cropHeight, modalKey, margins: modalMargins });
	}
	if (completedTicks.includes('T4')) border = deriveBorder({ family: requireValue(family, 'T4 requires T3 family'), rgba, sourceWidth: width, sourceHeight: height, darkLabels: darkStage.labels, margins: controlMargins });
	if (completedTicks.includes('T5')) subtraction = deriveSubtraction(control, requireValue(family, 'T5 requires T3 family'));
	const deriveMs = performance.now() - deriveStart;

	const timings = { loadCachedEvidenceMs: loadMs, deriveThroughTickMs: deriveMs };
	const renderStart = performance.now();
	const rendered = renderProgression({ control, cropWidth, cropHeight, shellMargins: controlMargins, timings, through: input.through, family, border, subtraction });
	const renderMs = performance.now() - renderStart;
	mkdirSync(outDir, { recursive: true });
	const stem = `basket-composition.pcr-through-${input.through.toLowerCase()}`;
	const visualRenderPath = resolve(outDir, `${stem}.svg`);
	const receiptJsonPath = resolve(outDir, `${stem}.receipt.json`);
	const receiptTextPath = resolve(outDir, `${stem}.receipt.txt`);
	const writeStart = performance.now();
	writeFileSync(visualRenderPath, rendered.svg);
	const writeMs = performance.now() - writeStart;
	const timingsMs = { loadCachedEvidenceMs: Number(loadMs.toFixed(3)), deriveThroughTickMs: Number(deriveMs.toFixed(3)), renderMs: Number(renderMs.toFixed(3)), writeVisualMs: Number(writeMs.toFixed(3)), observedTotalBeforeReceiptMs: Number((performance.now() - totalStart).toFixed(3)) };
	const receipt = {
		schema: 'chainspot-basket-composition-pcr@1', status: 'progressive-handoff-definition', contract: CONTRACT_PATH,
		progression: { through: input.through, completedTicks, futureTicks: TICK_SEQUENCE.slice(completedTicks.length) },
		source: { runDir, runReceipt: resolve(runDir, 'run.receipt.json'), canonicalSources: runReceiptRaw.intake.sources ?? [], canonicalImageId: runReceiptRaw.intake.canonicalImageId ?? 'UNKNOWN', dimensions: [width, height], config: runReceiptRaw.config ?? 'UNKNOWN', truthUsed: false, cache: { rgba: resolve(runDir, 'artifacts/rgba/badgeStage.masks.localImage.bin'), mask1: resolve(runDir, 'artifacts/mask/badgeStage.masks.dark.bin'), ...(completedTicks.includes('T2') ? { mask2: resolve(runDir, 'artifacts/mask/badgeStage.masks.bright.bin') } : {}) } },
		control: { selection: 'first detector-accepted basket whose bright body has its own enclosing dark component', id: control.id, detectorIndex: control.detectorIndex, basketSource: control.basketSource, origin: control.origin, crop: [cropWidth, cropHeight], shellMargins: controlMargins, moatPx: MOAT_PX },
		ticks: {
			T1: { input: 'one control basket + cached canonical RGBA', output: 'cached dark-mask observations in control coordinates', semantics: 'observation, not ownership', mask1Pixels: control.mask1Count },
			...(completedTicks.includes('T2') ? { T2: { input: 'same control with T1 preserved', output: 'cached bright-mask observations in identical coordinates', semantics: 'observation, not ownership', mask2Pixels: control.mask2Count } } : {}),
			...(family ? { T3: { input: `${family.memberCount} independently enclosed baskets`, output: 'categorical per-pixel family by bright/dark/neither mode; ties UNKNOWN', modalShellMargins: modalKey?.split(',').map(Number), modalSupport, familyCanvas: [family.width, family.height], brightPixels: family.brightPixels, darkPixels: family.darkPixels, unknownPixels: family.unknownPixels, memberDetectorIndices: family.cleanRows.map((row) => row.detectorIndex), overlapDetectorIndices: family.overlapRows.map((row) => row.detectorIndex) } } : {}),
			...(border ? { T4: { input: 'T3 family aligned over the two overlap baskets', output: 'exact fused-dark-component custody classes', upperDetectorIndex: border.upperDetectorIndex, lowerDetectorIndex: border.lowerDetectorIndex, fusedComponentLabel: border.fusedComponentLabel, mapping: { blueOnly: border.bluePixels, redOnly: border.redPixels, shared: border.sharedPixels, residual: border.residualPixels }, semantics: { blue: 'upper family claim', red: 'lower family claim', purple: 'shared claim / merge', yellow: 'unexplained fused-component residue' } } } : {}),
			...(subtraction ? { T5: { input: 'control evaluation crop minus exact non-UNKNOWN T3 family support', output: 'composed B+W support plus unclaimed pixels', composedPixels: subtraction.composedPixels, unclaimedPixels: subtraction.unclaimedPixels, semantics: 'unclaimed pixels remain UNKNOWN; this tick makes no basket/fringe/direction claim' } } : {})
		},
		renderEvidenceCoverage: rendered.coverage, timingsMs,
		outputs: { visualRender: visualRenderPath, machineReceipt: receiptJsonPath, cliReceipt: receiptTextPath }
	};
	const familyText = family ? ` · T3 ${family.memberCount}→${family.brightPixels + family.darkPixels} composed/${family.unknownPixels} unknown` : '';
	const borderText = border ? ` · T4 B${border.bluePixels}/R${border.redPixels}/P${border.sharedPixels}/Y${border.residualPixels}` : '';
	const subtractionText = subtraction ? ` · T5 ${subtraction.composedPixels} composed/${subtraction.unclaimedPixels} unclaimed` : '';
	const text = [
		`BASKET COMPOSITION PCR — THROUGH ${input.through}`,
		`source: ${basename(runDir)} · ${width}x${height} · truth used: NO`,
		`control: ${control.id} · ${control.basketSource} · origin ${control.origin.join(',')} · only one basket before T3`,
		`progression: ${completedTicks.join(' -> ')}; future ${TICK_SEQUENCE.slice(completedTicks.length).join('/') || 'NONE'}`,
		`evidence: T1 dark ${control.mask1Count}px${control.mask2Count === undefined ? '' : ` · T2 bright ${control.mask2Count}px`}${familyText}${borderText}${subtractionText}`,
		`render evidence coverage: ${rendered.coverage.consumed.length}/${rendered.coverage.required.length} · unused ${rendered.coverage.unused.length}`,
		`timings: load ${timingsMs.loadCachedEvidenceMs}ms · derive ${timingsMs.deriveThroughTickMs}ms · render ${timingsMs.renderMs}ms · total ${timingsMs.observedTotalBeforeReceiptMs}ms`,
		`VisualRender: ${visualRenderPath}`,
		`machine receipt: ${receiptJsonPath}`
	].join('\n');
	writeFileSync(receiptJsonPath, `${JSON.stringify(receipt, null, 2)}\n`);
	writeFileSync(receiptTextPath, `${text}\n`);
	return { visualRenderPath, receiptJsonPath, receiptTextPath, receipt };
}
