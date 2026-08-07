/**
 * ChainSpot clean hole graphic construction.
 *
 * Applies an estimated source-to-target transform (`src/lib/alignment`) to a
 * hole's manually-annotated tee/basket/shot/corridor points (source-image
 * pixels), producing their positions in the clean target image's pixel
 * space, then frames and renders a crop around them. No feature detection or
 * image analysis happens here — every point was already placed by the user
 * (or, in a future iteration, a reviewed CV proposal); this module only ever
 * does arithmetic and drawing, the same "structured geometry, not edited
 * screenshots" boundary the rest of the domain layer keeps.
 */
import { applyTransform } from './alignment/transform';
import type { SerializableTransform } from './alignment/types';
import type { AnnotatedHole } from './domain/annotatedRound';

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
	readonly tee: TargetPoint | null;
	readonly basket: TargetPoint | null;
	readonly shots: readonly TargetPoint[];
	/** Present only when the source hole had at least one corridor vertex — never a synthesized shape. */
	readonly corridor: readonly TargetPoint[] | null;
	/** Crop rectangle in target-image pixels, already clamped to the target image bounds. */
	readonly crop: CropRect;
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
 * at all — there's nothing to frame.
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
	const corridor = hole.corridor ? hole.corridor.map((point) => applyTransform(point, transform)) : null;

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
		tee,
		basket,
		shots,
		corridor,
		crop: {
			xPx: cropX,
			yPx: cropY,
			widthPx: Math.max(cropRight - cropX, 1),
			heightPx: Math.max(cropBottom - cropY, 1)
		}
	};
}

export interface HoleGraphicRenderEnv {
	createCanvas(): HTMLCanvasElement;
	toBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob | null>;
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
	}
};

/**
 * Renders one hole's clean graphic: the cropped clean-image region, the
 * corridor polygon (if any), straight tee-through-shots displacement guides
 * (never a curved flight path — an explicit non-goal), tee/basket/shot
 * markers, and a hole-number label.
 */
export async function renderHoleGraphic(
	targetImage: HTMLImageElement,
	plan: HoleGraphicPlan,
	env: HoleGraphicRenderEnv = defaultHoleGraphicRenderEnv
): Promise<Blob> {
	const canvas = env.createCanvas();
	const context = canvas.getContext('2d');
	if (!context) throw new Error('Could not allocate a canvas for the hole graphic.');
	canvas.width = plan.crop.widthPx;
	canvas.height = plan.crop.heightPx;

	context.drawImage(
		targetImage,
		plan.crop.xPx,
		plan.crop.yPx,
		plan.crop.widthPx,
		plan.crop.heightPx,
		0,
		0,
		plan.crop.widthPx,
		plan.crop.heightPx
	);

	const toLocal = (point: TargetPoint): { x: number; y: number } => ({
		x: point.xPx - plan.crop.xPx,
		y: point.yPx - plan.crop.yPx
	});

	if (plan.corridor && plan.corridor.length >= 3) {
		context.beginPath();
		plan.corridor.forEach((point, index) => {
			const local = toLocal(point);
			if (index === 0) context.moveTo(local.x, local.y);
			else context.lineTo(local.x, local.y);
		});
		context.closePath();
		context.fillStyle = 'rgba(42, 109, 244, 0.25)';
		context.fill();
		context.strokeStyle = 'rgba(42, 109, 244, 0.9)';
		context.lineWidth = 2;
		context.stroke();
	}

	const guidePoints = [...(plan.tee ? [plan.tee] : []), ...plan.shots];
	if (guidePoints.length >= 2) {
		context.beginPath();
		guidePoints.forEach((point, index) => {
			const local = toLocal(point);
			if (index === 0) context.moveTo(local.x, local.y);
			else context.lineTo(local.x, local.y);
		});
		context.strokeStyle = 'rgba(255, 255, 255, 0.85)';
		context.lineWidth = 2;
		context.setLineDash([6, 4]);
		context.stroke();
		context.setLineDash([]);
	}

	const drawMarker = (point: TargetPoint | null, fill: string): void => {
		if (!point) return;
		const local = toLocal(point);
		context.beginPath();
		context.arc(local.x, local.y, 8, 0, Math.PI * 2);
		context.fillStyle = fill;
		context.fill();
		context.strokeStyle = '#000';
		context.lineWidth = 1.5;
		context.stroke();
	};
	drawMarker(plan.tee, '#22c55e');
	drawMarker(plan.basket, '#ef4444');
	plan.shots.forEach((point) => drawMarker(point, '#f59e0b'));

	const label = `Hole ${plan.number}`;
	context.font = 'bold 20px system-ui, sans-serif';
	const labelWidth = context.measureText(label).width;
	context.fillStyle = 'rgba(0, 0, 0, 0.6)';
	context.fillRect(6, 6, labelWidth + 12, 28);
	context.fillStyle = '#fff';
	context.fillText(label, 12, 26);

	const blob = await env.toBlob(canvas, 'image/png');
	if (!blob) throw new Error('Hole graphic PNG encoding failed. Try again.');
	return blob;
}
