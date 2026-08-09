/**
 * ChainSpot clean hole graphic construction.
 *
 * Applies an estimated source-to-target transform (`src/lib/alignment`) to a
 * hole's manually-annotated tee/basket/shot/bend points and its DERIVED
 * constant-width corridor band and centerline (see `src/lib/corridor.ts` —
 * tee + bends + basket + width become a closed polygon and a centerline
 * polyline), producing their positions in the clean target image's pixel
 * space, then frames a crop around them. No feature detection or image
 * analysis happens here — every point was already placed by the user (or, in
 * a future iteration, a reviewed CV proposal); this module only ever does
 * arithmetic and markup generation, the same "structured geometry, not
 * edited screenshots" boundary the rest of the domain layer keeps.
 *
 * Rendering is SVG-first: `buildHoleGraphicMarkup` produces self-contained
 * markup that crops via `viewBox` (no separate pixel-copy step) and is used
 * identically for a live, resolution-independent DOM preview and for
 * offscreen PNG rasterization at download time — one source of truth for
 * both, instead of a second hand-written canvas drawing implementation.
 */
import { applyTransform } from './alignment/transform';
import type { SerializableTransform } from './alignment/types';
import { deriveCorridorBand, deriveCorridorCenterline } from './corridor';
import type { AnnotatedHole } from './domain/annotatedRound';
import { computeHoleDistances } from './graphics/distances';
import { DEFAULT_GRAPHIC_STYLE } from './graphics/style';
import type { GraphicStyle } from './graphics/style';

export interface TargetPoint {
	readonly xPx: number;
	readonly yPx: number;
}

export interface CropRect {
	readonly xPx: number;
	readonly yPx: number;
	readonly widthPx: number;
	readonly heightPx: number;
}

export interface HoleGraphicPlan {
	readonly holeId: string;
	readonly number: number;
	/** Scorecard par, when known; shown on the info card. */
	readonly par?: number;
	readonly tee: TargetPoint | null;
	readonly basket: TargetPoint | null;
	readonly shots: readonly TargetPoint[];
	/** Present only when the source hole can derive a complete corridor band — never a synthesized shape. */
	readonly corridorBand: readonly TargetPoint[] | null;
	/** [tee, ...bends, basket] with absent endpoints filtered out; may be empty. */
	readonly centerline: readonly TargetPoint[];
	/** Corridor bend points alone, for their own marker — a subset of `centerline`. */
	readonly bends: readonly TargetPoint[];
	/** Crop rectangle in target-image pixels, already clamped to the target image bounds. */
	readonly crop: CropRect;
	/** The full (uncropped) target image's own pixel dimensions. */
	readonly targetWidthPx: number;
	readonly targetHeightPx: number;
}

/** Padding around a hole's transformed points, as a fraction of its own bounding box. */
const CROP_PADDING_FRACTION = 0.2;
/** Floor so a hole with only a single point (e.g. tee alone) still gets a sensible frame. */
const MIN_CROP_PADDING_PX = 40;

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * Plans one hole's clean graphic: transforms every present feature point into
 * target-image pixels and derives a padded crop rectangle, clamped to the
 * target image's own bounds. Returns null for a hole with no placed features
 * at all — there's nothing to frame. The crop frame itself is intentionally
 * driven only by tee/basket/shots/corridorBand (unchanged from before
 * centerline/bends were added as renderable fields): the corridor band, when
 * present, already encloses every bend on its centerline, so a bends-only
 * hole with no tee or basket still correctly plans to null.
 */
export function planHoleGraphic(
	hole: AnnotatedHole,
	transform: SerializableTransform,
	targetWidthPx: number,
	targetHeightPx: number
): HoleGraphicPlan | null {
	const tee = hole.tee ? applyTransform(hole.tee, transform) : null;
	const basket = hole.basket ? applyTransform(hole.basket, transform) : null;
	const shots = hole.shots.map((shot) => applyTransform(shot.landing, transform));
	const corridor = deriveCorridorBand(hole)?.map((point) => applyTransform(point, transform)) ?? null;
	const centerline = deriveCorridorCenterline(hole).map((point) => applyTransform(point, transform));
	const bends = hole.corridorBends.map((point) => applyTransform(point, transform));

	const points: TargetPoint[] = [
		...(tee ? [tee] : []),
		...(basket ? [basket] : []),
		...shots,
		...(corridor ?? [])
	];
	if (points.length === 0) return null;

	const minX = Math.min(...points.map((point) => point.xPx));
	const maxX = Math.max(...points.map((point) => point.xPx));
	const minY = Math.min(...points.map((point) => point.yPx));
	const maxY = Math.max(...points.map((point) => point.yPx));
	const paddingX = Math.max(MIN_CROP_PADDING_PX, (maxX - minX) * CROP_PADDING_FRACTION);
	const paddingY = Math.max(MIN_CROP_PADDING_PX, (maxY - minY) * CROP_PADDING_FRACTION);

	const rawX = minX - paddingX;
	const rawY = minY - paddingY;
	const rawRight = maxX + paddingX;
	const rawBottom = maxY + paddingY;

	const cropX = clamp(rawX, 0, targetWidthPx);
	const cropY = clamp(rawY, 0, targetHeightPx);
	const cropRight = clamp(rawRight, cropX, targetWidthPx);
	const cropBottom = clamp(rawBottom, cropY, targetHeightPx);

	return {
		holeId: hole.id,
		number: hole.number,
		par: hole.par,
		tee,
		basket,
		shots,
		corridorBand: corridor,
		centerline,
		bends,
		crop: {
			xPx: cropX,
			yPx: cropY,
			widthPx: Math.max(cropRight - cropX, 1),
			heightPx: Math.max(cropBottom - cropY, 1)
		},
		targetWidthPx,
		targetHeightPx
	};
}

