/**
 * Corpus fetch + gate: fetches the 4 in-scope `chainspot-corpus` course
 * fixtures (LFS images + annotation truths) with sha256 verification, then
 * runs the EXISTING `scripts/toph-tune.ts` sweep against them and reports
 * whether the "default" (production-active) config clears the P1
 * tees/baskets/FP acceptance bar. This is a *detection/localization recall*
 * gate, not an association/assignment gate -- see `toph-corpus-gate.md` for
 * why those are two different numbers and must never be merged into one.
 *
 * Zero local checkout of chainspot-corpus is required: images are
 * LFS-tracked, so the plain `raw.githubusercontent.com` URL returns a small
 * pointer stub (not the real bytes); the real bytes come from
 * `media.githubusercontent.com` and are sha256-verified against the
 * pointer's `oid` before use. Annotation JSON is NOT LFS-tracked and is
 * fetched directly. AlexClark is deliberately excluded (see
 * .task/CHSPT-70.md "Known context" -- out of scope for this port).
 *
 * Fetched files are cached under --cache-dir (default `.corpus-cache/` at
 * the repo root, git-ignored) so repeat runs skip the network fetch of any
 * file whose on-disk sha256 already matches the corpus's current LFS
 * pointer oid (images) or that already parses as JSON (annotations). A
 * cached file that fails that check is NOT used silently -- it is treated
 * as a cache miss and re-fetched+re-verified.
 *
 * Usage:
 *   npx tsx scripts/toph-corpus-gate.ts [--cache-dir <dir>] [--with-association]
 *
 * Exit code is non-zero if the toph-tune.ts "default" row falls below the
 * acceptance bar (tees <58/72, baskets <67/72, or FP >3) or if DashsTrack
 * is not exactly t18/18 b18/18 +0 -- so this doubles as a CI-less
 * regression gate, not just a printout. With --with-association, a SEPARATE
 * DashsTrack-only hole-matched association check (via pancake-harness.ts)
 * also gates the exit code; see the README for why that check cannot be
 * extended to Heritage/Lenard/TowneLake yet.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS_RAW_BASE = 'https://raw.githubusercontent.com/samuelpmahan/chainspot-corpus/main';
const CORPUS_MEDIA_BASE = 'https://media.githubusercontent.com/media/samuelpmahan/chainspot-corpus/main';
const ASSOCIATION_TOLERANCE_PX = 26;

// The 4 in-scope courses. AlexClark is deliberately excluded -- do not add
// it here (see .task/CHSPT-70.md). `dir` is the corpus repo's course
// subdirectory name under dev/Annotated/; `image`/`truth` are the filenames
// inside it. Order matches scripts/toph-tune.ts's own COURSES array, which
// is asserted (not just assumed) when parsing its output below.
const COURSES = [
	{ name: 'DashsTrack', dir: 'DashsTrack', image: 'DashsTrack-full.jpg', truth: 'DashsTrack-full.annotation.json' },
	{ name: 'Heritage', dir: 'Heritage', image: 'HeritagePark-full.png', truth: 'HeritagePark-full.annotation.json' },
	{ name: 'Lenard', dir: 'Lenard', image: 'Lenard-full.PNG', truth: 'Lenard-full.annotation.json' },
	{ name: 'TowneLake', dir: 'TowneLake', image: 'TowneLake-full.png', truth: 'TowneLake-full.annotation.json' }
] as const;

interface ParsedArgs {
	cacheDir: string;
	withAssociation: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
	let cacheDir = join(REPO_ROOT, '.corpus-cache');
	let withAssociation = false;
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === '--cache-dir') {
			const next = argv[i + 1];
			if (!next) throw new Error('corpus-gate: --cache-dir needs a value');
			cacheDir = resolve(next);
			i += 1;
		} else if (arg.startsWith('--cache-dir=')) {
			cacheDir = resolve(arg.slice('--cache-dir='.length));
		} else if (arg === '--with-association') {
			withAssociation = true;
		} else if (arg === '--help' || arg === '-h') {
			console.log(
				'Usage: npx tsx scripts/toph-corpus-gate.ts [--cache-dir <dir>] [--with-association]'
			);
			process.exit(0);
		} else {
			throw new Error(`corpus-gate: unrecognized argument "${arg}"`);
		}
	}
	return { cacheDir, withAssociation };
}

function sha256Hex(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex');
}

interface LfsPointer {
	oid: string;
	size: number;
}

/**
 * Parses a Git LFS pointer stub, e.g.:
 *   version https://git-lfs.github.com/spec/v1
 *   oid sha256:<64 hex chars>
 *   size <bytes>
 * Hard-fails if the text doesn't look like a pointer -- a wrong path or a
 * corpus repo change that de-LFS'd the file would otherwise silently pass
 * garbage through as an "oid".
 */
