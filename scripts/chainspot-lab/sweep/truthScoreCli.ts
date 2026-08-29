/**
 * `lab score` — the Dev6 truth scoreboard, promoted from the integration
 * night's scratchpad scorer (2026-08-29) into the CLI so the acceptance
 * number ("108 tees→badges") is one command, not a throwaway script.
 *
 * Scores each course's SHIPPED receipt (assignments + endpointPositions —
 * the exact objects the HOLE ASSIGNMENTS table names) against the corpus
 * Annotation truth. No pixels are re-detected and no positions are decoded
 * out of rendered images: if the receipt cannot answer, the receipt is the
 * bug.
 *
 * Verdict classes per truth hole:
 *   CORRECT     assigned tee within --tolerance px of the truth tee
 *   WRONG       assigned tee farther than --tolerance px (position printed)
 *   UNASSIGNED  no assignment row shipped for the hole
 *   NO TRUTH    the annotation has no such hole / no annotation file exists
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));

interface TruthHole {
	readonly number: number;
	readonly tee: { readonly xPx: number; readonly yPx: number };
}

interface ReceiptShape {
	readonly assignments?: readonly { readonly hole: string | number; readonly teeId: string }[];
	readonly endpointPositions?: {
		readonly tees: readonly { readonly id: string; readonly xPx: number; readonly yPx: number }[];
	};
}

/** Scoring allowance for annotation click placement (a human clicked "the
 * tee", not a subpixel center) — an EVALUATION constant, printed on every
 * run, never used anywhere in the detector. Override with --tolerance. */
const DEFAULT_TOLERANCE_PX = 26;

/** A truth hole whose nearest assigned tee sits beyond this many tolerances
 * is likelier to be an annotation-frame problem than a detector miss; when
 * at least half of a course's holes look like that, the whole annotation is
 * flagged FRAME SUSPECT instead of being reported as detector wrongs (the
 * AlexClark 3-hole annotation is the known case). */
const FRAME_SUSPECT_FACTOR = 10;

/** Dependency-free minimal ZIP reader (EOCD scan + central directory +
 * store/deflate entries) — enough for the corpus Annotated.zip; anything
 * unsupported fails loudly. */
function readZipEntries(zipPath: string): Map<string, Buffer> {
	const buffer = readFileSync(zipPath);
	if (buffer.subarray(0, 30).toString('utf8').startsWith('version https://git-lfs')) {
		throw new Error(
			`${zipPath} is a git-lfs POINTER, not the archive. Hydrate it first (git lfs pull, or fetch ` +
				'via media.githubusercontent.com and verify sha256 against the pointer).'
		);
	}
	let eocd = -1;
	for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 65535); i--) {
		if (buffer.readUInt32LE(i) === 0x06054b50) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) throw new Error(`${zipPath}: no ZIP end-of-central-directory record found.`);
	const entryCount = buffer.readUInt16LE(eocd + 10);
	let offset = buffer.readUInt32LE(eocd + 16);
	const entries = new Map<string, Buffer>();
	for (let i = 0; i < entryCount; i++) {
		if (buffer.readUInt32LE(offset) !== 0x02014b50) {
			throw new Error(`${zipPath}: central directory entry ${i} has a bad signature.`);
		}
		const method = buffer.readUInt16LE(offset + 10);
		const compressedSize = buffer.readUInt32LE(offset + 20);
		const nameLength = buffer.readUInt16LE(offset + 28);
		const extraLength = buffer.readUInt16LE(offset + 30);
		const commentLength = buffer.readUInt16LE(offset + 32);
		const localOffset = buffer.readUInt32LE(offset + 42);
		const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
		const localNameLength = buffer.readUInt16LE(localOffset + 26);
		const localExtraLength = buffer.readUInt16LE(localOffset + 28);
		const dataStart = localOffset + 30 + localNameLength + localExtraLength;
		const raw = buffer.subarray(dataStart, dataStart + compressedSize);
		if (!name.endsWith('/')) {
			if (method === 0) entries.set(name, Buffer.from(raw));
			else if (method === 8) entries.set(name, inflateRawSync(raw));
			else throw new Error(`${zipPath}: entry '${name}' uses unsupported compression method ${method}.`);
		}
		offset += 46 + nameLength + extraLength + commentLength;
	}
	return entries;
}