function pointsAttr(points: readonly TargetPoint[]): string {
	return points.map((point) => `${point.xPx},${point.yPx}`).join(' ');
}

function escapeAttr(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Renders the info card in the crop's top-left corner: "HOLE n" always, then
 * "PAR p" and, when a real-world ground scale (`feetPerPixel`) is supplied,
 * the hole's straight-line length and remaining distance to the pin.
 */
function buildInfoCard(plan: HoleGraphicPlan, style: GraphicStyle, feetPerPixel: number | undefined): string {
	const lines = [`Hole ${plan.number}`];
	if (plan.par !== undefined) lines.push(`Par ${plan.par}`);
	if (feetPerPixel !== undefined) {
		const { lengthFt, distanceToPinFt } = computeHoleDistances(plan, feetPerPixel);
		if (lengthFt !== null) lines.push(`${Math.round(lengthFt)} ft`);
		if (distanceToPinFt !== null) lines.push(`${Math.round(distanceToPinFt)} ft to pin`);
	}

	const { crop } = plan;
	const fontSize = 20;
	const lineHeight = fontSize + 6;
	const paddingX = 10;
	const paddingY = 6;
	const cardWidth = Math.max(...lines.map((line) => 12 + line.length * 11)) + paddingX;
	const cardHeight = lines.length * lineHeight + paddingY;
	const cardX = crop.xPx + 6;
	const cardY = crop.yPx + 6;

	const parts = [
		`<rect x="${cardX}" y="${cardY}" width="${cardWidth}" height="${cardHeight}" fill="${escapeAttr(style.cardBackground)}" stroke="${escapeAttr(style.cardBorder)}" stroke-width="2" />`
	];
	lines.forEach((line, index) => {
		const textY = cardY + paddingY + index * lineHeight + fontSize;
		parts.push(
			`<text x="${cardX + paddingX / 2}" y="${textY}" font-family="system-ui, sans-serif" font-weight="bold" font-size="${fontSize}" fill="${escapeAttr(style.cardText)}">${escapeAttr(line)}</text>`
		);
	});
	return parts.join('');
}

/**
 * Builds one hole's clean graphic as self-contained SVG markup: the target
 * image cropped via `viewBox` (the full image is placed at its own pixel
 * size; the viewport does the cropping, so no pixel-copy step is needed),
 * the derived corridor band, centerline, bend markers, straight
 * tee-through-shots displacement guides (never a curved flight path — an
 * explicit non-goal), tee/basket/shot markers, and an info card. Every
 * themeable color comes from `style` (a `GraphicStyle` preset, see
 * `graphics/style.ts`), defaulting to `DEFAULT_GRAPHIC_STYLE`. `feetPerPixel`
 * (see `naipMetersPerPixel`/`metersToFeet`) adds real-world hole length and
 * distance-to-pin to the info card when the caller has a known ground scale;
 * omit it to leave those lines off.
 *
 * Styling is inlined (not CSS classes) so the markup rasterizes correctly
 * standalone — e.g. via a `data:image/svg+xml` URI — without depending on an
 * external stylesheet being available in that context.
 */
export function buildHoleGraphicMarkup(
	plan: HoleGraphicPlan,
	targetImageHref: string,
	style: GraphicStyle = DEFAULT_GRAPHIC_STYLE,
	feetPerPixel?: number
): string {
	const { crop } = plan;
	const parts: string[] = [];
	parts.push(
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${crop.xPx} ${crop.yPx} ${crop.widthPx} ${crop.heightPx}" width="${crop.widthPx}" height="${crop.heightPx}">`
	);
	parts.push(
		`<image href="${escapeAttr(targetImageHref)}" x="0" y="0" width="${plan.targetWidthPx}" height="${plan.targetHeightPx}" preserveAspectRatio="xMidYMid meet" />`
	);

	if (plan.corridorBand && plan.corridorBand.length >= 3) {
		parts.push(
			`<polygon points="${pointsAttr(plan.corridorBand)}" fill="${escapeAttr(style.pathColor)}" fill-opacity="0.25" stroke="${escapeAttr(style.pathColor)}" stroke-width="2" />`
		);
	}

	if (plan.centerline.length >= 2) {
		parts.push(
			`<polyline points="${pointsAttr(plan.centerline)}" fill="none" stroke="${escapeAttr(style.pathHaloColor)}" stroke-width="1.5" stroke-dasharray="6 4" />`
		);
	}

	for (const bend of plan.bends) {
		parts.push(
			`<circle cx="${bend.xPx}" cy="${bend.yPx}" r="6" fill="${escapeAttr(style.pathColor)}" stroke="${escapeAttr(style.markerHaloColor)}" stroke-width="1.5" />`
		);
	}

	const guidePoints = [...(plan.tee ? [plan.tee] : []), ...plan.shots];
	if (guidePoints.length >= 2) {
		parts.push(
			`<polyline points="${pointsAttr(guidePoints)}" fill="none" stroke="${escapeAttr(style.pathColor)}" stroke-width="2" stroke-dasharray="6 4" />`
		);
	}

	for (const shot of plan.shots) {
		parts.push(
			`<circle cx="${shot.xPx}" cy="${shot.yPx}" r="8" fill="${escapeAttr(style.shotColor)}" stroke="${escapeAttr(style.shotStrokeColor)}" stroke-width="1.5" />`
		);
	}
	if (plan.tee) {
		parts.push(
			`<circle cx="${plan.tee.xPx}" cy="${plan.tee.yPx}" r="8" fill="${escapeAttr(style.teeColor)}" stroke="${escapeAttr(style.markerHaloColor)}" stroke-width="1.5" />`
		);
	}
	if (plan.basket) {
		parts.push(
			`<circle cx="${plan.basket.xPx}" cy="${plan.basket.yPx}" r="8" fill="${escapeAttr(style.basketColor)}" stroke="${escapeAttr(style.markerHaloColor)}" stroke-width="1.5" />`
		);
	}

	parts.push(buildInfoCard(plan, style, feetPerPixel));

	parts.push('</svg>');
	return parts.join('');
}

export interface LoadedImageSize {
	readonly width: number;
	readonly height: number;
}

export interface HoleGraphicRenderEnv {
	createCanvas(): HTMLCanvasElement;
	toBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob | null>;
	/** Decodes an image URL (including a `data:image/svg+xml` URI) into something `drawImage` accepts. */
	loadImage(url: string): Promise<CanvasImageSource & LoadedImageSize>;
}

export const defaultHoleGraphicRenderEnv: HoleGraphicRenderEnv = {
	createCanvas() {
		return document.createElement('canvas');
	},
	toBlob(canvas, type) {
		return new Promise((resolve, reject) => {
			canvas.toBlob((blob) => {
				if (blob) resolve(blob);
				else reject(new Error('Hole graphic PNG encoding failed. Try again.'));
			}, type);
		});
	},
	loadImage(url) {
		return new Promise((resolve, reject) => {
			const image = new Image();
			image.onload = () => resolve(image);
			image.onerror = () => reject(new Error('Could not rasterize the hole graphic for PNG export.'));
			image.src = url;
		});
	}
};

/**
 * Renders one hole's clean graphic to a PNG blob by rasterizing the exact
 * markup `buildHoleGraphicMarkup` produces — the same markup a live DOM
 * preview would show — through an offscreen image decode and canvas draw.
 */
export async function renderHoleGraphicPng(
	targetImageHref: string,
	plan: HoleGraphicPlan,
	env: HoleGraphicRenderEnv = defaultHoleGraphicRenderEnv,
	style: GraphicStyle = DEFAULT_GRAPHIC_STYLE,
	feetPerPixel?: number
): Promise<Blob> {
	const markup = buildHoleGraphicMarkup(plan, targetImageHref, style, feetPerPixel);
	const svgUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
	const image = await env.loadImage(svgUrl);

	const canvas = env.createCanvas();
	canvas.width = plan.crop.widthPx;
	canvas.height = plan.crop.heightPx;
	const context = canvas.getContext('2d');
	if (!context) throw new Error('Could not allocate a canvas for the hole graphic.');
	context.drawImage(image, 0, 0, plan.crop.widthPx, plan.crop.heightPx);

	const blob = await env.toBlob(canvas, 'image/png');
	if (!blob) throw new Error('Hole graphic PNG encoding failed. Try again.');
	return blob;
}

export interface HoleGraphicPngEntry {
	readonly number: number;
	readonly blob: Blob;
}

/**
 * Zips a batch of already-rendered hole PNGs into one archive, named
 * `hole-01.png`, `hole-02.png`, etc. Pure packaging — callers render each
 * blob (e.g. via `renderHoleGraphicPng`) themselves first.
 */
export async function zipHoleGraphics(entries: readonly HoleGraphicPngEntry[]): Promise<Blob> {
	const { zipSync } = await import('fflate');
	const files: Record<string, Uint8Array> = {};
	for (const entry of entries) {
		const fileName = `hole-${String(entry.number).padStart(2, '0')}.png`;
		files[fileName] = new Uint8Array(await entry.blob.arrayBuffer());
	}
	const zipBytes = zipSync(files, { level: 6 });
	return new Blob([zipBytes as BlobPart], { type: 'application/zip' });
}
