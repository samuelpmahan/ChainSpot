/**
 * Broadcast frame: one hole as a 16:9, 1920 x 1080 graphic.
 *
 * The map is the product's own hole graphic (`planHoleGraphic` -> `buildHoleGraphicMarkup`), embedded as a nested
 * SVG, never redrawn. The composition follows Creator v0's `renderScene` (`static/creator-v0/render.js` on
 * `task/creator-v0-disc-card-battle`): the content has a natural size, its scale is the requested scale clamped so
 * the WHOLE content stays inside the safe area (1920 - 2 x 60 by 1080 - 2 x 60), and an anchor places it at the
 * centre or a corner of that safe area. Preview and export use this one scene.
 *
 * Sizes on the frame are multiples of `FRAME_UNIT_PX` (the frame is fixed, so these are frame px by design); sizes
 * inside the map are graphic units of `holeGraphics.ts`, passed as one unit per frame so markers read the same on
 * every hole.
 *
 * The length line never prints a number without its referent: feet only when the basemap has a known ground scale
 * (`feetPerPixel`, from `naipMetersPerPixel`), otherwise px, labelled as px of the named image.
 */
import { buildHoleGraphicMarkup } from '../holeGraphics';
import type { CropRect, HoleGraphicPlan } from '../holeGraphics';
import { computeCenterlineLengthPx } from './distances';
import { DEFAULT_GRAPHIC_STYLE } from './style';
import type { GraphicStyle } from './style';

export const BROADCAST_FRAME = { widthPx: 1920, heightPx: 1080, marginPx: 60 } as const;

/** The frame's own unit: 1/150 of its height (7.2 px on 1920 x 1080). */
export const FRAME_UNIT_PX = BROADCAST_FRAME.heightPx / 150;

export type FrameAnchor = 'center' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export interface HoleLengthLabel {
	/** Rounded for display. */
	readonly value: number;
	readonly unit: 'ft' | 'px';
	/** What the number measures and in which image, e.g. "along the centerline, px of IMG_5641.jpg". */
	readonly referent: string;
}

export interface BroadcastFrameOptions {
	/** Where the map sits in the safe area (default 'center'). */
	readonly anchor?: FrameAnchor;
	/** Requested map scale (frame px per target px); clamped so the whole map stays in the safe area. Default: fit. */
	readonly scale?: number;
	readonly style?: GraphicStyle;
	/** Ground scale of the target image, when known (NAIP); the length is then in feet. */
	readonly feetPerPixel?: number;
	/** Name of the target image, for the px referent when no ground scale is known (e.g. "IMG_5641.jpg"). */
	readonly targetName: string;
	/** Where the ground scale came from, shown under a length in feet (e.g. "USGS NAIP, 0.293 m/px"). */
	readonly groundScaleReferent?: string;
	readonly courseName?: string;
	/** Frame background behind the safe area (default a dark slate). */
	readonly background?: string;
	/** Expand the hole's crop to the safe area's aspect so the map fills it (default true). */
	readonly fillSafeArea?: boolean;
}

export interface BroadcastFrame {
	readonly svg: string;
	/** The map's box on the frame, in frame px. */
	readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
	readonly effectiveScale: number;
	readonly length: HoleLengthLabel | null;
	/** The plan actually drawn (its crop expanded to the safe area's aspect when `fillSafeArea`). */
	readonly plan: HoleGraphicPlan;
}

const SAFE_WIDTH_PX = BROADCAST_FRAME.widthPx - 2 * BROADCAST_FRAME.marginPx;
const SAFE_HEIGHT_PX = BROADCAST_FRAME.heightPx - 2 * BROADCAST_FRAME.marginPx;

