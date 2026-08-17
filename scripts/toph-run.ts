/**
 * Toph first-loss runner: runs the instrumented P1 pass (detectRawObjectMask)
 * on one course image, then answers, for every ground-truth tee and basket,
 * "where did this object's evidence first disappear?" — the DESIGN.md
 * headline query, executed against the recorded trace instead of by
 * archaeology.
 *
 * Ground truth is a chainspot corpus annotation JSON (schemaVersion 1,
 * holes[].tee/basket in source pixels — the same schema the app exports).
 *
 * Usage:
 *   npx tsx scripts/toph-run.ts --image <img> --truth <annotation.json> \
 *     [--out <traceDir>] [--tuning <json-file-or-inline>] [--json]
 *
 * Match tolerance follows the corpus-benchmark convention of being
 * scale-relative: 0.75 × detected badge median height, clamped to [10, 26]px
 * (annotation clicks are pad-center approximations, not pixel-exact).
 */
import { readFileSync } from 'node:fs';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import {
	detectRawObjectMask,
	RAW_MASK_TUNING_DEFAULTS,
	type RawMaskTuning
} from '../src/lib/autoAnnotation/rawObjectMask';
import { proposeSingleImageCrop } from '../src/lib/stitch/autoCrop';
import { RecordingTrace, type AssetRecord, type EntityRecord } from './toph/record';

interface TruthPoint {
	readonly hole: number;
	readonly kind: 'tee' | 'basket';
	readonly xPx: number;
	readonly yPx: number;
}

export interface FirstLoss {
	readonly hole: number;
	readonly kind: 'tee' | 'basket';
	readonly outcome: 'detected' | 'lost';
	/** Detected: distance to emitted object. Lost: stage/gate of first loss. */
	readonly distancePx?: number;
	readonly lossStage?: string;
	readonly lossGate?: string;
	readonly detail?: string;
}

export function decodeImage(path: string): { rgba: Uint8ClampedArray; widthPx: number; heightPx: number } {
	const raw = readFileSync(path);
	if (/\.png$/i.test(path)) {
		const png = PNG.sync.read(raw);
		return {
			rgba: new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.byteLength),
			widthPx: png.width,
			heightPx: png.height
		};
	}
	const decoded = jpeg.decode(raw, { useTArray: true, maxMemoryUsageInMB: 2048 });
	return {
		rgba: new Uint8ClampedArray(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength),
		widthPx: decoded.width,
		heightPx: decoded.height
	};
}

export function loadTruths(path: string): { truths: TruthPoint[]; sourceWidthPx: number; sourceHeightPx: number } {
	const doc = JSON.parse(readFileSync(path, 'utf8'));
	const truths: TruthPoint[] = [];
	for (const hole of doc.holes ?? []) {
		if (hole.tee) truths.push({ hole: hole.number, kind: 'tee', xPx: hole.tee.xPx, yPx: hole.tee.yPx });
		if (hole.basket)
			truths.push({ hole: hole.number, kind: 'basket', xPx: hole.basket.xPx, yPx: hole.basket.yPx });
	}
	return {
		truths,
		sourceWidthPx: doc.sourceImage?.widthPx ?? 0,
		sourceHeightPx: doc.sourceImage?.heightPx ?? 0
	};
}

/**
 * Production intake runs the single-image chrome autocrop before any CV
 * (ImageEditorPane -> detectSingleImageCrop -> proposeSingleImageCrop);
 * annotations are made in that cropped frame. Reproduce it here: crop
 * analysis runs at max dim 4096, so phone screenshots are analyzed at
 * scale 1 and the AnalysisRaster is just BT.601 grayscale of the full image.
 * The proposed insets must reproduce the annotation's source dimensions
 * exactly (validated by the caller) — otherwise truth coordinates would
 * silently land in the wrong frame.
 */