/** All `*-full.annotation.json` files reachable from the annotations source
 * (an extracted directory or the corpus zip), keyed by case name
 * (e.g. 'HeritagePark-full'). */
function loadAnnotations(source: string): Map<string, { holes: readonly TruthHole[] }> {
	const annotations = new Map<string, { holes: readonly TruthHole[] }>();
	const put = (path: string, text: string) => {
		const base = path.split('/').pop() ?? path;
		const caseName = base.replace(/\.annotation\.json$/, '');
		annotations.set(caseName, JSON.parse(text));
	};
	if (source.endsWith('.zip')) {
		for (const [name, data] of readZipEntries(source)) {
			if (name.endsWith('.annotation.json') && !name.includes('__MACOSX')) put(name, data.toString('utf8'));
		}
		return annotations;
	}
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (entry.name.endsWith('.annotation.json')) put(path, readFileSync(path, 'utf8'));
		}
	};
	walk(source);
	return annotations;
}

function usage(): never {
	console.log(
		[
			'Usage: lab score [CONFIG_NAME] [COURSE ...] [--tolerance N] [--annotations PATH]',
			'',
			'Scores shipped run receipts against corpus Annotation truth, per hole.',
			"CONFIG_NAME is the artifacts/sweep/<name> directory (a config's `name`);",
			'default: dev72-recovered-default. COURSE filters (default: every course',
			'with a receipt under the config). --annotations accepts an extracted',
			'directory or the Annotated.zip itself (default: the corpus checkout).'
		].join('\n')
	);
	process.exit(2);
}

