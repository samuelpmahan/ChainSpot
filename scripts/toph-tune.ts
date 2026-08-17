/**
 * P1 tuning sweep over the annotated corpus (Toph-attributed).
 *
 * Runs detectRawObjectMask across every course × tuning config, scoring
 * tee/basket recall and false positives against the corpus annotations.
 * The candidate grid is not free-form search: each axis exists because the
 * Toph first-loss baseline attributed real truth losses to that exact gate
 * (see the run summary in the experiment report). AlexClark is deliberately
 * excluded per the experiment brief.
 *
 * Usage: npx tsx scripts/toph-tune.ts <imagesDir> <annotatedDir>
 *   imagesDir:    directory containing the four -full course images
 *   annotatedDir: chainspot-corpus dev/Annotated directory
 */
import { join } from 'node:path';
import {
	detectRawObjectMask,
	RAW_MASK_TUNING_DEFAULTS,
	type RawMaskTuning
} from '../src/lib/autoAnnotation/rawObjectMask';
import { autocropLikeIntake, decodeImage, loadTruths } from './toph-run';

const [, , imagesDirArg, annotatedDirArg] = process.argv;
if (!imagesDirArg || !annotatedDirArg) {
	console.error('Usage: npx tsx scripts/toph-tune.ts <imagesDir> <annotatedDir>');
	process.exit(1);
}

const COURSES = [
	{ name: 'DashsTrack', image: 'DashsTrack-full.jpg', truth: 'DashsTrack/DashsTrack-full.annotation.json' },
	{ name: 'Heritage', image: 'HeritagePark-full.png', truth: 'Heritage/HeritagePark-full.annotation.json' },
	{ name: 'Lenard', image: 'Lenard-full.PNG', truth: 'Lenard/Lenard-full.annotation.json' },
	{ name: 'TowneLake', image: 'TowneLake-full.png', truth: 'TowneLake/TowneLake-full.annotation.json' }
];

interface CourseData {
	name: string;
	raster: { rgba: Uint8ClampedArray; widthPx: number; heightPx: number };
	truths: { hole: number; kind: 'tee' | 'basket'; xPx: number; yPx: number }[];
}

interface Score {
	teeDetected: number;
	teeTruths: number;
	teeFP: number;
	basketDetected: number;
	basketTruths: number;
	basketFP: number;
}

function scoreCourse(course: CourseData, tuning?: Partial<RawMaskTuning>): Score {
	const result = detectRawObjectMask(course.raster, undefined, tuning);
	const badgeHeights = [...result.badges.map((b) => b.heightPx)].sort((a, b) => a - b);
	const badgeMedianHeight = badgeHeights.length
		? badgeHeights[Math.floor(badgeHeights.length / 2)]
		: 0;
	const tolerancePx = Math.min(26, Math.max(10, badgeMedianHeight * 0.75));

	const score: Score = {
		teeDetected: 0,
		teeTruths: 0,
		teeFP: 0,
		basketDetected: 0,
		basketTruths: 0,
		basketFP: 0
	};
	for (const kind of ['tee', 'basket'] as const) {
		const emitted = kind === 'tee' ? result.tees : result.baskets;
		const truths = course.truths.filter((t) => t.kind === kind);
		if (kind === 'tee') score.teeTruths = truths.length;
		else score.basketTruths = truths.length;
		for (const truth of truths) {
			const hit = emitted.some(
				(o) => Math.hypot(o.xPx - truth.xPx, o.yPx - truth.yPx) <= tolerancePx
			);
			if (hit) kind === 'tee' ? (score.teeDetected += 1) : (score.basketDetected += 1);
		}
		for (const o of emitted) {
			const matched = truths.some(
				(truth) => Math.hypot(o.xPx - truth.xPx, o.yPx - truth.yPx) <= tolerancePx
			);
			if (!matched) kind === 'tee' ? (score.teeFP += 1) : (score.basketFP += 1);
		}
	}
	return score;
}

function loadCourse(entry: (typeof COURSES)[number]): CourseData {
	const decoded = decodeImage(join(imagesDirArg, entry.image));
	const { truths, sourceWidthPx, sourceHeightPx } = loadTruths(join(annotatedDirArg, entry.truth));
	let raster: CourseData['raster'] = decoded;
	if (decoded.widthPx !== sourceWidthPx || decoded.heightPx !== sourceHeightPx) {
		const cropped = autocropLikeIntake(decoded);
		if (cropped.widthPx !== sourceWidthPx || cropped.heightPx !== sourceHeightPx) {
			throw new Error(`${entry.name}: frame mismatch after autocrop`);
		}
		raster = cropped;
	}
	return { name: entry.name, raster, truths };
}

interface Config {
	label: string;
	tuning: Partial<RawMaskTuning>;
}