function parseLfsPointer(text: string, sourcePath: string): LfsPointer {
	if (!/^version https:\/\/git-lfs\.github\.com\/spec\/v1/m.test(text)) {
		throw new Error(
			`corpus-gate: ${sourcePath} did not return a Git LFS pointer stub (got: ${text.slice(0, 120)}${text.length > 120 ? '...' : ''})`
		);
	}
	const oidMatch = text.match(/^oid sha256:([0-9a-f]{64})$/m);
	if (!oidMatch) throw new Error(`corpus-gate: ${sourcePath} pointer stub has no "oid sha256:" line`);
	const sizeMatch = text.match(/^size (\d+)$/m);
	return { oid: oidMatch[1], size: sizeMatch ? Number(sizeMatch[1]) : -1 };
}

async function fetchText(url: string): Promise<string> {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`corpus-gate: GET ${url} -> ${res.status} ${res.statusText}`);
	return res.text();
}

async function fetchBytes(url: string): Promise<Uint8Array> {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`corpus-gate: GET ${url} -> ${res.status} ${res.statusText}`);
	return new Uint8Array(await res.arrayBuffer());
}

interface FetchOutcome {
	path: string;
	cacheHit: boolean;
}

/**
 * Fetches + sha256-verifies one LFS-tracked course image, caching it at
 * <cacheDir>/dev/Annotated/<dir>/<image> (mirroring the corpus repo's own
 * layout). The LFS pointer is re-fetched every run (cheap, small text) to
 * learn the current expected oid; the large media fetch is skipped whenever
 * a cached file's sha256 already matches it.
 */
async function ensureImage(course: (typeof COURSES)[number], cacheDir: string): Promise<FetchOutcome> {
	const relPath = `dev/Annotated/${course.dir}/${course.image}`;
	const destPath = join(cacheDir, relPath);
	const pointer = parseLfsPointer(await fetchText(`${CORPUS_RAW_BASE}/${relPath}`), relPath);

	if (existsSync(destPath)) {
		const cachedSha = sha256Hex(readFileSync(destPath));
		if (cachedSha === pointer.oid) return { path: destPath, cacheHit: true };
		console.log(`  [cache stale] ${relPath}: on-disk sha256 ${cachedSha} != current LFS oid ${pointer.oid}, re-fetching`);
	}

	const bytes = await fetchBytes(`${CORPUS_MEDIA_BASE}/${relPath}`);
	if (pointer.size >= 0 && bytes.length !== pointer.size) {
		throw new Error(
			`corpus-gate: ${relPath} downloaded ${bytes.length} bytes but the LFS pointer declares size ${pointer.size} -- truncated/corrupted download, not using it`
		);
	}
	const actualSha = sha256Hex(bytes);
	if (actualSha !== pointer.oid) {
		throw new Error(
			`corpus-gate: sha256 mismatch for ${relPath}: downloaded bytes hash to ${actualSha}, LFS pointer oid is ${pointer.oid} -- not using it`
		);
	}
	mkdirSync(dirname(destPath), { recursive: true });
	writeFileSync(destPath, bytes);
	return { path: destPath, cacheHit: false };
}

/**
 * Fetches (or reuses) one plain-JSON annotation truth file -- not
 * LFS-tracked, so there is no oid to verify against; a cached copy is
 * reused only if it still parses as JSON (a truncated/corrupted cache file
 * fails that and is re-fetched, not used silently).
 */
async function ensureAnnotation(course: (typeof COURSES)[number], cacheDir: string): Promise<FetchOutcome> {
	const relPath = `dev/Annotated/${course.dir}/${course.truth}`;
	const destPath = join(cacheDir, relPath);

	if (existsSync(destPath)) {
		try {
			JSON.parse(readFileSync(destPath, 'utf8'));
			return { path: destPath, cacheHit: true };
		} catch {
			console.log(`  [cache stale] ${relPath}: cached file is not valid JSON, re-fetching`);
		}
	}

	const text = await fetchText(`${CORPUS_RAW_BASE}/${relPath}`);
	try {
		JSON.parse(text);
	} catch (error) {
		throw new Error(`corpus-gate: ${relPath} did not return valid JSON: ${(error as Error).message}`);
	}
	mkdirSync(dirname(destPath), { recursive: true });
	writeFileSync(destPath, text);
	return { path: destPath, cacheHit: false };
}

interface DetectionTotals {
	teeD: number;
	teeT: number;
	basketD: number;
	basketT: number;
	fp: number;
}

/**
 * Parses the "default" row printed by scripts/toph-tune.ts (unmodified --
 * this script never reimplements its scoring, only reads its printed
 * table) into the corpus-wide totals and the DashsTrack-only cell. Asserts
 * the header lists DashsTrack first so a future reordering of
 * toph-tune.ts's own COURSES array fails loudly here instead of silently
 * mis-attributing a different course's numbers to DashsTrack.
 */
