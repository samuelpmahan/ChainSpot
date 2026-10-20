/**
 * Headless fit-and-project: point pairs + a basemap + a course-geometry file -> every hole on the basemap.
 *
 *   npx tsx scripts/geo/fit-and-project.ts --geometry <course-geometry.json> --basemap <image> --out <dir>
 *       [--pairs <alignment-pairs.json>] [--frame <hole number>[,<n>...]|all] [--course <name>] [--rc1-px <px> --rc1-note <text>]
 *
 * With --pairs (format `chainspot.alignment-pairs`, see src/lib/geo/alignmentPairs.ts) the screenshot-to-basemap
 * transform is fitted by the app's own estimators and every pair's residual is reported in px of the basemap and,
 * when the basemap has a ground scale (a NAIP export), in metres.
 * Ground scale, first that exists: the basemap's own (NAIP); else the course-geometry file's `scale` (the C1 putting
 * circle is 10 m in radius: 10 m = rC1 px of the screenshot), carried through the fit; else --rc1-px for a file that
 * predates `scale`. With none, lengths stay in px, labelled as px of the basemap.
 * Without --pairs the basemap must BE the screenshot the geometry was read from (its sha256 is checked against
 * `source.sha256`), and the transform is the identity: the "until NAIP" mode.
 *
 * Writes to <out>: fit.json (transform, residuals with units and referents, warnings, per-hole lengths),
 * overview.svg (every hole labelled, pairs and residual vectors, legend), and frame-hole-NN.svg (16:9 1920 x 1080
 * broadcast frames, src/lib/graphics/frame.ts) for --frame. The SVGs embed the basemap as a data URI, so they are
 * self-contained; any SVG rasterizer turns them into PNGs. Data conditions (too few pairs, no ground scale) are
 * recorded in fit.json, not thrown; a hash mismatch (wrong image) stops the run.
 */
import { IntegrityError, fitAndProject } from './fitProject';

function arg(name: string): string | null {
	const index = process.argv.indexOf(name);
	return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

const geometryPath = arg('--geometry');
const basemapPath = arg('--basemap');
const outDir = arg('--out');
const frameArg = arg('--frame');
if (!geometryPath || !basemapPath || !outDir) {
	console.error(
		'usage: tsx scripts/geo/fit-and-project.ts --geometry <course-geometry.json> --basemap <image> --out <dir> [--pairs <pairs.json>] [--frame <n>[,<n>]|all] [--course <name>] [--rc1-px <px>]'
	);
	process.exit(2);
}

try {
	const result = fitAndProject({
		geometryPath,
		basemapPath,
		outDir,
		pairsPath: arg('--pairs') ?? undefined,
		frames: frameArg === null ? undefined : frameArg === 'all' ? 'all' : frameArg.split(',').map(Number),
		courseName: arg('--course') ?? undefined,
		rc1Px: arg('--rc1-px') ? Number(arg('--rc1-px')) : undefined,
		rc1Note: arg('--rc1-note') ?? undefined
	});
	console.log(JSON.stringify({ out: result.outDir, holes: result.plans.length, frames: result.frameFiles.length, summary: result.summary }, null, 1));
} catch (error) {
	if (error instanceof IntegrityError) {
		console.error(error.message);
		process.exit(1);
	}
	throw error;
}