export function autocropLikeIntake(raster: {
	rgba: Uint8ClampedArray;
	widthPx: number;
	heightPx: number;
}): { rgba: Uint8ClampedArray; widthPx: number; heightPx: number; topPx: number; bottomPx: number } {
	const { rgba, widthPx, heightPx } = raster;
	const gray = new Uint8Array(widthPx * heightPx);
	for (let i = 0, j = 0; j < gray.length; i += 4, j += 1) {
		gray[j] = (rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114 + 0.5) | 0;
	}
	const proposal = proposeSingleImageCrop({ widthPx, heightPx, gray, scale: 1 });
	const topPx = proposal.insets?.topPx ?? 0;
	const bottomPx = proposal.insets?.bottomPx ?? 0;
	if (topPx === 0 && bottomPx === 0) return { rgba, widthPx, heightPx, topPx, bottomPx };
	const croppedHeight = heightPx - topPx - bottomPx;
	const cropped = new Uint8ClampedArray(widthPx * croppedHeight * 4);
	cropped.set(rgba.subarray(topPx * widthPx * 4, (topPx + croppedHeight) * widthPx * 4));
	return { rgba: cropped, widthPx, heightPx: croppedHeight, topPx, bottomPx };
}

/** Nearest bright-mask component to a truth point: exact labelmap hit first, then a radius scan. */
function componentNear(
	trace: RecordingTrace,
	labels: AssetRecord,
	xPx: number,
	yPx: number,
	radiusPx: number
): { entity: EntityRecord; distancePx: number } | undefined {
	const cx = Math.round(xPx);
	const cy = Math.round(yPx);
	const direct = trace.labelAt(labels, cx, cy);
	if (direct !== 0) {
		const entity = trace.entityForLabel(labels.id, direct);
		if (entity) return { entity, distancePx: 0 };
	}
	let best: { entity: EntityRecord; distancePx: number } | undefined;
	const r = Math.ceil(radiusPx);
	for (let dy = -r; dy <= r; dy += 1) {
		for (let dx = -r; dx <= r; dx += 1) {
			const d = Math.hypot(dx, dy);
			if (d > radiusPx || (best && d >= best.distancePx)) continue;
			const label = trace.labelAt(labels, cx + dx, cy + dy);
			if (label === 0) continue;
			const entity = trace.entityForLabel(labels.id, label);
			if (entity) best = { entity, distancePx: d };
		}
	}
	return best;
}

function hsvAt(
	rgba: Uint8ClampedArray,
	widthPx: number,
	xPx: number,
	yPx: number
): { value: number; saturation: number } {
	const offset = (Math.round(yPx) * widthPx + Math.round(xPx)) * 4;
	const r = rgba[offset];
	const g = rgba[offset + 1];
	const b = rgba[offset + 2];
	const max = r > g ? (r > b ? r : b) : g > b ? g : b;
	const min = r < g ? (r < b ? r : b) : g < b ? g : b;
	return { value: max, saturation: max === 0 ? 0 : Math.round(((max - min) * 255) / max) };
}

/**
 * Family-aware first loss: a tee truth is judged only by the tee-family
 * stages, a basket truth only by the basket stages. A component rejected by
 * the OTHER family's gates is expected, not a loss (a real tee should fail
 * basket gates); reporting the first rejection across all stages misattributes
 * nearly every truth.
 */
