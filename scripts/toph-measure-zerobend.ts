/**
 * Measures the 0-bend ray hypothesis on the annotated corpus:
 * for a straight (0-corridor-bend) hole, the badge centroid should sit
 * near the tee→basket chord. Reports, per hole, the perpendicular
 * distance from the nearest P1-detected badge center to the chord, both
 * in raw px and normalized by badge median height (scale-free), for the
 * straight and bent populations separately — bent holes are the control:
 * the shortcut is only usable if the two distributions separate.
 *
 * DashsTrack additionally verifies against the hole-numbered badge truth
 * in courseGroundTruth.ts (nearest-badge aliasing check).
 *
 * Usage: npx tsx scripts/toph-measure-zerobend.ts <imagesDir> <annotatedDir>
 */
import { join } from 'node:path';
import { detectRawObjectMask } from '../src/lib/autoAnnotation/rawObjectMask';
import { IMG_5641_GROUND_TRUTH } from '../src/lib/autoAnnotation/courseGroundTruth';
import { autocropLikeIntake, decodeImage, loadTruths } from './toph-run';
import { readFileSync } from 'node:fs';

const [, , imagesDirArg, annotatedDirArg] = process.argv;
if (!imagesDirArg || !annotatedDirArg) {
	console.error('Usage: npx tsx scripts/toph-measure-zerobend.ts <imagesDir> <annotatedDir>');
	process.exit(1);
}

const COURSES = [
	{ name: 'DashsTrack', image: 'DashsTrack-full.jpg', truth: 'DashsTrack/DashsTrack-full.annotation.json' },
	{ name: 'Heritage', image: 'HeritagePark-full.png', truth: 'Heritage/HeritagePark-full.annotation.json' },
	{ name: 'Lenard', image: 'Lenard-full.PNG', truth: 'Lenard/Lenard-full.annotation.json' },
	{ name: 'TowneLake', image: 'TowneLake-full.png', truth: 'TowneLake/TowneLake-full.annotation.json' }
];

/** Distance from point to segment, plus the projection parameter t in [0,1]. */
function pointToSegment(
	px: number,
	py: number,
	ax: number,
	ay: number,
	bx: number,
	by: number
): { distancePx: number; t: number } {
	const dx = bx - ax;
	const dy = by - ay;
	const lengthSq = dx * dx + dy * dy;
	const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
	const cx = ax + t * dx;
	const cy = ay + t * dy;
	return { distancePx: Math.hypot(px - cx, py - cy), t };
}

function quantiles(values: number[]): string {
	if (values.length === 0) return '(none)';
	const s = [...values].sort((a, b) => a - b);
	const q = (f: number) => s[Math.min(s.length - 1, Math.floor(f * s.length))].toFixed(1);
	return `n=${s.length} min=${s[0].toFixed(1)} p25=${q(0.25)} med=${q(0.5)} p75=${q(0.75)} max=${s[s.length - 1].toFixed(1)}`;
}

function main() {
	const straightNorm: number[] = [];
	const bentNorm: number[] = [];
	for (const entry of COURSES) {
		const decoded = decodeImage(join(imagesDirArg, entry.image));
		const { sourceWidthPx, sourceHeightPx } = loadTruths(join(annotatedDirArg, entry.truth));
		let raster: { rgba: Uint8ClampedArray; widthPx: number; heightPx: number } = decoded;
		if (decoded.widthPx !== sourceWidthPx || decoded.heightPx !== sourceHeightPx) {
			raster = autocropLikeIntake(decoded);
		}
		const doc = JSON.parse(readFileSync(join(annotatedDirArg, entry.truth), 'utf8'));
		const result = detectRawObjectMask(raster);
		const badgeHeights = [...result.badges.map((b) => b.heightPx)].sort((a, b) => a - b);
		const badgeH = badgeHeights.length ? badgeHeights[Math.floor(badgeHeights.length / 2)] : 1;

		const straight: number[] = [];
		const bent: number[] = [];
		console.log(`\n=== ${entry.name} (badge median height ${badgeH}px, ${result.badges.length} badges)`);
		for (const hole of doc.holes ?? []) {
			if (!hole.tee || !hole.basket) continue;
			let best = Infinity;
			let bestT = 0;
			let second = Infinity;
			for (const badge of result.badges) {
				const { distancePx, t } = pointToSegment(
					badge.xPx,
					badge.yPx,
					hole.tee.xPx,
					hole.tee.yPx,
					hole.basket.xPx,
					hole.basket.yPx
				);
				if (distancePx < best) {
					second = best;
					best = distancePx;
					bestT = t;
				} else if (distancePx < second) {
					second = distancePx;
				}
			}
			const isStraight = (hole.corridorBends ?? []).length === 0;
			(isStraight ? straight : bent).push(best);
			(isStraight ? straightNorm : bentNorm).push(best / badgeH);
			console.log(
				`  H${String(hole.number).padStart(2)} ${isStraight ? 'straight' : `bent(${hole.corridorBends.length})`}`.padEnd(18) +
					` nearestBadge ${best.toFixed(1)}px (${(best / badgeH).toFixed(2)}×badgeH) at t=${bestT.toFixed(2)}, margin to 2nd ${Number.isFinite(second) ? (second - best).toFixed(1) : '-'}px`
			);
		}
		console.log(`  straight px: ${quantiles(straight)}`);
		console.log(`  bent px:     ${quantiles(bent)}`);
	}

	console.log(`\n=== all courses, normalized by badge height`);
	console.log(`  straight: ${quantiles(straightNorm)}`);
	console.log(`  bent:     ${quantiles(bentNorm)}`);

	// DashsTrack aliasing check: nearest badge vs the SAME hole's true badge.
	console.log(`\n=== DashsTrack per-hole badge identity check (courseGroundTruth)`);
	const decoded = decodeImage(join(imagesDirArg, 'DashsTrack-full.jpg'));
	const doc = JSON.parse(
		readFileSync(join(annotatedDirArg, 'DashsTrack/DashsTrack-full.annotation.json'), 'utf8')
	);
	const truthBadges = IMG_5641_GROUND_TRUTH.badges;
	void decoded;
	let aliased = 0;
	for (const hole of doc.holes ?? []) {
		if (!hole.tee || !hole.basket) continue;
		const own = truthBadges.find((b: { number: number }) => b.number === hole.number);
		if (!own) continue;
		const ownDistance = pointToSegment(
			(own as { xPx: number }).xPx,
			(own as { yPx: number }).yPx,
			hole.tee.xPx,
			hole.tee.yPx,
			hole.basket.xPx,
			hole.basket.yPx
		).distancePx;
		let nearestOtherDistance = Infinity;
		for (const other of truthBadges) {
			if ((other as { number: number }).number === hole.number) continue;
			const d = pointToSegment(
				(other as { xPx: number }).xPx,
				(other as { yPx: number }).yPx,
				hole.tee.xPx,
				hole.tee.yPx,
				hole.basket.xPx,
				hole.basket.yPx
			).distancePx;
			nearestOtherDistance = Math.min(nearestOtherDistance, d);
		}
		const isStraight = (hole.corridorBends ?? []).length === 0;
		const alias = nearestOtherDistance < ownDistance;
		if (alias && isStraight) aliased += 1;
		console.log(
			`  H${String(hole.number).padStart(2)} ${isStraight ? 'straight' : 'bent'}  ownBadge ${ownDistance.toFixed(1)}px, nearest OTHER ${nearestOtherDistance.toFixed(1)}px${alias ? '  <-- ALIASED' : ''}`
		);
	}
	console.log(`  straight holes where another hole's badge is closer to the chord: ${aliased}`);
}

main();
