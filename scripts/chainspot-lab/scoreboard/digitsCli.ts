// DIGITS — the Dev6 digit-read scoreboard, truth-free.
//
// Runs the fast public seam `detectBadges` (packages/alg/.../measure.ts) —
// G1 badge stage + digit reading only, no baskets/tees/support field/
// assignment — on the canonical raster of one course or every Dev6 course,
// and prints a per-badge receipt table with a named verdict per row. No
// Annotation truth is consulted anywhere in this file; the same digits a
// blind run would produce are the only input, exactly like
// `scope/digitViewport.ts`'s `readDigitViewports`.
//
// This is a read-only measurement instrument: it does not modify detector
// behavior and does not touch packages/alg or digits/ source.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	DEFAULT_CORPUS_ROOT,
	appendLabCommand,
	loadLabConfig,
	resolveCourseContext,
	resolveCourseManifest
} from '../context/context.mjs';
import { detectBadges } from '@chainspot/alg/detectors/threeFactor/measure';
import type { BadgeEvidence, RgbaImage } from '@chainspot/alg/detectors/threeFactor/types';
import { loadScopeInput, runScopeOperation } from '../scope/operation';
import { firstPanelCrop, makeLabeledContactSheet, type LabeledSheetEntry } from '../scope/render';
import {
	classifyBadges,
	countVerdicts,
	DEFAULT_CONFIDENCE_FLOOR,
	type BadgeReadingInput,
	type BadgeVerdict
} from './verdict';

/** Owner's Dev6 roster (docs/WORKFLOW.md standing policy, 2026-08-28):
 * DashsTrack, Lenard, TowneLake, NorthPark, HeritagePark, AlexClark. Kept as
 * an explicit list (not "every configured course") so adding a non-Dev6
 * manifest (e.g. TheREC) never silently joins the gate. */
export const DEV6_COURSES = ['DashsTrack', 'Lenard', 'TowneLake', 'NorthPark', 'HeritagePark', 'AlexClark'] as const;

/** Badge-centered crop size for `--crops`, canonical px. Not detector
 * geometry — a display constant sized to comfortably frame one badge plate
 * plus margin, the same "manifest-shaped default" role as
 * `scope/digitViewport.ts`'s `DEFAULT_DERIVED_BOX_SIZE` (420, used there for
 * a whole hole's viewport); this is smaller because a failing-badge crop
 * only needs to show the badge itself. */
const CROP_BOX_SIZE = 220;

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIGITS_OUT = resolve(HERE, '..', '..', '..', 'artifacts', 'digits');

function usage(exitCode = 0): never {
	console.error(
		[
			'DIGITS — Dev6 digit-read scoreboard (truth-free)',
			'',
			'Runs the fast public detectBadges seam (G1 badge stage + digit reading only)',
			'on the canonical raster and prints a per-badge verdict table. No Annotation',
			'truth is consulted; this is the same read a blind run would produce.',
			'',
			'Usage:',
			'  lab digits                    the currently selected course (lab set COURSE)',
			'  lab digits COURSE             one named course',
			'  lab digits all                every Dev6 course',
			'  lab digits [...] --crops      also write a labeled contact sheet of every',
			'                                FAILING badge crop, one image per course',
			'  lab digits [...] --floor N    override the advisory LOW-CONFIDENCE floor',
			'                                (default ' + DEFAULT_CONFIDENCE_FLOOR + ', see verdict.ts for provenance)',
			'  lab digits [...] --out DIR    write crop sheets under DIR (default artifacts/digits)',
			'',
			'Verdicts: OK, GARBAGE-LABEL, LOW-CONFIDENCE, COLLISION, UNREAD.',
			'Exit code is nonzero if any badge on any requested course is non-OK.'
		].join('\n')
	);
	process.exit(exitCode);
}

