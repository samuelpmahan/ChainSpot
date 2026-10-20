/**
 * The thin slice, headless, one command: course geometry + screenshot + hand-picked pairs + the searched centre ->
 * NAIP basemap, the located (adjusted) centre, the fit, every hole projected, and broadcast frames in feet.
 *
 *   NODE_USE_ENV_PROXY=1 npx tsx scripts/geo/slice.ts --geometry <course-geometry.json> --screenshot <image>
 *       --pairs <pairs picked on a georeferenced NAIP tile> --out <dir> [--pick <that tile's dir>]
 *       [--searched <lat,lon> --search-radius <m> --wide <dir>] [--frames 1,7] [--course <name>] [--rc1-px <px>]
 *       [--margin-m 40] [--size 2048]
 *
 * Steps (each writes under <out>):
 *  1. The SEARCHED centre (--searched, default the pick tile's centre) is only approximate. wide/ is a generous tile
 *     around it (--search-radius, default the pick tile's radius; reused from --wide). The pairs were picked by eye on a
 *     georeferenced tile (the pairs file's basemap; reused from --pick, else refetched, and its sha256 must match): for
 *     Dash's Track that is the wide tile itself; for a pin far off the course it is a tile on the course once found.
 *  2. locate/ the adjustment, i.e. the app's "pan until the crosshair sits on the course, then confirm": the pairs are
 *     fitted on the pick tile, every hole is projected, and the centre of the projected course is the ADJUSTED centre.
 *     It is recorded beside the searched one with the offset in metres; locate.svg marks both on the wide tile.
 *  3. tight/  a tile refetched around the adjusted centre, radius = half the course diagonal + margin. The pairs'
 *             targets are carried from wide to tight px through both tiles' georeference (no re-picking), written as
 *             tight/pairs.json.
 *  4. fit/    fit-and-project on the tight tile (fitProject.ts): fit.json (residuals in px and m), overview.svg,
 *             frame-hole-NN.svg (feet from NAIP's measured m/px).
 *  5. slice.json: searched and adjusted centres, offset, providers, both scales (NAIP through the fit vs the
 *             screenshot's C1 circle, 10 m = rC1 px) and how far apart they are, residuals, lengths, files.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseAlignmentPairs } from '../../src/lib/geo/alignmentPairs';
import { distanceMeters, lonLatToPx, pxToLonLat } from '../../src/lib/geo/webMercator';
import type { LonLat } from '../../src/lib/geo/webMercator';
import { IntegrityError, fitAndProject, imageSize, loadGeometry, screenshotGroundScale, sha256Of } from './fitProject';
import { basemapBlock, fetchTile, readTile } from './tile';
import type { Tile } from './tile';

function arg(name: string): string | null {
	const index = process.argv.indexOf(name);
	return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

const geometryPath = arg('--geometry');
const screenshotPath = arg('--screenshot');
const pairsPath = arg('--pairs');
const out = arg('--out');
if (!geometryPath || !screenshotPath || !pairsPath || !out) {
	console.error('usage: tsx scripts/geo/slice.ts --geometry <g.json> --screenshot <img> --pairs <wide pairs.json> --out <dir> [--wide <dir>] [--frames 1,7] [--course <name>] [--rc1-px <px>] [--margin-m 40] [--size 2048]');
	process.exit(2);
}
const frames = (arg('--frames') ?? '1').split(',').map(Number);
const marginM = Number(arg('--margin-m') ?? 40);
const sizePx = Number(arg('--size') ?? 2048);
const rc1Px = arg('--rc1-px') ? Number(arg('--rc1-px')) : undefined;

function fail(message: string): never {
	console.error(message);
	process.exit(1);
}

try {
	// 0. inputs and their integrity
	const parsed = loadGeometry(geometryPath);
	const shotBytes = readFileSync(screenshotPath);
	if (sha256Of(shotBytes) !== parsed.geometry.source.sha256) {
		throw new IntegrityError(`integrity: ${screenshotPath} is not the screenshot the geometry was read from (${parsed.geometry.source.sha256})`);
	}
	const pairs = parseAlignmentPairs(readFileSync(pairsPath, 'utf8'));
	if (!pairs.ok) throw new IntegrityError(`pairs: ${pairs.error.path}: ${pairs.error.message}`);
	const pickPairs = pairs.file;
	if (!pickPairs.basemap.naip) throw new IntegrityError('pairs: basemap.naip (centre, radius and size of the tile the pairs were picked on) is required');
	const pickNaip = pickPairs.basemap.naip;
	const searchedArg = arg('--searched');
	const searched: LonLat = searchedArg ? { lat: Number(searchedArg.split(',')[0]), lon: Number(searchedArg.split(',')[1]) } : pickNaip.center;
	const searchRadius = Number(arg('--search-radius') ?? pickNaip.radiusMeters);
	const course = arg('--course') ?? pickPairs.course;
	mkdirSync(out, { recursive: true });

	// 1. the pick tile (pairs picked on its pixels) and the wide tile around the searched centre
	const pickDir = arg('--pick') ?? join(out, 'pick');
	const pick: Tile = readTile(pickDir) ?? (await fetchTile(pickNaip.center, pickNaip.radiusMeters, pickNaip.sizePx, pickDir));
	if (pickPairs.basemap.sha256 && pick.sidecar.sha256 !== pickPairs.basemap.sha256) {
		throw new IntegrityError(
			`integrity: the pick tile (${pick.sidecar.source}, sha256 ${pick.sidecar.sha256.slice(0, 12)}) is not the image the pairs were picked on (${pickPairs.basemap.sha256.slice(0, 12)}); pass --pick <that tile's dir>`
		);
	}
	const sameAsPick = !searchedArg && !arg('--search-radius') && !arg('--wide');
	const wideDir = arg('--wide') ?? join(out, 'wide');
	const wide: Tile = sameAsPick ? pick : (readTile(wideDir) ?? (await fetchTile(searched, searchRadius, Number(arg('--size') ?? 2048), wideDir)));

	// 2. locate: fit on the pick tile, centre of the projected course = the adjusted centre
	const locateDir = join(out, 'locate');
	const pickPairsPath = join(locateDir, 'pairs.pick.json');
	mkdirSync(locateDir, { recursive: true });
	writeFileSync(pickPairsPath, JSON.stringify({ ...pickPairs, basemap: { ...basemapBlock(pick), naip: pickNaip } }, null, '\t') + '\n');
	const onPick = fitAndProject({ geometryPath, basemapPath: pick.imagePath, outDir: locateDir, pairsPath: pickPairsPath, courseName: course, rc1Px });
	if (!onPick.fit.ok || onPick.fit.model === 'identity') fail(`locate: no fit on the pick tile: ${JSON.stringify(onPick.fit)}`);
	const pts = onPick.plans.flatMap((p) => [...(p.tee ? [p.tee] : []), ...(p.basket ? [p.basket] : []), ...p.bends, ...(p.corridorBand ?? [])]);
	const minX = Math.min(...pts.map((p) => p.xPx));
	const maxX = Math.max(...pts.map((p) => p.xPx));
	const minY = Math.min(...pts.map((p) => p.yPx));
	const maxY = Math.max(...pts.map((p) => p.yPx));
	const raster = pick.sidecar.raster;
	const adjusted = pxToLonLat(raster, (minX + maxX) / 2, (minY + maxY) / 2);
	const offsetM = distanceMeters(searched, adjusted);
	const eastM = distanceMeters(searched, { lat: searched.lat, lon: adjusted.lon }) * Math.sign(adjusted.lon - searched.lon);
	const northM = distanceMeters(searched, { lat: adjusted.lat, lon: searched.lon }) * Math.sign(adjusted.lat - searched.lat);
	const halfDiagonalM = (Math.hypot(maxX - minX, maxY - minY) / 2) * pick.sidecar.metersPerPixel;
	const tightRadiusM = Math.ceil((halfDiagonalM + marginM) / 10) * 10;
	// the locate picture is on the wide tile: carry the course box and both centres there through the georeference
	const toWide = (xPx: number, yPx: number) => lonLatToPx(wide.sidecar.raster, pxToLonLat(raster, xPx, yPx));
	const boxNW = toWide(minX, minY);
	const boxSE = toWide(maxX, maxY);
	writeFileSync(
		join(locateDir, 'locate.svg'),
		locateMarkup(wide, searched, adjusted, lonLatToPx(wide.sidecar.raster, searched), lonLatToPx(wide.sidecar.raster, adjusted), { minX: boxNW.xPx, minY: boxNW.yPx, maxX: boxSE.xPx, maxY: boxSE.yPx }, offsetM, course)
	);

	// 3. the tight tile around the adjusted centre; carry the pairs across through both georeferences
	const tight = await fetchTile(adjusted, tightRadiusM, sizePx, join(out, 'tight'));
	const tightPairs = {
		...pickPairs,
		basemap: basemapBlock(tight),
		pairs: pickPairs.pairs.map((pair) => ({
			...pair,
			target: pair.target ? lonLatToPx(tight.sidecar.raster, pxToLonLat(raster, pair.target.xPx, pair.target.yPx)) : null
		}))
	};
	const tightPairsPath = join(out, 'tight', 'pairs.json');
	writeFileSync(tightPairsPath, JSON.stringify(tightPairs, null, '\t') + '\n');

	// 4. fit and project on the tight tile
	const C1 = screenshotGroundScale(parsed.geometry, rc1Px);
	const fitDir = join(out, 'fit');
	const result = fitAndProject({ geometryPath, basemapPath: tight.imagePath, outDir: fitDir, pairsPath: tightPairsPath, frames, courseName: course, rc1Px });
	if (!result.fit.ok || result.fit.model === 'identity' || !('transform' in result.fit)) fail(`fit: ${JSON.stringify(result.fit)}`);
	const fit = result.fit;
	const linear = Math.sqrt(Math.abs(fit.transform.determinant));
	const naipShotMpp = linear * tight.sidecar.metersPerPixel;
	const scales = {
		naip: {
			metersPerScreenshotPx: naipShotMpp,
			from: `fit scale ${linear.toFixed(5)} NAIP px per screenshot px x ${tight.sidecar.metersPerPixel.toFixed(5)} m per NAIP px (${tight.sidecar.source}, measured from the rendered extent)`
		},
		c1: C1 ? { metersPerScreenshotPx: C1.metersPerPixel, from: C1.referent + ` (${C1.from})` } : null,
		c1OverNaipMinus1: C1 ? C1.metersPerPixel / naipShotMpp - 1 : null
	};

	const slice = {
		course,
		searched,
		adjusted,
		offset: { meters: offsetM, eastMeters: eastM, northMeters: northM, referent: 'searched centre to the centre of the projected course (wide tile fit)' },
		wide: { provider: wide.sidecar.source, center: wide.sidecar.naip.center, radiusMeters: wide.sidecar.naip.radiusMeters, metersPerPixel: wide.sidecar.metersPerPixel, attempts: wide.sidecar.attempts.map((a) => `${a.providerId}:${a.ok ? 'ok' : a.kind}`) },
		pick: { provider: pick.sidecar.source, center: pick.sidecar.naip.center, radiusMeters: pick.sidecar.naip.radiusMeters, metersPerPixel: pick.sidecar.metersPerPixel, sha256: pick.sidecar.sha256 },
		tight: { provider: tight.sidecar.source, radiusMeters: tightRadiusM, metersPerPixel: tight.sidecar.metersPerPixel, attempts: tight.sidecar.attempts.map((a) => `${a.providerId}:${a.ok ? 'ok' : a.kind}`) },
		fit: { model: fit.model, pairs: fit.residualsPx.count, residualsPx: fit.residualsPx, residualsM: fit.residualsM, warnings: fit.warnings },
		scales,
		holes: result.holes,
		files: { locate: join(locateDir, 'locate.svg'), overview: join(fitDir, 'overview.svg'), frames: result.frameFiles, fit: join(fitDir, 'fit.json') }
	};
	writeFileSync(join(out, 'slice.json'), JSON.stringify(slice, null, 1) + '\n');
	console.log(
		JSON.stringify(
			{
				searched,
				adjusted,
				offsetM: Math.round(offsetM * 10) / 10,
				wide: slice.wide.provider,
				tight: `${slice.tight.provider} r=${tightRadiusM} m`,
				residualRms: `${fit.residualsPx.rms.toFixed(2)} px = ${fit.residualsM?.rms.toFixed(2)} m`,
				scale: scales.c1OverNaipMinus1 === null ? scales.naip.metersPerScreenshotPx : `NAIP ${naipShotMpp.toFixed(4)} vs C1 ${C1!.metersPerPixel.toFixed(4)} m per screenshot px (${(scales.c1OverNaipMinus1! * 100).toFixed(2)}%)`,
				files: slice.files
			},
			null,
			1
		)
	);
} catch (error) {
	if (error instanceof IntegrityError) fail(error.message);
	throw error;
}

/** The wide tile with the searched pin (x), the adjusted centre (+), the course's projected box, and a legend. */
function locateMarkup(
	tile: Tile,
	searched: LonLat,
	adjusted: LonLat,
	searchedPx: { xPx: number; yPx: number },
	adjustedPx: { xPx: number; yPx: number },
	box: { minX: number; minY: number; maxX: number; maxY: number },
	offsetM: number,
	course: string
): string {
	const bytes = readFileSync(tile.imagePath);
	const { widthPx: W, heightPx: H, mime } = imageSize(bytes);
	const u = Math.sqrt(W * H) / 250;
	const r = (v: number) => Math.round(v * 100) / 100;
	const s = 4 * u;
	const lines = [
		`${course}: locating the course`,
		`searched (x): ${searched.lat.toFixed(6)}, ${searched.lon.toFixed(6)}`,
		`adjusted (+): ${adjusted.lat.toFixed(6)}, ${adjusted.lon.toFixed(6)} (centre of the projected course)`,
		`offset ${offsetM.toFixed(1)} m (ground, ${tile.sidecar.metersPerPixel.toFixed(3)} m/px ${tile.sidecar.source})`
	];
	const fs = 3.2 * u;
	return [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="system-ui, sans-serif">`,
		`<image href="data:${mime};base64,${bytes.toString('base64')}" x="0" y="0" width="${W}" height="${H}" />`,
		`<rect x="${r(box.minX)}" y="${r(box.minY)}" width="${r(box.maxX - box.minX)}" height="${r(box.maxY - box.minY)}" fill="none" stroke="#22d3ee" stroke-width="${r(0.6 * u)}" stroke-dasharray="${r(2 * u)} ${r(1.2 * u)}" />`,
		`<line x1="${r(searchedPx.xPx)}" y1="${r(searchedPx.yPx)}" x2="${r(adjustedPx.xPx)}" y2="${r(adjustedPx.yPx)}" stroke="#f8fafc" stroke-width="${r(0.4 * u)}" />`,
		`<path d="M${r(searchedPx.xPx - s)} ${r(searchedPx.yPx - s)}L${r(searchedPx.xPx + s)} ${r(searchedPx.yPx + s)}M${r(searchedPx.xPx - s)} ${r(searchedPx.yPx + s)}L${r(searchedPx.xPx + s)} ${r(searchedPx.yPx - s)}" stroke="#f43f5e" stroke-width="${r(1 * u)}" />`,
		`<path d="M${r(adjustedPx.xPx - s * 1.4)} ${r(adjustedPx.yPx)}h${r(2.8 * s)}M${r(adjustedPx.xPx)} ${r(adjustedPx.yPx - s * 1.4)}v${r(2.8 * s)}" stroke="#facc15" stroke-width="${r(1 * u)}" />`,
		`<rect x="${r(2 * u)}" y="${r(2 * u)}" width="${r(Math.max(...lines.map((l) => l.length)) * fs * 0.56 + 4 * u)}" height="${r(lines.length * fs * 1.35 + 3 * u)}" rx="${r(u)}" fill="rgba(11, 18, 32, 0.85)" />`,
		...lines.map(
			(line, i) =>
				`<text x="${r(4 * u)}" y="${r(2 * u + 1.5 * u + (i + 1) * fs * 1.35 - 0.3 * fs)}" font-size="${r(fs)}" font-weight="${i === 0 ? 800 : 500}" fill="${i === 1 ? '#fda4af' : i === 2 ? '#fde68a' : '#f8fafc'}">${line.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text>`
		),
		'</svg>'
	].join('');
}