function parseDetectionTable(stdout: string): { totals: DetectionTotals; dashsTrack: DetectionTotals } {
	const lines = stdout.split('\n');
	const headerLine = lines.find((l) => l.startsWith('config'));
	if (!headerLine || !/^config\s+DashsTrack\b/.test(headerLine)) {
		throw new Error(
			'corpus-gate: toph-tune.ts header did not list DashsTrack as the first course column -- ' +
				'course order changed upstream, refusing to guess which cell is DashsTrack'
		);
	}
	const defaultLine = lines.find((l) => l.trim().startsWith('default'));
	if (!defaultLine) throw new Error('corpus-gate: could not find the "default" row in toph-tune.ts output');

	const cellRe = /t(\d+)\/(\d+)\s+b(\d+)\/(\d+)\s+\+(\d+)/g;
	const cells = [...defaultLine.matchAll(cellRe)];
	if (cells.length === 0) throw new Error(`corpus-gate: could not parse per-course cells from: ${defaultLine}`);
	const dash = cells[0];
	const dashsTrack: DetectionTotals = {
		teeD: Number(dash[1]),
		teeT: Number(dash[2]),
		basketD: Number(dash[3]),
		basketT: Number(dash[4]),
		fp: Number(dash[5])
	};

	const totalsMatch = defaultLine.match(/(\d+)\/(\d+),\s*(\d+)\/(\d+),\s*\+(\d+)\s*$/);
	if (!totalsMatch) throw new Error(`corpus-gate: could not parse totals from: ${defaultLine}`);
	const totals: DetectionTotals = {
		teeD: Number(totalsMatch[1]),
		teeT: Number(totalsMatch[2]),
		basketD: Number(totalsMatch[3]),
		basketT: Number(totalsMatch[4]),
		fp: Number(totalsMatch[5])
	};

	return { totals, dashsTrack };
}

interface AssociationHoleProposal {
	number: number;
	tee?: { xPx: number; yPx: number };
	basket?: { xPx: number; yPx: number };
}
interface PancakeHarnessResult {
	wallMs: number;
	course: { grammar: { holes: AssociationHoleProposal[] } };
}

/**
 * Opt-in, SEPARATE check from the detection table above: runs the real
 * P1-P6 pipeline (scripts/pancake-harness.ts) on the cached DashsTrack
 * image and compares its hole-numbered proposals against DashsTrack's own
 * annotation truth, matched by hole `number` (not "some object somewhere"
 * -- see the README). DashsTrack-only because pancake-harness.ts doesn't
 * reproduce ChainSpot's intake autocrop the way toph-run.ts/toph-tune.ts
 * do; feeding it Heritage/Lenard/TowneLake's raw images produces large
 * frame-offset errors that are a tooling gap, not a detection/association
 * failure (see .task/CHSPT-70.md "Detection vs. association").
 */
function runDashsTrackAssociationCheck(imagePath: string, truthPath: string): boolean {
	const harness = spawnSync('npx', ['tsx', 'scripts/pancake-harness.ts', imagePath, REPO_ROOT], {
		cwd: REPO_ROOT,
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024
	});
	if (harness.error) throw harness.error;
	if (harness.stderr) process.stderr.write(harness.stderr);
	if (harness.status !== 0) {
		console.error(`corpus-gate: pancake-harness.ts exited ${harness.status}`);
		return false;
	}

	let parsed: PancakeHarnessResult;
	try {
		parsed = JSON.parse(harness.stdout);
	} catch (error) {
		throw new Error(`corpus-gate: could not parse pancake-harness.ts stdout as JSON: ${(error as Error).message}`);
	}

	const truthDoc = JSON.parse(readFileSync(truthPath, 'utf8')) as {
		holes?: { number: number; tee?: { xPx: number; yPx: number }; basket?: { xPx: number; yPx: number } }[];
	};

	let teeOk = 0;
	let teeTotal = 0;
	let basketOk = 0;
	let basketTotal = 0;
	const misses: string[] = [];
	for (const hole of truthDoc.holes ?? []) {
		const proposal = parsed.course.grammar.holes.find((h) => h.number === hole.number);
		if (hole.tee) {
			teeTotal += 1;
			const d = proposal?.tee
				? Math.hypot(proposal.tee.xPx - hole.tee.xPx, proposal.tee.yPx - hole.tee.yPx)
				: Infinity;
			if (d <= ASSOCIATION_TOLERANCE_PX) teeOk += 1;
			else misses.push(`H${hole.number} tee ${Number.isFinite(d) ? `${d.toFixed(1)}px off` : 'unassigned'}`);
		}
		if (hole.basket) {
			basketTotal += 1;
			const d = proposal?.basket
				? Math.hypot(proposal.basket.xPx - hole.basket.xPx, proposal.basket.yPx - hole.basket.yPx)
				: Infinity;
			if (d <= ASSOCIATION_TOLERANCE_PX) basketOk += 1;
			else misses.push(`H${hole.number} basket ${Number.isFinite(d) ? `${d.toFixed(1)}px off` : 'unassigned'}`);
		}
	}

	console.log(
		`  DashsTrack association: t${teeOk}/${teeTotal} b${basketOk}/${basketTotal} within ${ASSOCIATION_TOLERANCE_PX}px` +
			` (wall ${parsed.wallMs}ms)`
	);
	for (const miss of misses) console.log(`    MISS ${miss}`);
	return teeOk === teeTotal && basketOk === basketTotal;
}

