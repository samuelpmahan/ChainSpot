/**
 * `lab crop` — magnified crop of a shipped run render, promoted from the
 * integration night's scratchpad croppers (2026-08-29). "ITERATION AND
 * VISUALIZATION IS KEY": every diagnosis that night started with a crop of
 * the visual receipt or the canonical raster at a suspect coordinate, so
 * the tool is one command instead of a rewritten scratch script.
 *
 * Coordinates are canonical raster pixels (the same frame the receipts and
 * annotations use). Nearest-neighbor upscale only — no resampling is
 * allowed to invent pixels that are not in the evidence.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function usage(): never {
	console.log(
		[
			'Usage: lab crop COURSE X,Y [--config NAME] [--image visual|canonical|PATH]',
			'                [--size WxH] [--scale N] [--out FILE]',
			'',
			'Writes a nearest-neighbor magnified crop centered on X,Y (canonical px).',
			"COURSE resolves under artifacts/sweep/<config> (default config:",
			"dev72-recovered-default); --image visual = the hole-labeled visual",
			'receipt (default), canonical = the exact raster the sweep executed,',
			'or any PNG path. Defaults: --size 140x120, --scale 4.'
		].join('\n')
	);
	process.exit(2);
}

function main(argv: readonly string[]): number {
	let configName = 'dev72-recovered-default';
	let image = 'visual';
	let width = 140;
	let height = 120;
	let scale = 4;
	let out: string | undefined;
	const positional: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === '--config') configName = argv[++i]!;
		else if (arg === '--image') image = argv[++i]!;
		else if (arg === '--size') {
			const match = /^(\d+)x(\d+)$/.exec(argv[++i] ?? '');
			if (!match) usage();
			width = Number(match[1]);
			height = Number(match[2]);
		} else if (arg === '--scale') scale = Number(argv[++i]);
		else if (arg === '--out') out = argv[++i];
		else if (arg === '--help' || arg === '-h') usage();
		else positional.push(arg);
	}
	const [course, point] = positional;
	const pointMatch = /^(-?\d+),(-?\d+)$/.exec(point ?? '');
	if (!course || !pointMatch || !Number.isInteger(scale) || scale < 1) usage();
	const centerX = Number(pointMatch[1]);
	const centerY = Number(pointMatch[2]);

	const repoRoot = resolve(HERE, '../../..');
	let sourcePath: string;
	if (image !== 'visual' && image !== 'canonical') {
		sourcePath = resolve(repoRoot, image);
	} else {
		const relative =
			image === 'visual' ? 'renders/run/run.visual.png' : 'renders/input/g0.canonical.png';
		const candidates = [
			join(repoRoot, 'artifacts/sweep', configName, 'batches', course, 'full', relative),
			join(repoRoot, 'artifacts/sweep', configName, `${course}-full`, relative)
		];
		const found = candidates.find((candidate) => existsSync(candidate));
		if (!found) {
			console.error(
				`lab crop: no ${image} render for ${course} under config '${configName}' -- looked at:\n  ` +
					candidates.join('\n  ') +
					'\nRun `lab sweep` for that course/config first.'
			);
			return 2;
		}
		sourcePath = found;
	}
	if (!existsSync(sourcePath)) {
		console.error(`lab crop: no such image ${sourcePath}`);
		return 2;
	}

	const png = PNG.sync.read(readFileSync(sourcePath));
	const x0 = centerX - Math.floor(width / 2);
	const y0 = centerY - Math.floor(height / 2);
	const output = new PNG({ width: width * scale, height: height * scale });
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const sx = x0 + x;
			const sy = y0 + y;
			let r = 24, g = 24, b = 24; // off-raster: dark, never invented content
			if (sx >= 0 && sy >= 0 && sx < png.width && sy < png.height) {
				const p = (sy * png.width + sx) * 4;
				r = png.data[p]!;
				g = png.data[p + 1]!;
				b = png.data[p + 2]!;
			}
			for (let dy = 0; dy < scale; dy++) {
				for (let dx = 0; dx < scale; dx++) {
					const i = ((y * scale + dy) * width * scale + (x * scale + dx)) * 4;
					output.data[i] = r;
					output.data[i + 1] = g;
					output.data[i + 2] = b;
					output.data[i + 3] = 255;
				}
			}
		}
	}
	const outPath =
		out ??
		join(
			repoRoot,
			'artifacts/crops',
			`${course.replace(/[^A-Za-z0-9_-]/g, '_')}-${image === 'canonical' ? 'canonical' : 'visual'}-${centerX}x${centerY}-s${scale}.png`
		);
	mkdirSync(dirname(outPath), { recursive: true });
	writeFileSync(outPath, PNG.sync.write(output));
	console.log(
		`crop: ${sourcePath}\n  center (${centerX},${centerY}) canonical px, window ${width}x${height}, ` +
			`scale ${scale}x (nearest-neighbor)\n  -> ${outPath}`
	);
	return 0;
}

process.exit(main(process.argv.slice(2)));
