import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, extname, resolve } from 'node:path';
import { PNG } from 'pngjs';
import { decodeNodeFile } from '@chainspot/alg/adapters/node';
import type { StageContract, StageOutput, StagePanel } from '@chainspot/alg/stages/contract';

const require = createRequire(import.meta.url);
const DIST_STAGES = resolve('packages', 'alg', 'dist', 'stages');

export interface StageSweepResult {
	readonly throughStage: string;
	readonly outDir: string;
	readonly progressionPath: string;
	readonly receiptPath: string;
}

export function discoverStageContracts(): StageContract[] {
	if (!existsSync(DIST_STAGES)) {
		throw new Error('lab sweep: compiled Stages are unavailable; run the @chainspot/alg build.');
	}
	const adapters = readdirSync(DIST_STAGES, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && /^S\d+$/.test(entry.name))
		.map((entry) => resolve(DIST_STAGES, entry.name, 'contract.js'))
		.filter(existsSync)
		.map((modulePath) => {
			const loaded = require(modulePath) as { stageContract?: StageContract };
			if (!loaded.stageContract)
				throw new Error(`lab sweep: '${modulePath}' does not export stageContract.`);
			return loaded.stageContract;
		})
		.sort((left, right) => Number(left.id.slice(1)) - Number(right.id.slice(1)));
	const seen = new Set<string>();
	for (const adapter of adapters) {
		if (seen.has(adapter.id))
			throw new Error(`lab sweep: duplicate Stage adapter '${adapter.id}'.`);
		seen.add(adapter.id);
	}
	return adapters;
}

export function isSweepStage(value: string): boolean {
	return discoverStageContracts().some((stage) => stage.id === value);
}

function blitScaled(
	target: PNG,
	panel: StagePanel,
	destinationX: number,
	panelWidth: number,
	panelHeight: number
): void {
	for (let y = 0; y < panelHeight; y++) {
		const sy = Math.min(panel.heightPx - 1, Math.floor((y * panel.heightPx) / panelHeight));
		for (let x = 0; x < panelWidth; x++) {
			const sx = Math.min(panel.widthPx - 1, Math.floor((x * panel.widthPx) / panelWidth));
			const sourceOffset = (sy * panel.widthPx + sx) * 4;
			const targetOffset = (y * target.width + destinationX + x) * 4;
			target.data[targetOffset] = panel.rgba[sourceOffset];
			target.data[targetOffset + 1] = panel.rgba[sourceOffset + 1];
			target.data[targetOffset + 2] = panel.rgba[sourceOffset + 2];
			target.data[targetOffset + 3] = panel.rgba[sourceOffset + 3];
		}
	}
	const scaleX = panelWidth / panel.widthPx;
	const scaleY = panelHeight / panel.heightPx;
	for (const box of panel.boxes ?? []) {
		const [x, y, width, height] = box.bbox;
		stroke(
			target,
			destinationX + Math.round(x * scaleX),
			Math.round(y * scaleY),
			Math.max(3, Math.round(width * scaleX)),
			Math.max(3, Math.round(height * scaleY)),
			box.color
		);
	}
}

export function stroke(
	png: PNG,
	x0: number,
	y0: number,
	width: number,
	height: number,
	color: readonly [number, number, number, number]
): void {
	const put = (x: number, y: number) => {
		if (x >= 0 && y >= 0 && x < png.width && y < png.height)
			png.data.set(color, (y * png.width + x) * 4);
	};
	for (let offset = 0; offset < 2; offset++) {
		for (let x = x0; x < x0 + width; x++) {
			put(x, y0 + offset);
			put(x, y0 + height - 1 - offset);
		}
		for (let y = y0; y < y0 + height; y++) {
			put(x0 + offset, y);
			put(x0 + width - 1 - offset, y);
		}
	}
}

export function renderProgression(panels: readonly StagePanel[]): PNG {
	const panelWidth = Math.min(420, ...panels.map((panel) => panel.widthPx));
	const panelHeights = panels.map((panel) =>
		Math.round((panel.heightPx / panel.widthPx) * panelWidth)
	);
	const height = Math.max(...panelHeights);
	const gap = 24;
	const png = new PNG({
		width: panelWidth * panels.length + gap * (panels.length - 1),
		height,
		colorType: 6
	});
	png.data.fill(238);
	panels.forEach((panel, index) =>
		blitScaled(png, panel, index * (panelWidth + gap), panelWidth, panelHeights[index])
	);
	return png;
}

export async function runStageSweep(
	throughStage: string,
	inputPath: string
): Promise<StageSweepResult> {
	if (!['.png', '.jpg', '.jpeg'].includes(extname(inputPath).toLowerCase()))
		throw new Error(`lab sweep: Stage input '${inputPath}' is not .png/.jpg/.jpeg.`);
	const adapters = discoverStageContracts();
	const targetIndex = adapters.findIndex((stage) => stage.id === throughStage);
	if (targetIndex < 0) {
		throw new Error(
			`lab sweep: unknown Stage '${throughStage}'; available=[${adapters.map((stage) => stage.id).join(', ')}].`
		);
	}
	const absoluteInput = resolve(inputPath);
	const runName = basename(inputPath, extname(inputPath));
	const outDir = resolve('artifacts', 'sweep', 'stages', `${runName}-through-${throughStage}`);
	mkdirSync(outDir, { recursive: true });
	let pxc: StageOutput['pxc'] | undefined;
	const receipts: string[] = [];
	let output: StageOutput | undefined;
	for (const adapter of adapters.slice(0, targetIndex + 1)) {
		output = await adapter.execute({
			source: absoluteInput,
			inputLabel: basename(absoluteInput),
			decode: decodeNodeFile,
			...(pxc ? { pxc } : {})
		});
		pxc = output.pxc;
		receipts.push(output.receiptText);
	}
	if (!output) throw new Error(`lab sweep: Stage '${throughStage}' produced no output.`);
	const progressionPath = resolve(outDir, 'progression.png');
	const receiptPath = resolve(outDir, 'run.receipt.txt');
	writeFileSync(progressionPath, PNG.sync.write(renderProgression(output.panels)));
	writeFileSync(
		receiptPath,
		`${receipts.join('\n\n')}\nreplicate: ./lab sweep --through ${throughStage} "${absoluteInput}"\n`
	);
	return { throughStage, outDir, progressionPath, receiptPath };
}