function firstLossFor(
	trace: RecordingTrace,
	entity: EntityRecord,
	kind: 'tee' | 'basket'
): { stage: string; gate?: string; detail?: string } | undefined {
	const relevantStage = (stageId: number): boolean => {
		const name = trace.stageName(stageId);
		return kind === 'tee' ? name === 'p1.teeFamily' : name === 'p1.basketShapePool';
	};
	const events = trace.eventsFor(entity.id).filter((ev) => 'stage' in ev && relevantStage(ev.stage));
	for (const ev of events) {
		if (ev.t === 'decide' && ev.outcome === 'rejected') {
			const check = events.find((e) => e.t === 'check' && e.name === ev.at && !e.pass);
			const detail =
				check && check.t === 'check' && check.value !== undefined
					? `${check.value.toFixed(2)} vs [${check.min?.toFixed(2) ?? '-inf'}, ${check.max?.toFixed(2) ?? 'inf'}]`
					: undefined;
			return { stage: trace.stageName(ev.stage), gate: ev.at, detail };
		}
	}
	if (kind === 'basket') {
		// Survived the pool gates: fate is the consensus select.
		const selectFate = trace.selectFateOf(entity.id);
		if (selectFate && !selectFate.kept) return { stage: selectFate.name, gate: 'sizeConsensus' };
		if (selectFate?.kept) return { stage: 'p1.basketFamily', gate: 'kept-but-farther-than-tolerance' };
		return { stage: 'p1.basketShapePool', detail: 'no basket-stage events recorded' };
	}
	if (events.length === 0) {
		// The tee filter never evaluated this component: scale references failed.
		return { stage: 'p1.teeFamily', gate: 'teeScaleReferences' };
	}
	return { stage: 'p1.teeFamily', gate: 'kept-but-farther-than-tolerance' };
}

