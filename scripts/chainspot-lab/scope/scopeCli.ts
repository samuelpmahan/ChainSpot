import { basename, extname, resolve } from 'node:path';
import { loadScopeManifest, resolveManifestCasePaths } from './manifest';
import { makeContactSheet } from './render';
import { DEFAULT_SCOPE_OUT, runScopeOperation, scopeSlug } from './operation';
import { SCOPE_TEMPLATES } from './templates';
import { consumeViewOptions } from './viewOptions';
import type { BoxTuple, PointTuple, ScopeRequest } from './types';

function usage(exitCode = 0): never {
	console.error([
		'SCOPE — inspect Sweep-canonical visual evidence',
		'',
		'Raster contract:',
		'  raw capture(s) -> Sweep StripChrome -> Sweep AutoStitch -> canonical raster -> Scope AutoCrop',
		'  `scope full` shows the entire canonical raster AFTER StripChrome/AutoStitch and BEFORE Scope AutoCrop.',
		'',
		'Usage:',
		'  lab scope IMAGE x,y [view flags]',
		'  lab scope IMAGE x,y,w,h [view flags]',
		'  lab scope full IMAGE [view flags]',
		'  lab scope mark IMAGE NAME x,y [view flags]',
		'  lab scope dots IMAGE NAME x,y x,y ... [view flags]',
		'  lab scope path IMAGE NAME x,y x,y ... [view flags]     # one-shot geometry only',
		'  lab scope --hole N IMAGE ANNOTATION.json [view flags]',
		'  lab scope --manifest MANIFEST.json [--case NAME] [--out-dir DIR]',
		'  lab scope contact-sheet MANIFEST.json [--case NAME] [--out FILE]',
		'  lab scope templates',
		'',
		'Views:',
		'  full                whole canonical raster, pre-ScopeCrop',
		'  default             CONTEXT -> LOCAL -> FORENSIC WIDE -> MID -> TIGHT',
		'',
		'View tuning:',
		'  --context N         Context source span (default 800 canonical px)',
		'  --context-out N     Context output size (default 800)',
		'  --full-out N        full-view output box (default 1200; aspect preserved)',
		'  --local-extra-w N   total extra Local width (default 100)',
		'  --local-extra-h N   total extra Local height (default 100)',
		'  --local-out N       Local output box',
		'  --fw N --fm N --ft N   forensic source spans',
		'  --forensic-out N    forensic tile output size',
		'  --no-grid           suppress coordinate grid on non-forensic views',
		'',
		'For persistent investigation and overlays: lab search --help',
		'For spatial navigation: lab traverse --help',
		'For the clickable local workbench: lab ui',
		'Scope does not execute detector plans; Sweep remains the only algorithm executor.'
	].join('\n'));
	process.exit(exitCode);
}

function parsePoint(text: string): PointTuple {
	const parts = text.split(',').map(Number);
	if (parts.length !== 2 || parts.some((value) => !Number.isFinite(value))) throw new Error(`lab scope: expected x,y, got '${text}'.`);
	return [parts[0], parts[1]];
}

function parsePointOrBox(text: string): { point?: PointTuple; box?: BoxTuple } {
	const parts = text.split(',').map(Number);
	if (parts.some((value) => !Number.isFinite(value))) throw new Error(`lab scope: invalid coordinate '${text}'.`);
	if (parts.length === 2) return { point: [parts[0], parts[1]] };
	if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) return { box: [parts[0], parts[1], parts[2], parts[3]] };
	throw new Error(`lab scope: expected x,y or x,y,w,h, got '${text}'.`);
}

function option(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	if (index < 0) return undefined;
	if (index + 1 >= args.length) throw new Error(`lab scope: ${name} needs a value.`);
	const value = args[index + 1];
	args.splice(index, 2);
	return value;
}

async function renderOne(
	imagePath: string,
	annotationPath: string | undefined,
	request: ScopeRequest,
	outputPath?: string,
	outDir = DEFAULT_SCOPE_OUT
): Promise<string> {
	const result = await runScopeOperation({ imagePath, annotationPath, request, outputPath, outDir });
	console.log(`${result.meta.mode} · ${result.resolvedRequest.name} -> ${result.outputPath}`);
	console.log(`  canonical: ${result.report.widthPx}x${result.report.heightPx} · StripChrome=${result.report.stripChrome.source} · AutoStitch=${result.report.autoStitch.sourceCount}`);
	return result.outputPath;
}

