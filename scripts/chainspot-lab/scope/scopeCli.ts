import { basename, extname, resolve } from 'node:path';
import {
	DEFAULT_CORPUS_ROOT,
	appendLabCommand,
	guardTruthTaint,
	loadLabConfig,
	resolveCourseContext,
	resolveCourseManifest
} from '../context/context.mjs';
import { loadScopeManifest, resolveManifestCasePaths } from './manifest';
import { makeContactSheet } from './render';
import { DEFAULT_SCOPE_OUT, loadScopeInput, runScopeOperation, scopeSlug } from './operation';
import { SCOPE_TEMPLATES } from './templates';
import { consumeViewOptions } from './viewOptions';
import { deriveHoleSourceBox, readDigitViewports } from './digitViewport';
import type { BoxTuple, PointTuple, ScopeRequest } from './types';

function usage(exitCode = 0): never {
	console.error([
		'SCOPE — inspect Sweep-canonical visual evidence',
		'',
		'Configured course shortcut:',
		'  lab scope hN [--truth] [view flags]',
		'    hN       uses the selected course manifest viewport when one exists; otherwise derives a',
		'             truth-free viewport from the detector\'s own G1 badge digits (runs the badge stage)',
		'    --truth  explicitly uses Annotation geometry; logs TRUTH-TAINT and is forbidden in blind/test runs',
		'    select a course first with: lab set DT',
		'  lab scope holes',
		'    lists every hole the G1 digits can read on the selected course (truth-free), with centers + confidence',
		'',
		'Raster contract:',
		'  raw capture(s) -> Sweep StripChrome -> Sweep AutoStitch -> canonical raster -> Scope AutoCrop',
		'  `scope full` shows the entire canonical raster AFTER StripChrome/AutoStitch and BEFORE Scope AutoCrop.',
		'',
		'Usage:',
		'  lab scope hN [--truth] [view flags]',
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

function flag(args: string[], name: string): boolean {
	const index = args.indexOf(name);
	if (index < 0) return false;
	args.splice(index, 1);
	return true;
}

function canonicalBoxFromSourceBox(sourceBox: BoxTuple, offset: { xPx: number; yPx: number }, width: number, height: number): BoxTuple {
	const sourceX1 = sourceBox[0] + offset.xPx;
	const sourceY1 = sourceBox[1] + offset.yPx;
	const sourceX2 = sourceBox[0] + sourceBox[2] + offset.xPx;
	const sourceY2 = sourceBox[1] + sourceBox[3] + offset.yPx;
	const x1 = Math.max(0, sourceX1);
	const y1 = Math.max(0, sourceY1);
	const x2 = Math.min(width, sourceX2);
	const y2 = Math.min(height, sourceY2);
	if (!(x2 > x1 && y2 > y1)) throw new Error('lab scope: configured source viewport is fully outside the sanitized canonical raster.');
	return [x1, y1, x2 - x1, y2 - y1];
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

	interface ScopeCourse {
		readonly manifest: ReturnType<typeof resolveCourseManifest>;
		readonly imagePath: string;
	}

	/** One configured-hole render: manifest viewport when the course has one,
	 * digit-derived truth-free viewport otherwise. The render name carries the
	 * course so no contact sheet is ever ambiguous about what it shows. */
	async function scopeConfiguredHole(
		course: ScopeCourse,
		hole: number,
		view: ReturnType<typeof consumeViewOptions>,
		out: string | undefined,
		commandArgv: readonly string[]
	): Promise<void> {
		const loaded = await loadScopeInput(course.imagePath);
		if (loaded.decoded.report.autoStitch.sourceCount !== 1) {
			throw new Error('lab scope: source-frame hole viewports currently require a single-source course raster.');
		}
		const offset = loaded.decoded.report.singleSourceOffset ?? { xPx: 0, yPx: 0 };
		const renderName = `${course.manifest.course}-h${hole}`;
		let sourceViewport = course.manifest.holes?.[String(hole)]?.sourceBox as BoxTuple | undefined;
		if (sourceViewport) {
			const viewport = canonicalBoxFromSourceBox(sourceViewport, offset, loaded.decoded.image.width, loaded.decoded.image.height);
			appendLabCommand({ argv: [...commandArgv], taints: [], sourceBox: sourceViewport, canonicalBox: viewport });
			console.log(`MANIFEST VIEWPORT · ${course.manifest.course} · H${hole}`);
			await renderOne(course.imagePath, undefined, { name: renderName, box: viewport, view }, out);
			return;
		}
		// No manifest viewport: derive one from the detector's own G1 badge
		// digits. Truth-free by construction — the same digits a blind run
		// reads; Annotation truth is never consulted on this path.
		const readings = readDigitViewports(loaded.decoded.image);
		const originalDims = {
			width: loaded.decoded.image.width - offset.xPx,
			height: loaded.decoded.image.height - offset.yPx
		};
		const derived = deriveHoleSourceBox(readings, hole, originalDims, offset);
		sourceViewport = derived.sourceBox;
		const viewport = canonicalBoxFromSourceBox(sourceViewport, offset, loaded.decoded.image.width, loaded.decoded.image.height);
		appendLabCommand({ argv: [...commandArgv], taints: [], sourceBox: sourceViewport, canonicalBox: viewport });
		console.log(`DIGIT-DERIVED VIEWPORT (truth-free) · ${course.manifest.course} · H${hole}`);
		console.log(
			`  badge ${derived.reading.detId} read label ${derived.reading.label} at confidence ${derived.reading.confidence.toFixed(3)} ` +
				`(provenance: G1 badge stage + digit reading on the canonical raster; no Annotation truth consulted)`
		);
		console.log(
			`  center canonical (${Math.round(derived.reading.cxPx)},${Math.round(derived.reading.cyPx)}); ` +
				`box is badge-centered, ${sourceViewport[2]}x${sourceViewport[3]} (manifest-shaped default, not detector geometry)`
		);
		for (const warning of derived.warnings) console.log(`  WARNING: ${warning}`);
		await renderOne(course.imagePath, undefined, { name: renderName, box: viewport, view }, out);
	}

	const configuredHole = /^h(\d+)$/i.exec(args[0]);
	if (configuredHole) {
		const hole = Number(configuredHole[1]);
		const rest = args.slice(1);
		const truth = flag(rest, '--truth');
		const out = option(rest, '--out');
		const view = consumeViewOptions(rest);
		if (rest.length) throw new Error(`lab scope: unexpected args: ${rest.join(' ')}`);
		const course = resolveCourseContext();
		const commandArgv = ['scope', ...args];
		if (!truth) {
			await scopeConfiguredHole(course, hole, view, out, commandArgv);
			return;
		}
		if (!course.annotationPath) throw new Error(`lab scope: ${course.manifest.course} has no Annotation truth configured.`);
		guardTruthTaint(commandArgv);
		console.log(`TRUTH-TAINT · ${course.manifest.course} · H${hole}`);
		await renderOne(
			course.imagePath,
			course.annotationPath,
			{ name: `${course.manifest.course}-h${hole}-truth`, hole, view },
			out
		);
		return;
	}

	if (args[0] === 'batch') {
		// lab scope batch [COURSE ...] hN [hN ...] — every named hole on every
		// named course (default: the selected course), manifest or digit-derived.
		const rest = args.slice(1);
		const out = option(rest, '--out');
		const view = consumeViewOptions(rest);
		const holes: number[] = [];
		const courseQueries: string[] = [];
		for (const token of rest) {
			const holeToken = /^h(\d+)$/i.exec(token);
			if (holeToken) holes.push(Number(holeToken[1]));
			else courseQueries.push(token);
		}
		if (holes.length === 0) throw new Error('lab scope batch: name at least one hole (h14 h16 ...).');
		const config = loadLabConfig();
		const corpusRoot = resolve(config.corpusRoot ?? DEFAULT_CORPUS_ROOT);
		const courses =
			courseQueries.length > 0
				? courseQueries.map((query) => {
						const manifest = resolveCourseManifest(query);
						const devDir = resolve(corpusRoot, manifest.corpusDir ?? 'dev', manifest.devDir);
						return {
							manifest,
							imagePath: resolve(devDir, manifest.image)
						};
					})
				: [resolveCourseContext()];
		const failures: string[] = [];
		let rendered = 0;
		for (const course of courses) {
			for (const hole of holes) {
				try {
					await scopeConfiguredHole(course, hole, view, out, [
						'scope',
						'batch',
						course.manifest.course,
						`h${hole}`
					]);
					rendered++;
				} catch (error) {
					const line = `${course.manifest.course} H${hole}: ${(error as Error).message}`;
					failures.push(line);
					console.log(`FAILED · ${line}`);
				}
			}
		}
		console.log(
			`\nSCOPE BATCH — ${rendered} rendered, ${failures.length} failed of ${courses.length * holes.length} requested`
		);
		for (const line of failures) console.log(`  failed: ${line}`);
		if (failures.length > 0) process.exitCode = 1;
		return;
	}

	if (args[0] === 'holes') {
		const rest = args.slice(1);
		const out = option(rest, '--out');
		if (rest.length) throw new Error(`lab scope: unexpected args: ${rest.join(' ')}`);
		void out;
		const course = resolveCourseContext();
		const loaded = await loadScopeInput(course.imagePath);
		if (loaded.decoded.report.autoStitch.sourceCount !== 1) {
			throw new Error('lab scope: digit-derived hole listing currently requires a single-source course raster.');
		}
		const offset = loaded.decoded.report.singleSourceOffset ?? { xPx: 0, yPx: 0 };
		const readings = readDigitViewports(loaded.decoded.image);
		appendLabCommand({ argv: ['scope', ...args], taints: [] });
		console.log(`DIGIT-DERIVED HOLE LISTING (truth-free) · ${course.manifest.course}`);
		console.log(
			'provenance: G1 badge stage + digit reading on the canonical raster; no Annotation truth consulted'
		);
		console.log('hole | badge | confidence | canonical center | original center | manifest viewport?');
		const sorted = [...readings].sort((a, b) => {
			const holeA = a.label === null ? Number.POSITIVE_INFINITY : Number(a.label);
			const holeB = b.label === null ? Number.POSITIVE_INFINITY : Number(b.label);
			return holeA - holeB || a.cyPx - b.cyPx;
		});
		for (const reading of sorted) {
			const manifestBox = reading.label ? course.manifest.holes?.[reading.label] : undefined;
			const ambiguous =
				reading.runnerUp && reading.confidence - reading.runnerUp.confidence < 0.1
					? `  AMBIGUOUS vs ${reading.runnerUp.label}@${reading.runnerUp.confidence.toFixed(3)}`
					: '';
			console.log(
				`${reading.label ?? 'UNREAD'} | ${reading.detId} | ${reading.confidence.toFixed(3)} | ` +
					`(${Math.round(reading.cxPx)},${Math.round(reading.cyPx)}) | ` +
					`(${Math.round(reading.cxPx - offset.xPx)},${Math.round(reading.cyPx - offset.yPx)}) | ` +
					`${manifestBox ? 'manifest' : 'digit-derived'}${ambiguous}`
			);
		}
		const seen = new Map<string, number>();
		for (const reading of readings) {
			if (reading.label) seen.set(reading.label, (seen.get(reading.label) ?? 0) + 1);
		}
		const duplicates = [...seen].filter(([, count]) => count > 1);
		for (const [label, count] of duplicates) {
			console.log(`WARNING: label ${label} was read on ${count} badges`);
		}
		const unread = readings.filter((reading) => reading.label === null).length;
		if (unread > 0) console.log(`WARNING: ${unread} badge(s) with unreadable digits (listed as UNREAD)`);
		return;
	}

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