function main(argv: readonly string[]): number {
	let tolerancePx = DEFAULT_TOLERANCE_PX;
	let annotationsPath: string | undefined;
	const positional: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === '--tolerance') tolerancePx = Number(argv[++i]);
		else if (arg === '--annotations') annotationsPath = argv[++i];
		else if (arg === '--help' || arg === '-h') usage();
		else positional.push(arg);
	}
	if (!Number.isFinite(tolerancePx) || tolerancePx <= 0) usage();

	const repoRoot = resolve(HERE, '../../..');
	// First positional is a config name when its artifacts directory exists;
	// otherwise every positional is a course filter on the default config.
	let configName = 'dev72-recovered-default';
	let courseArgs = positional;
	if (positional[0] && existsSync(join(repoRoot, 'artifacts/sweep', positional[0]))) {
		configName = positional[0];
		courseArgs = positional.slice(1);
	}
	const courseFilter = new Set(courseArgs);
	const sweepDir = join(repoRoot, 'artifacts/sweep', configName);
	if (!existsSync(sweepDir)) {
		console.error(
			`lab score: no artifacts at ${sweepDir} — run \`lab sweep\` for that config first ` +
				'(and note the directory is the config\'s `name` field, not its filename).'
		);
		return 2;
	}

	if (!annotationsPath) {
		const corpus = resolve(repoRoot, '../chainspot-corpus/dev');
		for (const candidate of [join(corpus, 'Annotated'), join(corpus, 'Annotated.zip')]) {
			if (existsSync(candidate)) {
				try {
					// the extracted dir can exist with only LFS-pointer images and
					// no annotation JSONs -- a source only counts if it yields some
					if (loadAnnotations(candidate).size > 0) {
						annotationsPath = candidate;
						break;
					}
				} catch {
					/* fall through to the next candidate (e.g. an LFS pointer zip) */
				}
			}
		}
	}
	if (!annotationsPath || !existsSync(annotationsPath)) {
		console.error(
			'lab score: no annotation source found (looked for ../chainspot-corpus/dev/Annotated{,.zip}); ' +
				'pass --annotations PATH.'
		);
		return 2;
	}
	const annotations = loadAnnotations(annotationsPath);

	// Receipt discovery: batch layout first, single-run layout second.
	const receipts: { course: string; path: string }[] = [];
	const batchDir = join(sweepDir, 'batches');
	if (existsSync(batchDir)) {
		for (const course of readdirSync(batchDir)) {
			const path = join(batchDir, course, 'full', 'run.receipt.json');
			if (existsSync(path)) receipts.push({ course, path });
		}
	}
	for (const entry of readdirSync(sweepDir)) {
		const path = join(sweepDir, entry, 'run.receipt.json');
		if (existsSync(path) && !receipts.some((row) => row.course === entry.replace(/-full$/, ''))) {
			receipts.push({ course: entry.replace(/-full$/, ''), path });
		}
	}
	receipts.sort((a, b) => a.course.localeCompare(b.course));

	console.log(`TRUTH SCOREBOARD — config '${configName}'`);
	console.log(
		`tolerance ${tolerancePx}px (annotation click-placement allowance; evaluation-only, ` +
			'never read by the detector) | annotations: ' + annotationsPath
	);
	console.log('');

	let totalCorrect = 0;
	let totalTruthHoles = 0;
	let framesSuspect = 0;
	for (const { course, path } of receipts) {
		if (courseFilter.size > 0 && !courseFilter.has(course)) continue;
		const receipt = JSON.parse(readFileSync(path, 'utf8')) as ReceiptShape;
		const caseName = `${course}-full`;
		const truth = annotations.get(caseName) ?? annotations.get(course);
		const assigned = receipt.assignments?.length ?? 0;
		if (!truth) {
			console.log(`${course}: ${assigned} assigned — NO TRUTH ANNOTATION (eyeball course)`);
			continue;
		}
		if (!receipt.endpointPositions) {
			console.log(
				`${course}: receipt has no endpointPositions (older receipt schema) — re-run \`lab sweep\` ` +
					'to score this course.'
			);
			continue;
		}
		const teePosition = new Map(receipt.endpointPositions.tees.map((tee) => [tee.id, tee]));
		let correct = 0;
		const wrong: string[] = [];
		const unassigned: string[] = [];
		let farMisses = 0;
		for (const hole of truth.holes as readonly TruthHole[]) {
			const row = receipt.assignments?.find((entry) => String(entry.hole) === String(hole.number));
			if (!row) {
				unassigned.push(`H${hole.number}`);
				continue;
			}
			const tee = teePosition.get(row.teeId);
			if (!tee) {
				wrong.push(`H${hole.number}: ${row.teeId} has NO POSITION in endpointPositions (receipt bug)`);
				continue;
			}
			const distance = Math.hypot(tee.xPx - hole.tee.xPx, tee.yPx - hole.tee.yPx);
			if (distance <= tolerancePx) correct++;
			else {
				if (distance > tolerancePx * FRAME_SUSPECT_FACTOR) farMisses++;
				wrong.push(
					`H${hole.number}: ${row.teeId}@(${tee.xPx.toFixed(0)},${tee.yPx.toFixed(0)}) off ` +
						`${distance.toFixed(0)}px (truth ${hole.tee.xPx.toFixed(0)},${hole.tee.yPx.toFixed(0)})`
				);
			}
		}
		const holeCount = truth.holes.length;
		const frameSuspect = holeCount > 0 && farMisses >= Math.ceil(holeCount / 2);
		if (frameSuspect) framesSuspect++;
		else {
			totalCorrect += correct;
			totalTruthHoles += holeCount;
		}
		const suffix = frameSuspect
			? `  << ANNOTATION FRAME SUSPECT: ${farMisses}/${holeCount} holes are > ${tolerancePx * FRAME_SUSPECT_FACTOR}px off — the annotation likely lives in a different frame than the canonical raster; excluded from the total`
			: '';
		console.log(`${course}: ${correct}/${holeCount} correct` +
			(unassigned.length ? ` | UNASSIGNED: ${unassigned.join(',')}` : '') + suffix);
		for (const line of wrong) console.log(`   WRONG ${line}`);
	}
	if (courseFilter.size > 0 && ![...receipts].some((row) => courseFilter.has(row.course))) {
		console.log(`(no receipts matched course filter ${[...courseFilter].join(', ')} — available: ${receipts.map((row) => row.course).join(', ')})`);
	}
	console.log('');
	console.log(
		`TOTAL: ${totalCorrect}/${totalTruthHoles} truth-correct across scoreable annotated courses` +
			(framesSuspect ? ` (${framesSuspect} course annotation(s) excluded as FRAME SUSPECT)` : '')
	);
	return totalCorrect === totalTruthHoles && totalTruthHoles > 0 ? 0 : 1;
}

process.exit(main(process.argv.slice(2)));