async function runManifest(manifestPath: string, caseName?: string, outDir?: string): Promise<string[]> {
	const loaded = loadScopeManifest(manifestPath);
	const selected = caseName ? loaded.cases.filter((entry) => entry.name === caseName) : loaded.cases;
	if (selected.length === 0) throw new Error(`lab scope: manifest has no case '${caseName}'.`);
	const outputs: string[] = [];
	for (const rawCase of selected) {
		const entry = resolveManifestCasePaths(loaded.dir, rawCase);
		console.log(`\n=== scope case ${entry.name} · ${entry.annotation ? 'TRUTH AVAILABLE' : 'BLIND'} ===`);
		for (let index = 0; index < entry.scopes.length; index++) {
			const request = entry.scopes[index];
			const caseOut = resolve(outDir ?? DEFAULT_SCOPE_OUT, scopeSlug(entry.name));
			outputs.push(await renderOne(entry.image, entry.annotation, { ...request, name: request.name ?? `scope-${index + 1}`, color: request.color ?? index }, undefined, caseOut));
		}
	}
	return outputs;
}

async function main(): Promise<void> {
	const raw = process.argv.slice(2);
	const args = raw[0] === 'scope' ? raw.slice(1) : raw;
	if (!args.length || args.includes('--help') || args.includes('-h')) usage(0);
	if (args[0] === 'templates') {
		for (const template of Object.values(SCOPE_TEMPLATES)) console.log(`${template.id}\t${template.description}`);
		return;
	}
	if (args[0] === 'full') {
		const image = args[1];
		const rest = args.slice(2);
		if (!image) usage(2);
		const out = option(rest, '--out');
		const view = consumeViewOptions(rest);
		if (rest.length) throw new Error(`lab scope: unexpected args: ${rest.join(' ')}`);
		await renderOne(image, undefined, { name: 'full', full: true, view }, out);
		return;
	}
	if (args[0] === '--manifest') {
		const manifest = args[1];
		if (!manifest) usage(2);
		const rest = args.slice(2);
		const caseName = option(rest, '--case');
		const outDir = option(rest, '--out-dir');
		if (rest.length) throw new Error(`lab scope: unexpected args: ${rest.join(' ')}`);
		await runManifest(manifest, caseName, outDir);
		return;
	}
	if (args[0] === 'contact-sheet') {
		const manifest = args[1];
		if (!manifest) usage(2);
		const rest = args.slice(2);
		const caseName = option(rest, '--case');
		const out = option(rest, '--out');
		if (rest.length) throw new Error(`lab scope: unexpected args: ${rest.join(' ')}`);
		const outputs = await runManifest(manifest, caseName);
		const output = resolve(out ?? resolve(DEFAULT_SCOPE_OUT, `contact-sheet-${scopeSlug(caseName ?? basename(manifest, extname(manifest)))}.png`));
		makeContactSheet(outputs, output);
		console.log(`contact-sheet -> ${output}`);
		return;
	}
	if (args[0] === '--hole') {
		const hole = Number(args[1]);
		const image = args[2];
		const annotation = args[3];
		const rest = args.slice(4);
		if (!Number.isInteger(hole) || hole <= 0 || !image || !annotation) usage(2);
		const out = option(rest, '--out');
		const view = consumeViewOptions(rest);
		if (rest.length) throw new Error(`lab scope: unexpected args: ${rest.join(' ')}`);
		await renderOne(image, annotation, { name: `hole-${hole}`, hole, view }, out);
		return;
	}
	if (args[0] === 'mark' || args[0] === 'dots' || args[0] === 'path') {
		const kind = args[0];
		const image = args[1];
		const name = args[2];
		const rest = args.slice(3);
		if (!image || !name) usage(2);
		const out = option(rest, '--out');
		const colorText = option(rest, '--color');
		const color = colorText === undefined ? 0 : Number(colorText);
		const view = consumeViewOptions(rest);
		const points = rest.map(parsePoint);
		if (!Number.isFinite(color)) throw new Error('lab scope: --color must be numeric.');
		if (kind === 'mark' && points.length !== 1) throw new Error('lab scope: mark requires exactly one x,y point.');
		if (kind === 'dots' && points.length < 2) throw new Error('lab scope: dots requires at least two points.');
		if (kind === 'path' && points.length < 1) throw new Error('lab scope: path requires at least one point.');
		const request: ScopeRequest = kind === 'mark'
			? { name, mark: points[0], color, view }
			: kind === 'dots'
				? { name, dots: points, color, view }
				: { name, path: points, color, view };
		await renderOne(image, undefined, request, out);
		return;
	}
	const image = args[0];
	const coordinate = args[1];
	const rest = args.slice(2);
	if (!image || !coordinate) usage(2);
	const name = option(rest, '--name');
	const out = option(rest, '--out');
	const template = option(rest, '--template');
	const view = consumeViewOptions(rest);
	if (rest.length) throw new Error(`lab scope: unexpected args: ${rest.join(' ')}`);
	await renderOne(image, undefined, { name, template, view, ...parsePointOrBox(coordinate) }, out);
}

main().catch((error) => {
	console.error((error as Error).message);
	process.exit(1);
});