function escapeText(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function round3(value: number): number {
	return Math.round(value * 1000) / 1000;
}

/**
 * Grows a crop about its centre to `aspect` (width / height), then shifts and clips it into the target image. It never
 * shrinks the crop, so every framed point stays in view. A rotated plan is returned unchanged (its crop is framed
 * against the rotated footprint; the anchor/scale clamp still keeps it whole).
 */
export function fitCropToAspect(plan: HoleGraphicPlan, aspect: number): HoleGraphicPlan {
	if (plan.targetRotationDeg !== 0 || !(aspect > 0)) return plan;
	const { crop } = plan;
	let widthPx = crop.widthPx;
	let heightPx = crop.heightPx;
	if (widthPx / heightPx < aspect) widthPx = heightPx * aspect;
	else heightPx = widthPx / aspect;
	widthPx = Math.min(widthPx, plan.targetWidthPx);
	heightPx = Math.min(heightPx, plan.targetHeightPx);
	const centerX = crop.xPx + crop.widthPx / 2;
	const centerY = crop.yPx + crop.heightPx / 2;
	const xPx = Math.min(Math.max(centerX - widthPx / 2, 0), plan.targetWidthPx - widthPx);
	const yPx = Math.min(Math.max(centerY - heightPx / 2, 0), plan.targetHeightPx - heightPx);
	const fitted: CropRect = { xPx, yPx, widthPx, heightPx };
	return { ...plan, crop: fitted };
}

/** The hole's length along its centerline, in feet when the ground scale is known, else in px of the named image. */
export function holeLengthLabel(
	plan: HoleGraphicPlan,
	targetName: string,
	feetPerPixel?: number,
	groundScaleReferent?: string
): HoleLengthLabel | null {
	const lengthPx = computeCenterlineLengthPx(plan);
	if (lengthPx === null) return null;
	if (feetPerPixel !== undefined && Number.isFinite(feetPerPixel) && feetPerPixel > 0) {
		return {
			value: Math.round(lengthPx * feetPerPixel),
			unit: 'ft',
			referent: `along the centerline, ground scale ${groundScaleReferent ?? 'of ' + targetName}`
		};
	}
	return { value: Math.round(lengthPx), unit: 'px', referent: `along the centerline, px of ${targetName} (no ground scale yet)` };
}

/** Anchor/scale placement of a `width x height` composition, exactly as Creator v0's `renderScene`. */
export function placeInFrame(
	width: number,
	height: number,
	anchor: FrameAnchor = 'center',
	requestedScale = Number.POSITIVE_INFINITY
): { x: number; y: number; scale: number } {
	const { widthPx, heightPx, marginPx } = BROADCAST_FRAME;
	const scale = Math.min(requestedScale, SAFE_WIDTH_PX / Math.max(width, 1), SAFE_HEIGHT_PX / Math.max(height, 1));
	const x =
		anchor === 'center' ? (widthPx - width * scale) / 2 : anchor.endsWith('right') ? widthPx - marginPx - width * scale : marginPx;
	const y =
		anchor === 'center' ? (heightPx - height * scale) / 2 : anchor.startsWith('top') ? marginPx : heightPx - marginPx - height * scale;
	return { x, y, scale };
}

/** Splits text at spaces into lines of at most `max` characters (a longer word stays whole). */
export function wrapWords(text: string, max: number): string[] {
	const lines: string[] = [];
	let line = '';
	for (const word of text.split(/\s+/).filter(Boolean)) {
		if (line && line.length + 1 + word.length > max) {
			lines.push(line);
			line = word;
		} else line = line ? `${line} ${word}` : word;
	}
	if (line) lines.push(line);
	return lines;
}

function titleCard(
	plan: HoleGraphicPlan,
	length: HoleLengthLabel | null,
	style: GraphicStyle,
	bounds: BroadcastFrame['bounds'],
	courseName: string | undefined
): string {
	const u = FRAME_UNIT_PX;
	const titleSize = 10 * u;
	const lineSize = 5 * u;
	const noteSize = 2.6 * u;
	const pad = 3 * u;
	const title = `HOLE ${plan.number}`;
	const lines: { text: string; size: number; color: string; weight: string }[] = [
		{ text: title, size: titleSize, color: style.cardText, weight: '800' }
	];
	if (courseName) lines.push({ text: courseName.toUpperCase(), size: noteSize * 1.2, color: style.cardBorder, weight: '700' });
	const facts = [plan.par !== undefined ? `PAR ${plan.par}` : null, length ? `${length.value.toLocaleString('en-US')} ${length.unit}` : null]
		.filter((fact): fact is string => fact !== null)
		.join('  ·  ');
	if (facts) lines.push({ text: facts, size: lineSize, color: style.cardText, weight: '700' });
	if (length) for (const text of wrapWords(length.referent, 44)) lines.push({ text, size: noteSize, color: style.cardText, weight: '400' });

	// Text width estimate (about 0.6 em per character for a bold sans); the card grows with its longest line.
	const width = Math.max(...lines.map((line) => line.text.length * line.size * 0.6)) + 2 * pad;
	const height = lines.reduce((sum, line) => sum + line.size * 1.25, 0) + 2 * pad;
	// The card takes the corner of the map that covers the fewest of the hole's own marks (tee, bends, basket).
	const left = Math.max(bounds.x, BROADCAST_FRAME.marginPx) + 2 * u;
	const right = Math.min(bounds.x + bounds.width, BROADCAST_FRAME.widthPx - BROADCAST_FRAME.marginPx) - width - 2 * u;
	const top = Math.max(bounds.y, BROADCAST_FRAME.marginPx) + 2 * u;
	const bottom = Math.min(bounds.y + bounds.height, BROADCAST_FRAME.heightPx - BROADCAST_FRAME.marginPx) - height - 2 * u;
	const scale = bounds.width / plan.crop.widthPx;
	const marks = [...(plan.tee ? [plan.tee] : []), ...plan.bends, ...(plan.basket ? [plan.basket] : [])].map((p) => ({
		x: bounds.x + (p.xPx - plan.crop.xPx) * scale,
		y: bounds.y + (p.yPx - plan.crop.yPx) * scale
	}));
	const clearance = 3 * u;
	const covered = (cx: number, cy: number) =>
		marks.filter((m) => m.x >= cx - clearance && m.x <= cx + width + clearance && m.y >= cy - clearance && m.y <= cy + height + clearance).length;
	const corners = [
		{ x: left, y: bottom },
		{ x: right, y: bottom },
		{ x: left, y: top },
		{ x: right, y: top }
	];
	const { x, y } = corners.reduce((best, c) => (covered(c.x, c.y) < covered(best.x, best.y) ? c : best), corners[0]);

	const parts = [
		`<rect x="${round3(x)}" y="${round3(y)}" width="${round3(width)}" height="${round3(height)}" rx="${round3(u)}" fill="${escapeText(style.cardBackground)}" />`,
		`<rect x="${round3(x)}" y="${round3(y)}" width="${round3(u)}" height="${round3(height)}" fill="${escapeText(style.cardBorder)}" />`
	];
	let baseline = y + pad;
	for (const line of lines) {
		baseline += line.size;
		parts.push(
			`<text x="${round3(x + pad)}" y="${round3(baseline)}" font-family="system-ui, sans-serif" font-weight="${line.weight}" font-size="${round3(line.size)}" fill="${escapeText(line.color)}">${escapeText(line.text)}</text>`
		);
		baseline += line.size * 0.25;
	}
	return `<g data-role="title-card">${parts.join('')}</g>`;
}

/**
 * Composes one hole's broadcast frame. `targetImageHref` is the target raster (NAIP once it can be fetched; the
 * user's own screenshot until then).
 */
export function composeBroadcastFrame(
	plan: HoleGraphicPlan,
	targetImageHref: string,
	options: BroadcastFrameOptions
): BroadcastFrame {
	const style = options.style ?? DEFAULT_GRAPHIC_STYLE;
	const drawn = options.fillSafeArea === false ? plan : fitCropToAspect(plan, SAFE_WIDTH_PX / SAFE_HEIGHT_PX);
	const { crop } = drawn;
	const { x, y, scale } = placeInFrame(crop.widthPx, crop.heightPx, options.anchor ?? 'center', options.scale);
	const bounds = { x, y, width: crop.widthPx * scale, height: crop.heightPx * scale };
	const length = holeLengthLabel(drawn, options.targetName, options.feetPerPixel, options.groundScaleReferent);
	// One frame unit on screen = FRAME_UNIT_PX; inside the scaled map that is FRAME_UNIT_PX / scale target px.
	const map = buildHoleGraphicMarkup(drawn, targetImageHref, style, options.feetPerPixel, {
		unitPx: FRAME_UNIT_PX / scale,
		infoCard: false
	});
	const { widthPx, heightPx } = BROADCAST_FRAME;
	const svg = [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${widthPx}" height="${heightPx}" viewBox="0 0 ${widthPx} ${heightPx}" role="img" aria-label="Hole ${drawn.number} broadcast frame">`,
		`<rect width="${widthPx}" height="${heightPx}" fill="${escapeText(options.background ?? '#0b1220')}" />`,
		`<g data-role="map" transform="translate(${round3(x)} ${round3(y)}) scale(${scale})">${map}</g>`,
		titleCard(drawn, length, style, bounds, options.courseName),
		'</svg>'
	].join('');
	return { svg, bounds, effectiveScale: scale, length, plan: drawn };
}