export function analyzeCourse(
	imagePath: string,
	truthPath: string,
	tuning?: Partial<RawMaskTuning>,
	outDir?: string
): {
	losses: FirstLoss[];
	falsePositives: { kind: 'tee' | 'basket'; xPx: number; yPx: number }[];
	tolerancePx: number;
	counts: Record<string, number>;
} {
	const decoded = decodeImage(imagePath);
	const { truths, sourceWidthPx, sourceHeightPx } = loadTruths(truthPath);
	let raster: { rgba: Uint8ClampedArray; widthPx: number; heightPx: number } = decoded;
	if (
		sourceWidthPx &&
		sourceHeightPx &&
		(decoded.widthPx !== sourceWidthPx || decoded.heightPx !== sourceHeightPx)
	) {
		const cropped = autocropLikeIntake(decoded);
		if (cropped.widthPx !== sourceWidthPx || cropped.heightPx !== sourceHeightPx) {
			throw new Error(
				`frame mismatch: image ${decoded.widthPx}x${decoded.heightPx} autocrops to ` +
					`${cropped.widthPx}x${cropped.heightPx} (top ${cropped.topPx}, bottom ${cropped.bottomPx}) ` +
					`but the annotation was made on ${sourceWidthPx}x${sourceHeightPx}`
			);
		}
		raster = cropped;
	}
	const trace = new RecordingTrace('p1.rawObjectMask');
	const result = detectRawObjectMask(raster, trace, tuning);
	if (outDir) trace.finish(outDir);

	const badgeMedianHeight =
		result.badges.length > 0
			? [...result.badges.map((b) => b.heightPx)].sort((a, b) => a - b)[
					Math.floor(result.badges.length / 2)
				]
			: 0;
	const tolerancePx = Math.min(26, Math.max(10, badgeMedianHeight * 0.75));

	const brightLabels = trace.assetByName('brightLabels');
	if (!brightLabels) throw new Error('trace has no brightLabels asset');

	const losses: FirstLoss[] = [];
	for (const truth of truths) {
		const emitted = truth.kind === 'tee' ? result.tees : result.baskets;
		let bestDistance = Infinity;
		for (const object of emitted) {
			// Baskets match on the emitted anchor (xPx, yPx = icon bottom tip):
			// that is the physical basket point the annotation click marks.
			bestDistance = Math.min(
				bestDistance,
				Math.hypot(object.xPx - truth.xPx, object.yPx - truth.yPx)
			);
		}
		if (bestDistance <= tolerancePx) {
			losses.push({ hole: truth.hole, kind: truth.kind, outcome: 'detected', distancePx: bestDistance });
			continue;
		}

		const near = componentNear(trace, brightLabels, truth.xPx, truth.yPx, tolerancePx);
		if (!near) {
			const { value, saturation } = hsvAt(raster.rgba, raster.widthPx, truth.xPx, truth.yPx);
			const p = { ...RAW_MASK_TUNING_DEFAULTS, ...tuning };
			losses.push({
				hole: truth.hole,
				kind: truth.kind,
				outcome: 'lost',
				lossStage: 'p1.masks',
				lossGate: 'brightMask',
				detail: `pixel value/sat ${value}/${saturation} vs required >${p.brightValueMin}/<${p.brightSaturationMax}`
			});
			continue;
		}

		const loss = firstLossFor(trace, near.entity, truth.kind);
		losses.push({
			hole: truth.hole,
			kind: truth.kind,
			outcome: 'lost',
			lossStage: loss?.stage ?? 'kept-as-other-family',
			lossGate: loss?.gate,
			detail:
				(loss?.detail ?? '') +
				(near.distancePx > 0 ? ` (component ${near.distancePx.toFixed(1)}px from click)` : '')
		});
	}

	const falsePositives: { kind: 'tee' | 'basket'; xPx: number; yPx: number }[] = [];
	for (const kind of ['tee', 'basket'] as const) {
		const emitted = kind === 'tee' ? result.tees : result.baskets;
		for (const object of emitted) {
			const matched = truths.some(
				(truth) =>
					truth.kind === kind &&
					Math.hypot(object.xPx - truth.xPx, object.yPx - truth.yPx) <= tolerancePx
			);
			if (!matched) falsePositives.push({ kind, xPx: object.xPx, yPx: object.yPx });
		}
	}

	const counts: Record<string, number> = {
		teeTruths: truths.filter((t) => t.kind === 'tee').length,
		teeDetected: losses.filter((l) => l.kind === 'tee' && l.outcome === 'detected').length,
		teeFalsePositives: falsePositives.filter((f) => f.kind === 'tee').length,
		basketTruths: truths.filter((t) => t.kind === 'basket').length,
		basketDetected: losses.filter((l) => l.kind === 'basket' && l.outcome === 'detected').length,
		basketFalsePositives: falsePositives.filter((f) => f.kind === 'basket').length
	};

	return { losses, falsePositives, tolerancePx, counts };
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
	const args: Record<string, string | boolean> = {};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (!arg.startsWith('--')) continue;
		const key = arg.slice(2);
		const next = argv[i + 1];
		if (next && !next.startsWith('--')) {
			args[key] = next;
			i += 1;
		} else {
			args[key] = true;
		}
	}
	return args;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const image = args.image as string;
	const truth = args.truth as string;
	if (!image || !truth) {
		console.error('Usage: npx tsx scripts/toph-run.ts --image <img> --truth <annotation.json> [--out dir] [--tuning json] [--json]');
		process.exit(1);
	}
	let tuning: Partial<RawMaskTuning> | undefined;
	if (typeof args.tuning === 'string') {
		const text = args.tuning.trim().startsWith('{') ? args.tuning : readFileSync(args.tuning, 'utf8');
		tuning = JSON.parse(text);
	}

	const analysis = analyzeCourse(image, truth, tuning, typeof args.out === 'string' ? args.out : undefined);

	if (args.json) {
		console.log(JSON.stringify(analysis, null, 2));
		return;
	}
	const { counts, tolerancePx } = analysis;
	console.log(`tolerance ${tolerancePx.toFixed(1)}px`);
	console.log(
		`tees    ${counts.teeDetected}/${counts.teeTruths} detected, ${counts.teeFalsePositives} FP`
	);
	console.log(
		`baskets ${counts.basketDetected}/${counts.basketTruths} detected, ${counts.basketFalsePositives} FP`
	);
	for (const loss of analysis.losses.filter((l) => l.outcome === 'lost')) {
		console.log(
			`  LOST ${loss.kind} H${loss.hole}: ${loss.lossStage}${loss.lossGate ? ` @ ${loss.lossGate}` : ''}${loss.detail ? ` — ${loss.detail}` : ''}`
		);
	}
}

const invokedDirectly = process.argv[1]?.endsWith('toph-run.ts');
if (invokedDirectly) {
	main().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}
