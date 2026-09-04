import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { PNG } from 'pngjs';
import { formatS0ReceiptText } from '@chainspot/alg/exec';
import { executeNodeCanonicalInputTick } from '@chainspot/alg/exec/node-intake';

const inputArg = process.argv[2];
if (!inputArg) {
	console.error('usage: npm run proof:s0 -- <full-image> [output-directory]');
	process.exitCode = 2;
} else {
	const inputPath = resolve(inputArg);
	const outputDir = resolve(process.argv[3] ?? 'artifacts/s0-full-to-cropped');
	mkdirSync(outputDir, { recursive: true });
	const run = await executeNodeCanonicalInputTick(inputPath);

	function boundaryRaster() {
		const { widthPx: width, heightPx: height, rgba } = run.fullImage;
		const marked = new Uint8ClampedArray(rgba);
		const insets = run.crop.insets;
		if (!insets) return { ...run.fullImage, rgba: marked };
		const inside = (x, y) =>
			x >= insets.left && x < width - insets.right && y >= insets.top && y < height - insets.bottom;
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				const offset = (y * width + x) * 4;
				if (!inside(x, y)) {
					marked[offset] = Math.round(marked[offset] * 0.55 + 255 * 0.45);
					marked[offset + 1] = Math.round(marked[offset + 1] * 0.55);
					marked[offset + 2] = Math.round(marked[offset + 2] * 0.55);
				}
			}
		}
		return { ...run.fullImage, rgba: marked };
	}

	function progressionPng() {
		const panelWidth = Math.min(360, run.fullImage.widthPx);
		const scale = panelWidth / run.fullImage.widthPx;
		const panelHeight = Math.round(run.fullImage.heightPx * scale);
		const gap = 48;
		const labelHeight = 12;
		const width = panelWidth * 3 + gap * 2;
		const height = labelHeight + panelHeight;
		const png = new PNG({ width, height });

		function fillRect(x0, y0, w, h, color) {
			for (let y = Math.max(0, y0); y < Math.min(height, y0 + h); y++) {
				for (let x = Math.max(0, x0); x < Math.min(width, x0 + w); x++) {
					const offset = (y * width + x) * 4;
					png.data.set(color, offset);
				}
			}
		}

		function blitScaled(raster, dx, dy, dw, dh) {
			for (let y = 0; y < dh; y++) {
				const sy = Math.min(raster.heightPx - 1, Math.floor((y * raster.heightPx) / dh));
				for (let x = 0; x < dw; x++) {
					const sx = Math.min(raster.widthPx - 1, Math.floor((x * raster.widthPx) / dw));
					const sourceOffset = (sy * raster.widthPx + sx) * 4;
					const destinationOffset = ((dy + y) * width + dx + x) * 4;
					png.data[destinationOffset] = raster.rgba[sourceOffset];
					png.data[destinationOffset + 1] = raster.rgba[sourceOffset + 1];
					png.data[destinationOffset + 2] = raster.rgba[sourceOffset + 2];
					png.data[destinationOffset + 3] = raster.rgba[sourceOffset + 3];
				}
			}
		}

		function arrow(x0, centerY) {
			fillRect(x0, centerY - 3, 24, 6, [109, 40, 217, 255]);
			for (let n = 0; n < 11; n++) {
				const halfHeight = 10 - n;
				fillRect(x0 + 22 + n, centerY - halfHeight, 1, halfHeight * 2 + 1, [109, 40, 217, 255]);
			}
		}

		fillRect(0, 0, width, height, [229, 231, 235, 255]);
		const firstX = 0;
		const secondX = panelWidth + gap;
		const thirdX = (panelWidth + gap) * 2;
		fillRect(firstX, 0, panelWidth, labelHeight, [59, 130, 246, 255]);
		fillRect(secondX, 0, panelWidth, labelHeight, [250, 204, 21, 255]);
		fillRect(thirdX, 0, panelWidth, labelHeight, [34, 197, 94, 255]);
		blitScaled(run.fullImage, firstX, labelHeight, panelWidth, panelHeight);
		blitScaled(boundaryRaster(), secondX, labelHeight, panelWidth, panelHeight);

		const top = Math.round((run.crop.insets?.top ?? 0) * scale);
		const left = Math.round((run.crop.insets?.left ?? 0) * scale);
		const croppedWidth = Math.round(run.input.widthPx * scale);
		const croppedHeight = Math.round(run.input.heightPx * scale);
		blitScaled(run.input, thirdX + left, labelHeight + top, croppedWidth, croppedHeight);
		arrow(panelWidth + 8, labelHeight + Math.round(panelHeight / 2));
		arrow(panelWidth * 2 + gap + 8, labelHeight + Math.round(panelHeight / 2));
		return PNG.sync.write(png);
	}

	const progressionPath = join(outputDir, 'S0-progression.png');
	const receiptPath = join(outputDir, 'S0.receipt.txt');
	writeFileSync(progressionPath, progressionPng());
	const receipt = `${formatS0ReceiptText(run, {
		inputLabel: basename(inputPath),
		progression: 'left=FullImage · center=crop boundary · right=CroppedImage in PxC (source-aligned) · then cache FullImage'
	})}\nprogressionArtifact: ${progressionPath}`;
	writeFileSync(receiptPath, `${receipt}\n`);
	console.log(receipt);
}