function option(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	if (index < 0) return undefined;
	if (index + 1 >= args.length) throw new Error(`lab digits: ${name} needs a value.`);
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

interface CourseTarget {
	readonly course: string;
	readonly imagePath: string;
}

function resolveCourseTarget(query: string): CourseTarget {
	const config = loadLabConfig();
	const manifest = resolveCourseManifest(query);
	const corpusRoot = resolve(config.corpusRoot ?? DEFAULT_CORPUS_ROOT);
	const devDir = resolve(corpusRoot, manifest.corpusDir ?? 'dev', manifest.devDir);
	return { course: manifest.course, imagePath: resolve(devDir, manifest.image) };
}

function toReading(badge: BadgeEvidence): BadgeReadingInput & { readonly cxPx: number; readonly cyPx: number; readonly bbox: BadgeEvidence['bbox'] } {
	const runnerUp = badge.labelCandidates[1];
	return {
		detId: badge.detId,
		label: badge.label,
		confidence: badge.confidence,
		cxPx: badge.cxPx,
		cyPx: badge.cyPx,
		bbox: badge.bbox,
		...(runnerUp ? { runnerUp } : {})
	};
}

function fmtRunnerUp(v: BadgeVerdict): string {
	return v.runnerUp ? `${v.runnerUp.label}@${v.runnerUp.confidence.toFixed(3)}` : '(none)';
}

function fmtVerdict(v: BadgeVerdict): string {
	if (v.verdict === 'COLLISION' && v.collisionParties?.length) {
		return `COLLISION (also ${v.collisionParties.join(', ')})`;
	}
	return v.verdict;
}

export interface CourseScoreboardResult {
	readonly course: string;
	readonly verdicts: readonly BadgeVerdict[];
	readonly failingCrops: readonly { readonly detId: string; readonly label: string | null; readonly verdict: string; readonly bbox: BadgeEvidence['bbox']; readonly cxPx: number; readonly cyPx: number }[];
}

async function runCourse(target: CourseTarget, floor: number): Promise<CourseScoreboardResult> {
	const loaded = await loadScopeInput(target.imagePath);
	const offset = loaded.decoded.report.singleSourceOffset ?? { xPx: 0, yPx: 0 };
	const multiSource = loaded.decoded.report.autoStitch.sourceCount !== 1;
	const badges = detectBadges(loaded.decoded.image);
	const readings = badges.map(toReading);
	const verdicts = classifyBadges(readings, floor);
	const byDetId = new Map(readings.map((r) => [r.detId, r]));

	console.log(`\n=== DIGITS · ${target.course} (truth-free: G1 badge stage + digit reading only) ===`);
	if (multiSource) {
		console.log('  WARNING: multi-source canonical raster; original-frame centers assume offset (0,0) and may be inexact.');
	}
	console.log('badge | read label | confidence | runner-up | center canonical | center original | verdict');
	for (const v of verdicts) {
		const reading = byDetId.get(v.detId)!;
		const canonical = `(${Math.round(reading.cxPx)},${Math.round(reading.cyPx)})`;
		const original = `(${Math.round(reading.cxPx - offset.xPx)},${Math.round(reading.cyPx - offset.yPx)})`;
		console.log(
			`${v.detId} | ${v.label ?? 'UNREAD'} | ${v.confidence.toFixed(3)} | ${fmtRunnerUp(v)} | ${canonical} | ${original} | ${fmtVerdict(v)}`
		);
	}
	const counts = countVerdicts(verdicts);
	console.log(
		`${target.course} SUMMARY — ${counts.total} badges, ${counts.ok} ok, ` +
			`${counts.garbageLabel} garbage-label, ${counts.lowConfidence} low-confidence, ` +
			`${counts.collision} collision, ${counts.unread} unread`
	);

	const failingCrops = verdicts
		.filter((v) => v.verdict !== 'OK')
		.map((v) => {
			const reading = byDetId.get(v.detId)!;
			return { detId: v.detId, label: v.label, verdict: fmtVerdict(v), bbox: reading.bbox, cxPx: reading.cxPx, cyPx: reading.cyPx };
		});
	return { course: target.course, verdicts, failingCrops };
}

async function writeCourseCropSheet(target: CourseTarget, result: CourseScoreboardResult, outDir: string): Promise<string | undefined> {
	if (result.failingCrops.length === 0) return undefined;
	const tiles: LabeledSheetEntry[] = [];
	for (const failure of result.failingCrops) {
		const half = CROP_BOX_SIZE / 2;
		const box = [
			Math.max(0, failure.cxPx - half),
			Math.max(0, failure.cyPx - half),
			CROP_BOX_SIZE,
			CROP_BOX_SIZE
		] as const;
		const name = `${target.course}-${failure.detId}`;
		const caseOut = resolve(outDir, 'renders', target.course.toLowerCase());
		const rendered = await runScopeOperation({
			imagePath: target.imagePath,
			request: { name, box, view: { grid: false } },
			outDir: caseOut
		});
		let crop: { x: number; y: number; w: number; h: number } | undefined;
		try {
			const meta = JSON.parse(readFileSync(`${rendered.outputPath}.json`, 'utf8'));
			const firstPanel = meta?.panels?.[0];
			if (firstPanel?.outputPx) crop = firstPanelCrop(firstPanel.outputPx);
		} catch {
			// No sidecar: fall back to the full sheet as the tile.
		}
		tiles.push({
			path: rendered.outputPath,
			label: `${target.course.toUpperCase()} ${failure.detId} ${failure.label ?? 'UNREAD'} · ${failure.verdict}`,
			...(crop ? { crop } : {})
		});
	}
	const sheetPath = resolve(outDir, `${target.course}-failures.png`);
	makeLabeledContactSheet(tiles, sheetPath);
	console.log(`  ${target.course} FAILURE CROP SHEET · ${tiles.length} badge(s) -> ${sheetPath}`);
	return sheetPath;
}

async function main(): Promise<void> {
	const raw = process.argv.slice(2);
	const args = raw[0] === 'digits' ? raw.slice(1) : raw;
	if (args.includes('--help') || args.includes('-h')) usage(0);

	const crops = flag(args, '--crops');
	const floorText = option(args, '--floor');
	const outText = option(args, '--out');
	const floor = floorText === undefined ? DEFAULT_CONFIDENCE_FLOOR : Number(floorText);
	if (!Number.isFinite(floor) || floor < 0 || floor > 1) throw new Error('lab digits: --floor must be a number in [0, 1].');
	const outDir = resolve(outText ?? DEFAULT_DIGITS_OUT);

	let targets: CourseTarget[];
	if (args.length === 0) {
		const selected = resolveCourseContext();
		targets = [{ course: selected.manifest.course, imagePath: selected.imagePath }];
	} else if (args.length === 1 && args[0].toLowerCase() === 'all') {
		targets = DEV6_COURSES.map((course) => resolveCourseTarget(course));
	} else if (args.length === 1) {
		targets = [resolveCourseTarget(args[0])];
	} else {
		throw new Error(`lab digits: unexpected args: ${args.join(' ')}`);
	}

	appendLabCommand({ argv: ['digits', ...raw.slice(raw[0] === 'digits' ? 1 : 0)], taints: [] });

	let anyNonOk = false;
	const cropSheets: string[] = [];
	for (const target of targets) {
		const result = await runCourse(target, floor);
		if (result.verdicts.some((v) => v.verdict !== 'OK')) anyNonOk = true;
		if (crops) {
			const sheet = await writeCourseCropSheet(target, result, outDir);
			if (sheet) cropSheets.push(sheet);
		}
	}

	if (targets.length > 1) {
		console.log(`\nDIGITS — ${targets.length} course(s) scored${anyNonOk ? ', at least one non-OK badge found' : ', all OK'}`);
	}
	if (crops) {
		console.log(cropSheets.length ? `\nCROP SHEETS:\n  ${cropSheets.join('\n  ')}` : '\nCROP SHEETS: none (no failing badges)');
	}
	if (anyNonOk) process.exitCode = 1;
}

main().catch((error) => {
	console.error((error as Error).message);
	process.exit(1);
});