/**
 * Each axis is tied to a Toph-attributed loss:
 *  - teeAreaVsBasketMin: 52/52 satellite tee truths rejected at areaVsBasket
 *    with ratios 0.066-0.086 vs the 0.09 floor.
 *  - basketPoolExcludeInsideBadgeMarginFrac: Lenard's consensus lost to the
 *    17-member badge-digit cluster (digits are inside badge bodies).
 *  - basketPoolFillMin: Heritage H12/13/17 + Lenard H12 real baskets at
 *    fill 0.29-0.33 vs the 0.40 floor.
 *  - basketPoolAspectMin: Lenard H9 real basket at aspect 1.08 vs 1.25.
 */
const CONFIGS: Config[] = [
	{ label: 'default', tuning: {} },
	{
		label: 'historical',
		tuning: {
			basketPoolExcludeInsideBadgeMarginFrac: null,
			teeAreaVsBasketMin: 0.09,
			basketPoolFillMin: 0.4,
			teeMinDimBadgeHeightFrac: 0.45
		}
	},
	{ label: 'badgeExcl', tuning: { basketPoolExcludeInsideBadgeMarginFrac: 0.08 } },
	{ label: 'teeArea.07', tuning: { teeAreaVsBasketMin: 0.07 } },
	{ label: 'teeArea.06', tuning: { teeAreaVsBasketMin: 0.06 } },
	{ label: 'teeArea.05', tuning: { teeAreaVsBasketMin: 0.05 } },
	{ label: 'bFill.30', tuning: { basketPoolFillMin: 0.3 } },
	{ label: 'bFill.26', tuning: { basketPoolFillMin: 0.26 } },
	{ label: 'bAspect1.05', tuning: { basketPoolAspectMin: 1.05 } },
	{
		label: 'combo',
		tuning: {
			basketPoolExcludeInsideBadgeMarginFrac: 0.08,
			teeAreaVsBasketMin: 0.06,
			basketPoolFillMin: 0.26
		}
	},
	{
		label: 'combo+aspect',
		tuning: {
			basketPoolExcludeInsideBadgeMarginFrac: 0.08,
			teeAreaVsBasketMin: 0.06,
			basketPoolFillMin: 0.26,
			basketPoolAspectMin: 1.05
		}
	},
	{
		label: 'combo+md.35',
		tuning: {
			basketPoolExcludeInsideBadgeMarginFrac: 0.08,
			teeAreaVsBasketMin: 0.06,
			basketPoolFillMin: 0.26,
			teeMinDimBadgeHeightFrac: 0.35
		}
	},
	{
		label: 'combo+md.30',
		tuning: {
			basketPoolExcludeInsideBadgeMarginFrac: 0.08,
			teeAreaVsBasketMin: 0.06,
			basketPoolFillMin: 0.26,
			teeMinDimBadgeHeightFrac: 0.3
		}
	},
	{
		label: 'combo+md.28',
		tuning: {
			basketPoolExcludeInsideBadgeMarginFrac: 0.08,
			teeAreaVsBasketMin: 0.06,
			basketPoolFillMin: 0.26,
			teeMinDimBadgeHeightFrac: 0.28
		}
	},
	{
		label: 'combo+md.30+m.04',
		tuning: {
			basketPoolExcludeInsideBadgeMarginFrac: 0.04,
			teeAreaVsBasketMin: 0.06,
			basketPoolFillMin: 0.26,
			teeMinDimBadgeHeightFrac: 0.3
		}
	}
];

function main() {
	const courses = COURSES.map(loadCourse);
	console.log(
		'config'.padEnd(14) +
			courses.map((c) => c.name.padStart(22)).join('') +
			'   totals (tee, basket, FP)'
	);
	for (const config of CONFIGS) {
		let teeD = 0;
		let teeT = 0;
		let bD = 0;
		let bT = 0;
		let fp = 0;
		const cells: string[] = [];
		for (const course of courses) {
			const s = scoreCourse(course, config.tuning);
			teeD += s.teeDetected;
			teeT += s.teeTruths;
			bD += s.basketDetected;
			bT += s.basketTruths;
			fp += s.teeFP + s.basketFP;
			cells.push(
				`t${s.teeDetected}/${s.teeTruths} b${s.basketDetected}/${s.basketTruths} +${s.teeFP + s.basketFP}`.padStart(
					22
				)
			);
		}
		console.log(
			config.label.padEnd(14) + cells.join('') + `   ${teeD}/${teeT}, ${bD}/${bT}, +${fp}`
		);
	}
	// Explicit sanity echo of what the defaults are, so the table is self-describing.
	console.log(
		`\ndefaults: teeAreaVsBasketMin=${RAW_MASK_TUNING_DEFAULTS.teeAreaVsBasketMin}, ` +
			`basketPoolFillMin=${RAW_MASK_TUNING_DEFAULTS.basketPoolFillMin}, ` +
			`basketPoolAspectMin=${RAW_MASK_TUNING_DEFAULTS.basketPoolAspectMin}, ` +
			`teeMinDimBadgeHeightFrac=${RAW_MASK_TUNING_DEFAULTS.teeMinDimBadgeHeightFrac}, ` +
			`basketPoolExcludeInsideBadgeMarginFrac=${RAW_MASK_TUNING_DEFAULTS.basketPoolExcludeInsideBadgeMarginFrac}`
	);
}

main();
