/**
 * Course overview: every hole projected onto one target image (the NAIP basemap, or a screenshot until NAIP can be
 * fetched), labelled, with the alignment's point pairs and their residual vectors.
 *
 * Each hole's overlay is the product's own `buildHoleGraphicMarkup` with the raster left out and the crop widened to
 * the whole image, layered over ONE copy of the raster; only the labels, the pairs and the legend are drawn here.
 * All sizes are graphic units of the whole image (LOCAL: 1/`OVERVIEW_UNITS_PER_IMAGE` of the geometric mean of its
 * sides), so the page reads the same at every basemap size.
 */
import { buildHoleGraphicMarkup } from '../holeGraphics';
import type { HoleGraphicPlan } from '../holeGraphics';
import { DEFAULT_GRAPHIC_STYLE } from './style';
import type { GraphicStyle } from './style';

export const OVERVIEW_UNITS_PER_IMAGE = 250;

export interface OverviewPair {
	readonly id: string;
	readonly label: string;
	/** Where the pair's target point was picked, target px. */
	readonly target: { readonly xPx: number; readonly yPx: number };
	/** Where the fit puts the pair's source point, target px. */
	readonly expected: { readonly xPx: number; readonly yPx: number };
}

export interface CourseOverviewOptions {
	readonly style?: GraphicStyle;
	/** Hole ids drawn with the "needs review" colour (the CV's own evidence, never decided here). */
	readonly needsReview?: ReadonlySet<string>;
	readonly pairs?: readonly OverviewPair[];
	/** Lines for the summary box (fit model, residuals with units and referents). */
	readonly summary?: readonly string[];
	readonly title?: string;
}

const REVIEW_COLOR = '#f59e0b';
const PAIR_TARGET_COLOR = '#22d3ee';
const PAIR_EXPECTED_COLOR = '#f43f5e';