async function main() {
	const { cacheDir, withAssociation } = parseArgs(process.argv.slice(2));
	console.log(`corpus-gate: cache dir ${cacheDir}`);

	const flatImagesDir = join(cacheDir, '_images-flat');
	const annotatedDir = join(cacheDir, 'dev', 'Annotated');
	mkdirSync(flatImagesDir, { recursive: true });

	const fetchStartedAt = Date.now();
	let cacheHits = 0;
	let freshFetches = 0;
	for (const course of COURSES) {
		const img = await ensureImage(course, cacheDir);
		console.log(
			`  ${course.name.padEnd(10)} image: ${img.cacheHit ? 'cache hit (sha256 verified)' : 'fetched + sha256 verified'} -> ${img.path}`
		);
		img.cacheHit ? (cacheHits += 1) : (freshFetches += 1);
		// toph-tune.ts wants one flat directory with all 4 images by filename.
		copyFileSync(img.path, join(flatImagesDir, course.image));

		const truth = await ensureAnnotation(course, cacheDir);
		console.log(`  ${course.name.padEnd(10)} truth: ${truth.cacheHit ? 'cache hit' : 'fetched'} -> ${truth.path}`);
		truth.cacheHit ? (cacheHits += 1) : (freshFetches += 1);
	}
	const fetchMs = Date.now() - fetchStartedAt;
	console.log(
		`  fetch phase: ${cacheHits}/${cacheHits + freshFetches} cache hits, ${freshFetches} fresh fetch(es), ${fetchMs}ms`
	);

	console.log('\n--- 4-course P1 detection/localization recall table (scripts/toph-tune.ts, unmodified) ---\n');
	const tune = spawnSync('npx', ['tsx', 'scripts/toph-tune.ts', flatImagesDir, annotatedDir], {
		cwd: REPO_ROOT,
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024
	});
	if (tune.error) throw tune.error;
	process.stdout.write(tune.stdout);
	if (tune.stderr) process.stderr.write(tune.stderr);
	if (tune.status !== 0) {
		console.error(`corpus-gate: scripts/toph-tune.ts exited ${tune.status}`);
		process.exit(tune.status ?? 1);
	}

	const { totals, dashsTrack } = parseDetectionTable(tune.stdout);
	const detectionOk =
		totals.teeD >= 58 &&
		totals.basketD >= 67 &&
		totals.fp <= 3 &&
		dashsTrack.teeD === 18 &&
		dashsTrack.teeT === 18 &&
		dashsTrack.basketD === 18 &&
		dashsTrack.basketT === 18 &&
		dashsTrack.fp === 0;

	console.log('\n--- detection gate (P1 recall only -- NOT an association/assignment claim; see README) ---');
	console.log(
		`  totals:     t${totals.teeD}/${totals.teeT} b${totals.basketD}/${totals.basketT} +${totals.fp}FP` +
			` (bar: tees>=58, baskets>=67, FP<=3)`
	);
	console.log(
		`  DashsTrack: t${dashsTrack.teeD}/${dashsTrack.teeT} b${dashsTrack.basketD}/${dashsTrack.basketT} +${dashsTrack.fp}FP` +
			` (bar: exactly t18/18 b18/18 +0)`
	);
	console.log(`  detection gate: ${detectionOk ? 'PASS' : 'FAIL'}`);

	let ok = detectionOk;
	if (withAssociation) {
		console.log(
			'\n--- DashsTrack-only association check (P1-P6, hole-number matched -- SEPARATE from the table above) ---'
		);
		const associationOk = runDashsTrackAssociationCheck(
			join(flatImagesDir, 'DashsTrack-full.jpg'),
			join(annotatedDir, 'DashsTrack', 'DashsTrack-full.annotation.json')
		);
		console.log(`  association gate: ${associationOk ? 'PASS' : 'FAIL'}`);
		ok = ok && associationOk;
	}

	process.exit(ok ? 0 : 1);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