function esc(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function r3(value: number): number {
	return Math.round(value * 1000) / 1000;
}

export function overviewUnitPx(widthPx: number, heightPx: number): number {
	return Math.sqrt(widthPx * heightPx) / OVERVIEW_UNITS_PER_IMAGE;
}

/** `plans` must share one target image (same `targetWidthPx` x `targetHeightPx`). */
export function buildCourseOverviewMarkup(
	plans: readonly HoleGraphicPlan[],
	targetImageHref: string,
	targetWidthPx: number,
	targetHeightPx: number,
	options: CourseOverviewOptions = {}
): string {
	const style = options.style ?? DEFAULT_GRAPHIC_STYLE;
	const u = overviewUnitPx(targetWidthPx, targetHeightPx);
	const whole = { xPx: 0, yPx: 0, widthPx: targetWidthPx, heightPx: targetHeightPx };
	const parts: string[] = [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${targetWidthPx}" height="${targetHeightPx}" viewBox="0 0 ${targetWidthPx} ${targetHeightPx}" font-family="system-ui, sans-serif">`,
		`<image href="${esc(targetImageHref)}" x="0" y="0" width="${targetWidthPx}" height="${targetHeightPx}" preserveAspectRatio="none" />`
	];

	for (const plan of plans) {
		const review = options.needsReview?.has(plan.holeId) ?? false;
		const holeStyle = review ? { ...style, pathColor: REVIEW_COLOR } : style;
		parts.push(
			buildHoleGraphicMarkup({ ...plan, crop: whole, targetRotationDeg: 0 }, '', holeStyle, undefined, {
				unitPx: u,
				infoCard: false,
				raster: false
			})
		);
	}

	// Labels after every overlay, so no corridor covers a number.
	for (const plan of plans) {
		const anchor = plan.tee ?? plan.basket;
		if (!anchor) continue;
		const review = options.needsReview?.has(plan.holeId) ?? false;
		const radius = 4 * u;
		const cx = anchor.xPx - 5 * u;
		const cy = anchor.yPx - 5 * u;
		parts.push(
			`<g data-hole="${plan.number}"><circle cx="${r3(cx)}" cy="${r3(cy)}" r="${r3(radius)}" fill="${review ? REVIEW_COLOR : esc(style.cardBackground)}" stroke="${esc(style.cardText)}" stroke-width="${r3(0.5 * u)}" />` +
				`<text x="${r3(cx)}" y="${r3(cy + 1.6 * u)}" text-anchor="middle" font-weight="800" font-size="${r3(4.4 * u)}" fill="${esc(style.cardText)}">${plan.number}</text></g>`
		);
	}

	for (const pair of options.pairs ?? []) {
		const s = r3(2.2 * u);
		parts.push(
			`<g data-pair="${esc(pair.id)}">` +
				`<line x1="${r3(pair.target.xPx)}" y1="${r3(pair.target.yPx)}" x2="${r3(pair.expected.xPx)}" y2="${r3(pair.expected.yPx)}" stroke="${PAIR_EXPECTED_COLOR}" stroke-width="${r3(0.5 * u)}" />` +
				`<path d="M${r3(pair.target.xPx - s)} ${r3(pair.target.yPx)}h${r3(2 * s)}M${r3(pair.target.xPx)} ${r3(pair.target.yPx - s)}v${r3(2 * s)}" stroke="${PAIR_TARGET_COLOR}" stroke-width="${r3(0.6 * u)}" />` +
				`<circle cx="${r3(pair.expected.xPx)}" cy="${r3(pair.expected.yPx)}" r="${r3(1 * u)}" fill="${PAIR_EXPECTED_COLOR}" />` +
				`<text x="${r3(pair.target.xPx + 2.8 * u)}" y="${r3(pair.target.yPx - 1.4 * u)}" font-size="${r3(3 * u)}" font-weight="700" fill="${PAIR_TARGET_COLOR}" stroke="#000" stroke-width="${r3(0.15 * u)}">${esc(pair.label)}</text></g>`
		);
	}

	const legend: { color: string; text: string }[] = [
		{ color: style.teeColor, text: 'tee' },
		{ color: style.basketColor, text: 'basket' },
		{ color: style.pathColor, text: 'corridor, bends (CV route)' },
		...(options.needsReview?.size ? [{ color: REVIEW_COLOR, text: 'hole the CV flags for review' }] : []),
		...(options.pairs?.length
			? [
					{ color: PAIR_TARGET_COLOR, text: 'pair: picked target point' },
					{ color: PAIR_EXPECTED_COLOR, text: 'pair: fitted source point (line = residual)' }
				]
			: [])
	];
	const lines = [...(options.title ? [options.title] : []), ...(options.summary ?? [])];
	const fontSize = 3.2 * u;
	const lineHeight = fontSize * 1.3;
	const boxWidth = Math.max(...[...lines, ...legend.map((l) => '    ' + l.text)].map((t) => t.length * fontSize * 0.56), 10 * u) + 4 * u;
	const boxHeight = (lines.length + legend.length) * lineHeight + 3 * u;
	// The legend takes the corner that covers the fewest projected points (holes and pairs), so it hides no hole.
	const marks = [
		...plans.flatMap((plan) => [...(plan.tee ? [plan.tee] : []), ...(plan.basket ? [plan.basket] : []), ...plan.bends, ...(plan.corridorBand ?? [])]),
		...(options.pairs ?? []).map((pair) => pair.target)
	];
	const corners = [
		{ x: 2 * u, y: targetHeightPx - boxHeight - 2 * u },
		{ x: 2 * u, y: 2 * u },
		{ x: targetWidthPx - boxWidth - 2 * u, y: 2 * u },
		{ x: targetWidthPx - boxWidth - 2 * u, y: targetHeightPx - boxHeight - 2 * u }
	];
	const covered = (c: { x: number; y: number }) =>
		marks.filter((m) => m.xPx >= c.x - 6 * u && m.xPx <= c.x + boxWidth + 6 * u && m.yPx >= c.y - 6 * u && m.yPx <= c.y + boxHeight + 6 * u).length;
	const corner = corners.reduce((best, c) => (covered(c) < covered(best) ? c : best), corners[0]);
	const boxX = corner.x;
	const boxY = corner.y;
	parts.push(`<rect x="${r3(boxX)}" y="${r3(boxY)}" width="${r3(boxWidth)}" height="${r3(boxHeight)}" rx="${r3(u)}" fill="rgba(11, 18, 32, 0.85)" />`);
	let y = boxY + 1.5 * u;
	lines.forEach((line, index) => {
		y += lineHeight;
		parts.push(
			`<text x="${r3(boxX + 2 * u)}" y="${r3(y - 0.3 * fontSize)}" font-size="${r3(fontSize)}" font-weight="${index === 0 && options.title ? 800 : 500}" fill="#f8fafc">${esc(line)}</text>`
		);
	});
	for (const item of legend) {
		y += lineHeight;
		parts.push(
			`<circle cx="${r3(boxX + 3 * u)}" cy="${r3(y - 0.6 * fontSize)}" r="${r3(1.2 * u)}" fill="${esc(item.color)}" />` +
				`<text x="${r3(boxX + 5.5 * u)}" y="${r3(y - 0.3 * fontSize)}" font-size="${r3(fontSize)}" fill="#f8fafc">${esc(item.text)}</text>`
		);
	}
	parts.push('</svg>');
	return parts.join('');
}
