// Trace-driven, FEATURE-owned rendering.
//
// The other renderer path in this directory (rendererContract.ts +
// artifactIo.ts) keys on ArtifactKind. That dispatch hands a renderer ONE
// artifact and tells it nothing about which feature produced it or why, so
// it can draw "a mask" and never "g3.endpoints' rejected tee candidates
// over the bright mask it rejected them on". Both paths stay: the
// kind-keyed one owns raw bytes, this one owns meaning. Nothing here
// modifies, imports, or depends on rendererContract.ts/artifactIo.ts.
//
// What this module does, in one sentence: walk RunTrace.units, resolve each
// unit to the ABFeature(s) that own it, and call ABFeature.render.draw()
// when the feature declared one.
//
// LAB's hard rule still applies -- this file NEVER recomputes detector data.
// Every coordinate it draws was already in the trace; every number in a
// receipt is either read straight off the trace or is a count of trace
// entries, and says which. Where a number is not available it prints a loud
// UNKNOWN with the reason, per the repo rule "every number ships with where
// it came from, or a loud UNKNOWN".

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { PNG } from 'pngjs';
import { OPERATION_UNIVERSE } from '@chainspot/alg/exec';
import { ALL_FEATURES } from '@chainspot/alg/detectors/threeFactor/features/registry';
import type {
	ABFeature,
	Drawable,
	FeatureRender,
	FeatureRenderPlan,
	RunTrace,
	UnitTrace
} from '@chainspot/alg/detectors/threeFactor/features/types';
import type { GateScore, GroundingComparison, TruthScoreboard } from './truthScoring';

// ---------------------------------------------------------------------------
// unit id -> feature id, read off the compiled operation universe.
//
// This mapping is NOT guessable from the trace alone and is NOT hardcoded
// here. OperationSpec (packages/alg/src/exec/contract.ts) already declares
// both `unit` ("owning engine unit") and `features` ("ABFeature ids this
// operation reads enabled/knobs from"), and OPERATION_UNIVERSE
// (operations.ts) is the exported list of every spec. So the association
// LAB needs already exists in the algorithm and is simply read here.
//
// It matters because a unit id is NOT a feature id: g3.endpoints' drawables
// land on the trace unit called 'tees'. Anything that assumes
// featureById(unit.id) silently renders nothing for the one feature where
// the rejections live.
// ---------------------------------------------------------------------------

export function featureIdsForUnit(unitId: string): readonly string[] {
	const ids = new Set<string>();
	for (const op of OPERATION_UNIVERSE) {
		if (op.unit !== unitId) continue;
		for (const featureId of op.features ?? []) ids.add(featureId);
	}
	return [...ids].sort();
}

/**
 * Features whose `render` is written but not yet landed in the feature's own
 * source file.
 *
 * This exists for exactly one reason: the reference implementation below
 * belongs in
 * packages/alg/src/detectors/threeFactor/features/g3.endpoints.ts as
 * `render: ENDPOINTS_RENDER`, a two-line diff, and that file is owned by a
 * different concern right now. Attaching it here is a decoration, not a
 * mutation -- g3EndpointsFeature is never modified, and the walker prefers
 * `feature.render` whenever it is present, so this table goes dead the
 * moment the two-line diff lands. Keep it EMPTY once that happens; it is
 * scaffolding, not an extension point.
 */
export const PENDING_FEATURE_RENDERS: Readonly<Record<string, FeatureRender>> = {
	get endpoints() {
		return ENDPOINTS_RENDER;
	}
};

function renderFor(feature: ABFeature): FeatureRender | undefined {
	return feature.render ?? PENDING_FEATURE_RENDERS[feature.id];
}

// ---------------------------------------------------------------------------
// The reference render: g3.endpoints.
//
// Chosen because it is where the rejections live. G3's tee unit is the only
// place in the algorithm that examines a candidate, kills it, and (per
// features/types.ts's "no silent drops" rule) leaves a rejected drawable
// with a reason. A kind-keyed renderer can never show that: the accepted
// tees ship as a `candidateSet` artifact and the rejected ones ship as
// nothing at all, because a rejection is not a board value. It is only ever
// a trace entry.
// ---------------------------------------------------------------------------

const ENDPOINTS_UNIT = 'tees';
/** Cross-gate: G2's accepted baskets. A tee suppressed for sitting near a
 * basket sprite is unreadable without the basket that suppressed it. */
const BASKETS_UNIT = 'baskets';
/** The raster these coordinates are evidence over. A NAME (an artifact id
 * from operations.ts's ARTIFACT_EXTRACTORS), never bytes -- resolving it to
 * a file stays with the kind-keyed path. */
const BRIGHT_MASK_ARTIFACT = 'badgeStage.masks.bright';

function verdictOf(drawables: readonly Drawable[], verdict: Drawable['verdict']): Drawable[] {
	return drawables.filter((d) => d.verdict === verdict);
}

function countByReason(drawables: readonly Drawable[]): Array<[string, number]> {
	const counts = new Map<string, number>();
	for (const d of drawables) {
		const reason =
			d.reason ?? '(no reason recorded -- violates features/types.ts "no silent drops")';
		counts.set(reason, (counts.get(reason) ?? 0) + 1);
	}
	return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** Reads the exact feature state resolved for this run. Unit ids and feature
 * ids differ, so UnitTrace.knobs cannot establish this provenance. */
function deviationNotes(run: RunTrace, unit: UnitTrace, featureId: string): string[] {
	const feature = ALL_FEATURES.find((candidate) => candidate.id === featureId);
	const state = run.features[featureId];
	if (!feature || !state) {
		return [
			`knobsDeviating: UNKNOWN -- resolved feature '${featureId}' is absent from RunTrace.features.`,
			`  Unit '${unit.id}' cannot prove which thresholds it used.`
		];
	}
	const knobNames = Object.keys(state.knobs);
	const deviating = knobNames.filter((name) => feature.knobs[name]?.default !== state.knobs[name]);
	if (deviating.length > 0) {
		return [
			`knobsDeviating: ${deviating.length} of ${knobNames.length} knob(s) DEVIATE from the feature's frozen default --`,
			...deviating.map(
				(name) =>
					`    ${name} = ${JSON.stringify(state.knobs[name])}  (source: RunTrace.features['${featureId}'].knobs['${name}'])`
			),
			`  => this run did NOT use frozen '${featureId}' thresholds. Read every rejection below against the deviated value, not the default.`
		];
	}
	return [
		`knobsDeviating: none -- all ${knobNames.length} knob(s) sit at feature '${featureId}'s frozen defaults`,
		`  (source: RunTrace.features['${featureId}'], compared directly with ABFeature.knobs defaults)`
	];
}

export const SPRITE_RENDER: FeatureRender = {
	units: [BASKETS_UNIT],
	draw(unit: UnitTrace, run: RunTrace): FeatureRenderPlan {
		const accepted = verdictOf(unit.drawables, 'accepted');
		const rejected = verdictOf(unit.drawables, 'rejected');
		const whiteBounds = verdictOf(unit.drawables, 'info').filter(
			(drawable) => drawable.type === 'box' && drawable.ref?.endsWith(':white-component')
		);
		const semanticTips = verdictOf(unit.drawables, 'info').filter(
			(drawable) => drawable.type === 'point' && drawable.ref?.endsWith(':semantic-tip')
		);
		const reasons = countByReason(rejected);
		const notes = [
			`feature:      sprite (g2.sprite) -- ${unit.gate}, trace unit '${unit.id}'`,
			`unit enabled: ${unit.enabled}  (source: UnitTrace.enabled)`,
			`config:       ${run.configName}`,
			`paramsHash:   ${run.paramsHash || 'UNKNOWN -- caller ran the engine without one'}`,
			`unit ms:      ${unit.ms.toFixed(2)}  (source: UnitTrace.ms; wall clock, not a quality signal)`,
			'',
			...deviationNotes(run, unit, 'sprite'),
			'',
			`accepted basket candidates: ${accepted.length}   (source: count of UnitTrace.drawables with verdict 'accepted')`,
			`rejected basket candidates: ${rejected.length}   (source: count of UnitTrace.drawables with verdict 'rejected')`,
			`examined renderer-family candidates: ${accepted.length + rejected.length}`,
			'',
			'candidate boundary: Pass 1 promotes connected bright components within the basket-family bbox',
			'  tolerance. Pass 2 promotes fine hypotheses only after they clear recoveryIdentityMin, inside',
			'  neighborhoods seeded by a known badge or accepted basket. Lower-scoring grid samples are search',
			'  measurements, not object candidates. Every promoted candidate is represented with its final decision.',
			'',
			'rejections by reason:'
		];
		if (reasons.length === 0) notes.push('  none');
		else
			for (const [reason, count] of reasons)
				notes.push(`  ${String(count).padStart(4)} x  ${reason}`);
		for (const measurement of unit.measurements) {
			notes.push(
				`measurement '${measurement.name}': n=${measurement.count} min=${measurement.min} max=${measurement.max} mean=${(measurement.sum / Math.max(1, measurement.count)).toFixed(4)}  (source: UnitTrace.measurements)`
			);
		}
		return {
			title: `g2.sprite -- basket candidates, accepted vs rejected (${run.configName})`,
			base: BRIGHT_MASK_ARTIFACT,
			layers: [
				{
					name: 'basket candidates rejected (G2)',
					note: 'renderer-family or seeded-recovery candidates rejected with measured testimony',
					drawables: rejected
				},
				{
					name: 'basket candidates accepted (G2)',
					note: 'the exact basket objects emitted to the evidence board',
					drawables: accepted
				},
				{
					name: 'basket white-component bounds (G2)',
					note: 'detector-local bright bounds; deliberately not the semantic object bbox',
					drawables: whiteBounds
				},
				{
					name: 'basket semantic endpoints (G2)',
					note: 'engine-emitted geometric endpoints; informational only, never ownership',
					drawables: semanticTips
				}
			],
			notes
		};
	}
};

export const ENDPOINTS_RENDER: FeatureRender = {
	units: [ENDPOINTS_UNIT],
	draw(unit: UnitTrace, run: RunTrace): FeatureRenderPlan {
		const accepted = verdictOf(unit.drawables, 'accepted');
		const rejected = verdictOf(unit.drawables, 'rejected');
		const info = verdictOf(unit.drawables, 'info');
		const baskets = run.units.find((u) => u.id === BASKETS_UNIT);
		const acceptedBaskets = verdictOf(baskets?.drawables ?? [], 'accepted');
		const reasons = countByReason(rejected);

		const notes: string[] = [
			`feature:      endpoints (g3.endpoints) -- ${unit.gate}, trace unit '${unit.id}'`,
			`unit enabled: ${unit.enabled}  (source: UnitTrace.enabled)`,
			`config:       ${run.configName}`,
			`paramsHash:   ${run.paramsHash || 'UNKNOWN -- caller ran the engine without one'}`,
			`unit ms:      ${unit.ms.toFixed(2)}  (source: UnitTrace.ms; wall clock, not a quality signal)`,
			'',
			...deviationNotes(run, unit, 'endpoints'),
			'',
			`accepted tee candidates: ${accepted.length}   (source: count of UnitTrace.drawables with verdict 'accepted')`,
			`rejected tee candidates: ${rejected.length}   (source: count of UnitTrace.drawables with verdict 'rejected')`,
			`info drawables:          ${info.length}`,
			`examined (accepted + rejected): ${accepted.length + rejected.length}`
		];

		if (rejected.length === 0) {
			notes.push(
				'',
				'WHAT THIS RUN COULD NOT SEE: no rejected drawable was recorded at all.',
				"  features/types.ts requires a rejected drawable per killed candidate ('no silent drops').",
				'  Zero rejections means EITHER nothing was killed, OR a suppression path is still',
				'  dropping candidates without recording them. This render cannot tell those apart --',
				'  it can only report that the trace is silent.'
			);
		} else {
			notes.push(
				'',
				'rejections by reason (each line is a candidate the algorithm examined and threw away):'
			);
			for (const [reason, count] of reasons)
				notes.push(`  ${String(count).padStart(4)} x  ${reason}`);
		}

		for (const measurement of unit.measurements) {
			notes.push(
				`measurement '${measurement.name}': n=${measurement.count} min=${measurement.min} max=${measurement.max} mean=${(measurement.sum / Math.max(1, measurement.count)).toFixed(4)}  (source: UnitTrace.measurements)`
			);
		}

		notes.push(
			'',
			`cross-gate layer: ${acceptedBaskets.length} accepted basket(s) from trace unit '${BASKETS_UNIT}'` +
				(baskets ? '' : ` -- UNIT ABSENT from this trace, layer is empty`),
			`  drawn because a tee killed for sitting near a basket sprite is unreadable without the basket.`,
			`base raster: '${BRIGHT_MASK_ARTIFACT}' (artifact id, not bytes). It is computed over the same`,
			`  G0 canonical raster as these coordinates. Original-source coordinates remain a truth-receipt concern`,
			`  because CROP/STITCH provenance lives in the G0 transform ledger, not in detector drawables.`
		);

		return {
			title: `g3.endpoints -- tee candidates, accepted vs rejected (${run.configName})`,
			base: BRIGHT_MASK_ARTIFACT,
			layers: [
				{
					name: 'baskets (G2, accepted)',
					note: `cross-gate context from unit '${BASKETS_UNIT}' -- why a nearby tee may have been suppressed`,
					drawables: acceptedBaskets
				},
				{
					name: 'tee candidates rejected (G3)',
					note: 'every candidate examined and killed, with the reason the algorithm recorded',
					drawables: rejected
				},
				{
					name: 'tee candidates accepted (G3)',
					note: 'what survived to the assignment gate',
					drawables: accepted
				},
				...(info.length > 0
					? [
							{
								name: 'tee candidates info (G3)',
								note: 'neither accepted nor rejected',
								drawables: info
							}
						]
					: [])
			],
			notes
		};
	}
};

// ---------------------------------------------------------------------------
// The walk.
// ---------------------------------------------------------------------------

export interface FeatureRenderCanvas {
	readonly widthPx: number;
	readonly heightPx: number;
	/** where the caller got these from, printed verbatim in the receipt */
	readonly source: string;
}

export interface FeatureRenderBase {
	/** stable suffix used in reusable filenames surfaced by LAB UI/scope */
	readonly id: string;
	/** absolute path to an already-rendered PNG (e.g. the kind-keyed mask
	 * renderer's output). This module never produces one. */
	readonly pngPath: string;
	/** offset from the base raster's origin to original-image origin. Caller
	 * supplied, never inferred; stated in the receipt. */
	readonly offsetXPx?: number;
	readonly offsetYPx?: number;
	readonly source: string;
}

export interface RenderTraceFeaturesInput {
	readonly run: RunTrace;
	readonly outDir: string;
	readonly canvas?: FeatureRenderCanvas;
	readonly bases?: readonly FeatureRenderBase[];
	readonly truthEvaluation?: {
		readonly scoreboard?: TruthScoreboard;
		readonly groundingComparisons: readonly GroundingComparison[];
	};
	/** canonical = original + offset; omitted for a stitched frame that cannot
	 * be mapped back to one unambiguous source image. */
	readonly sourceFrameOffset?: {
		readonly xPx: number;
		readonly yPx: number;
		readonly source: string;
	};
}

export interface FeatureRenderResult {
	readonly featureId: string;
	readonly unitId: string;
	readonly gate: string;
	readonly title: string;
	readonly drawableCount: number;
	readonly acceptedCount: number;
	readonly rejectedCount: number;
	readonly filesWritten: readonly string[];
	readonly receiptText: string;
	readonly summary: string;
	/** loud problems found while walking -- never swallowed */
	readonly warnings: readonly string[];
}

export interface RenderTraceFeaturesOutput {
	readonly results: readonly FeatureRenderResult[];
	/** units present in the trace that no feature offered to render */
	readonly unrenderedUnits: readonly string[];
	/** features that declared a render for a unit the trace never produced */
	readonly unmatchedRenders: readonly string[];
}

export function renderTraceFeatures(input: RenderTraceFeaturesInput): RenderTraceFeaturesOutput {
	const { run, outDir } = input;
	mkdirSync(outDir, { recursive: true });

	const results: FeatureRenderResult[] = [];
	const renderedUnitIds = new Set<string>();
	const declaredUnitIds = new Set<string>();
	const traceUnitIds = new Set(run.units.map((u) => u.id));

	for (const feature of ALL_FEATURES) {
		const render = renderFor(feature);
		if (!render) continue;
		for (const declared of render.units) {
			if (run.execution.includes(declared)) declaredUnitIds.add(declared);
		}
	}

	for (const unit of run.units) {
		for (const feature of ALL_FEATURES) {
			const render = renderFor(feature);
			if (!render || !render.units.includes(unit.id)) continue;

			// Self-check the seam rather than trusting it: the feature says it
			// renders this unit; the compiled op universe says which features
			// this unit's operations actually read knobs from. A disagreement
			// is a real finding (a renamed unit, a moved feature), so it is
			// printed, not swallowed.
			const warnings: string[] = [];
			const declaredByOps = featureIdsForUnit(unit.id);
			if (!declaredByOps.includes(feature.id)) {
				warnings.push(
					`SEAM MISMATCH: feature '${feature.id}' declares render.units including '${unit.id}', but ` +
						`OPERATION_UNIVERSE says unit '${unit.id}' reads features [${declaredByOps.join(', ') || 'none'}]. ` +
						`One of the two is stale. Rendering anyway, loudly.`
				);
			}
			if (feature.render === undefined) {
				warnings.push(
					`render attached from PENDING_FEATURE_RENDERS, not from the feature file. ` +
						`Land the FeatureRender beside feature '${feature.id}' and drop the entry.`
				);
			}

			const plan = render.draw(unit, run);
			results.push(writePlan(plan, feature, unit, input, warnings));
			renderedUnitIds.add(unit.id);
		}
	}

	return {
		results,
		unrenderedUnits: [...traceUnitIds].filter((id) => !renderedUnitIds.has(id)).sort(),
		unmatchedRenders: [...declaredUnitIds].filter((id) => !traceUnitIds.has(id)).sort()
	};
}

// ---------------------------------------------------------------------------
// Presentation. SVG because it is text (diffable, greppable), needs no
// encoder, carries a <title> tooltip per drawable so the REASON is readable
// by hovering, and can sit over a PNG the kind-keyed path already wrote.
// ---------------------------------------------------------------------------

const STYLE: Record<Drawable['verdict'], { stroke: string; fill: string; dash: string }> = {
	accepted: { stroke: '#39ff7a', fill: 'rgba(57,255,122,0.14)', dash: 'none' },
	rejected: { stroke: '#ff4d4d', fill: 'rgba(255,77,77,0.12)', dash: 'none' },
	info: { stroke: '#4dd2ff', fill: 'none', dash: '5 4' }
};

function esc(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

function safeSegment(s: string): string {
	return s.replace(/[^a-zA-Z0-9_.-]+/g, '_');
}

function valuesText(values: Drawable['values']): string {
	if (!values) return '[]';
	return `[${Object.entries(values)
		.map(([key, value]) => `${key}=${Number(value.toFixed(4))}`)
		.join(',')}]`;
}

function drawableCoordinates(
	drawable: Drawable,
	offset: RenderTraceFeaturesInput['sourceFrameOffset']
): { canonical: string; original: string } {
	const shift = (x: number, y: number) =>
		offset ? `(${(x - offset.xPx).toFixed(2)},${(y - offset.yPx).toFixed(2)})` : 'UNKNOWN';
	if (drawable.type === 'point') {
		return {
			canonical: `(${drawable.xPx.toFixed(2)},${drawable.yPx.toFixed(2)})`,
			original: shift(drawable.xPx, drawable.yPx)
		};
	}
	if (drawable.type === 'box') {
		const [x, y, width, height] = drawable.bbox;
		return {
			canonical: `bbox=(${x.toFixed(2)},${y.toFixed(2)},${width.toFixed(2)},${height.toFixed(2)})`,
			original: offset
				? `bbox=(${(x - offset.xPx).toFixed(2)},${(y - offset.yPx).toFixed(2)},${width.toFixed(2)},${height.toFixed(2)})`
				: 'UNKNOWN'
		};
	}
	if (drawable.type === 'polyline') {
		return {
			canonical: `path=${JSON.stringify(drawable.path)}`,
			original: offset
				? `path=${JSON.stringify(drawable.path.map(([x, y]) => [x - offset.xPx, y - offset.yPx]))}`
				: 'UNKNOWN'
		};
	}
	return {
		canonical: `origin=(${drawable.originXPx.toFixed(2)},${drawable.originYPx.toFixed(2)}) cells=${drawable.widthCells}x${drawable.heightCells} cellPx=${drawable.cellPx}`,
		original: shift(drawable.originXPx, drawable.originYPx)
	};
}

function tooltip(d: Drawable, layerName: string): string {
	const parts = [`${layerName} | ${d.verdict}`];
	if (d.ref) parts.push(`ref=${d.ref}`);
	if (d.reason) parts.push(`reason: ${d.reason}`);
	if (d.values) for (const [k, v] of Object.entries(d.values)) parts.push(`${k}=${v}`);
	return parts.join('\n');
}

/** Extent over every drawable, used ONLY when the caller could not supply
 * the image size. Reported as derived, never as the image's dimensions. */
function drawableExtent(plan: FeatureRenderPlan): { widthPx: number; heightPx: number } {
	let maxX = 0;
	let maxY = 0;
	for (const layer of plan.layers) {
		for (const d of layer.drawables) {
			if (d.type === 'point') {
				maxX = Math.max(maxX, d.xPx);
				maxY = Math.max(maxY, d.yPx);
			} else if (d.type === 'box') {
				maxX = Math.max(maxX, d.bbox[0] + d.bbox[2]);
				maxY = Math.max(maxY, d.bbox[1] + d.bbox[3]);
			} else if (d.type === 'polyline') {
				for (const [x, y] of d.path) {
					maxX = Math.max(maxX, x);
					maxY = Math.max(maxY, y);
				}
			} else {
				maxX = Math.max(maxX, d.originXPx + d.widthCells * d.cellPx);
				maxY = Math.max(maxY, d.originYPx + d.heightCells * d.cellPx);
			}
		}
	}
	return { widthPx: Math.ceil(maxX) + 16, heightPx: Math.ceil(maxY) + 16 };
}

function drawableSvg(d: Drawable, layerName: string): string {
	const s = STYLE[d.verdict];
	const title = `<title>${esc(tooltip(d, layerName))}</title>`;
	const common = `stroke="${s.stroke}" stroke-width="2" stroke-dasharray="${s.dash}" fill="${s.fill}" vector-effect="non-scaling-stroke"`;
	if (d.type === 'point') {
		// A rejection gets a cross as well as a circle so accepted vs rejected
		// survives a greyscale print and a colour-blind reader.
		const cross =
			d.verdict === 'rejected'
				? `<path d="M${d.xPx - 7} ${d.yPx - 7} L${d.xPx + 7} ${d.yPx + 7} M${d.xPx + 7} ${d.yPx - 7} L${d.xPx - 7} ${d.yPx + 7}" stroke="${s.stroke}" stroke-width="2" fill="none"/>`
				: '';
		return `<g>${title}<circle cx="${d.xPx}" cy="${d.yPx}" r="7" ${common}/>${cross}</g>`;
	}
	if (d.type === 'box') {
		const [x, y, w, h] = d.bbox;
		return `<g>${title}<rect x="${x}" y="${y}" width="${w}" height="${h}" ${common}/></g>`;
	}
	if (d.type === 'polyline') {
		const points = d.path.map(([x, y]) => `${x},${y}`).join(' ');
		return `<g>${title}<polyline points="${points}" ${common} fill="none"/></g>`;
	}
	// Heatmap payloads ride RunTrace.heatmaps out of band. Drawing the cells
	// would mean reading a buffer this module was not handed, so only the
	// footprint is outlined and the receipt says so.
	const w = d.widthCells * d.cellPx;
	const h = d.heightCells * d.cellPx;
	return `<g>${title}<rect x="${d.originXPx}" y="${d.originYPx}" width="${w}" height="${h}" stroke="${s.stroke}" stroke-width="2" stroke-dasharray="6 5" fill="none"/></g>`;
}

function rasterPixel(
	data: Uint8Array,
	width: number,
	height: number,
	x: number,
	y: number,
	color: readonly [number, number, number]
): void {
	const px = Math.round(x);
	const py = Math.round(y);
	if (px < 0 || py < 0 || px >= width || py >= height) return;
	const index = (py * width + px) * 4;
	data[index] = color[0];
	data[index + 1] = color[1];
	data[index + 2] = color[2];
	data[index + 3] = 255;
}

function rasterLine(
	data: Uint8Array,
	width: number,
	height: number,
	x0: number,
	y0: number,
	x1: number,
	y1: number,
	color: readonly [number, number, number]
): void {
	const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))));
	for (let step = 0; step <= steps; step++) {
		const t = step / steps;
		for (let thickness = -1; thickness <= 1; thickness++) {
			rasterPixel(data, width, height, x0 + (x1 - x0) * t + thickness, y0 + (y1 - y0) * t, color);
			rasterPixel(data, width, height, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t + thickness, color);
		}
	}
}

function rasterDrawable(
	data: Uint8Array,
	width: number,
	height: number,
	drawable: Drawable
): void {
	const color: readonly [number, number, number] =
		drawable.verdict === 'accepted'
			? [30, 255, 95]
			: drawable.verdict === 'rejected'
				? [255, 45, 45]
				: [30, 210, 255];
	if (drawable.type === 'box') {
		const [x, y, w, h] = drawable.bbox;
		rasterLine(data, width, height, x, y, x + w, y, color);
		rasterLine(data, width, height, x + w, y, x + w, y + h, color);
		rasterLine(data, width, height, x + w, y + h, x, y + h, color);
		rasterLine(data, width, height, x, y + h, x, y, color);
		return;
	}
	if (drawable.type === 'point') {
		for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 24) {
			rasterPixel(
				data,
				width,
				height,
				drawable.xPx + Math.cos(angle) * 7,
				drawable.yPx + Math.sin(angle) * 7,
				color
			);
		}
		return;
	}
	if (drawable.type === 'polyline') {
		for (let index = 1; index < drawable.path.length; index++) {
			const [x0, y0] = drawable.path[index - 1];
			const [x1, y1] = drawable.path[index];
			rasterLine(data, width, height, x0, y0, x1, y1, color);
		}
	}
}

function writeRasterProof(
	plan: FeatureRenderPlan,
	base: FeatureRenderBase,
	width: number,
	height: number,
	path: string
): void {
	const png = PNG.sync.read(readFileSync(base.pngPath));
	if (png.width !== width || png.height !== height) {
		throw new Error(
			`feature render base dimensions ${png.width}x${png.height} do not match canvas ${width}x${height}`
		);
	}
	for (const layer of plan.layers) {
		for (const drawable of layer.drawables) rasterDrawable(png.data, width, height, drawable);
	}
	writeFileSync(path, PNG.sync.write(png));
}

function rasterCircle(
	data: Uint8Array,
	width: number,
	height: number,
	x: number,
	y: number,
	radius: number,
	color: readonly [number, number, number]
): void {
	for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 72) {
		for (let thickness = -1; thickness <= 1; thickness++) {
			rasterPixel(
				data,
				width,
				height,
				x + Math.cos(angle) * (radius + thickness),
				y + Math.sin(angle) * (radius + thickness),
				color
			);
		}
	}
}

function rasterCross(
	data: Uint8Array,
	width: number,
	height: number,
	x: number,
	y: number,
	color: readonly [number, number, number]
): void {
	rasterLine(data, width, height, x - 8, y - 8, x + 8, y + 8, color);
	rasterLine(data, width, height, x + 8, y - 8, x - 8, y + 8, color);
}

function writeTruthProof(
	plan: FeatureRenderPlan,
	base: FeatureRenderBase,
	score: GateScore | undefined,
	comparison: GroundingComparison | undefined,
	width: number,
	height: number,
	path: string
): void {
	const png = PNG.sync.read(readFileSync(base.pngPath));
	if (png.width !== width || png.height !== height) {
		throw new Error(
			`feature truth base dimensions ${png.width}x${png.height} do not match canvas ${width}x${height}`
		);
	}
	for (const layer of plan.layers) {
		for (const drawable of layer.drawables) rasterDrawable(png.data, width, height, drawable);
	}
	const best = comparison
		? [...comparison.hypotheses].sort(
				(a, b) =>
					a.medianDeviationPx - b.medianDeviationPx ||
					a.meanDeviationPx - b.meanDeviationPx
			)[0]
		: undefined;
	for (const match of score?.objectMatches ?? []) {
		const truth = match.truthCanonical;
		const detection = match.detection;
		rasterLine(
			png.data,
			width,
			height,
			detection.xPx,
			detection.yPx,
			truth.xPx,
			truth.yPx,
			[255, 225, 30]
		);
		rasterCircle(png.data, width, height, truth.xPx, truth.yPx, 9, [255, 225, 30]);
		rasterCircle(png.data, width, height, detection.xPx, detection.yPx, 6, [30, 210, 255]);
		if (best && best.yShiftPx !== 0) {
			rasterCircle(
				png.data,
				width,
				height,
				detection.xPx,
				detection.yPx + best.yShiftPx,
				4,
				[255, 40, 220]
			);
		}
	}
	for (const target of score?.unmatchedTruth ?? []) {
		rasterCircle(png.data, width, height, target.point.xPx, target.point.yPx, 10, [255, 40, 40]);
		rasterCross(png.data, width, height, target.point.xPx, target.point.yPx, [255, 40, 40]);
	}
	for (const detection of score?.unownedDetections ?? []) {
		rasterCircle(png.data, width, height, detection.xPx, detection.yPx, 10, [255, 40, 40]);
		rasterCross(png.data, width, height, detection.xPx, detection.yPx, [255, 40, 40]);
	}
	writeFileSync(path, PNG.sync.write(png));
}

function writeTruthCropSheet(
	truthProofPath: string,
	score: GateScore,
	path: string
): void {
	const source = PNG.sync.read(readFileSync(truthProofPath));
	const matches = score.objectMatches ?? [];
	const sourceSize = 72;
	const scale = 3;
	const tileSize = sourceSize * scale;
	const columns = Math.min(6, Math.max(1, matches.length));
	const rows = Math.max(1, Math.ceil(matches.length / columns));
	const sheet = new PNG({ width: columns * tileSize, height: rows * tileSize });
	sheet.data.fill(255);
	for (const [index, match] of matches.entries()) {
		const tileX = (index % columns) * tileSize;
		const tileY = Math.floor(index / columns) * tileSize;
		const startX = Math.round(match.truthCanonical.xPx) - sourceSize / 2;
		const startY = Math.round(match.truthCanonical.yPx) - sourceSize / 2;
		for (let y = 0; y < sourceSize; y++) {
			for (let x = 0; x < sourceSize; x++) {
				const sourceX = Math.max(0, Math.min(source.width - 1, startX + x));
				const sourceY = Math.max(0, Math.min(source.height - 1, startY + y));
				const sourceIndex = (sourceY * source.width + sourceX) * 4;
				for (let sy = 0; sy < scale; sy++) {
					for (let sx = 0; sx < scale; sx++) {
						const outputX = tileX + x * scale + sx;
						const outputY = tileY + y * scale + sy;
						const outputIndex = (outputY * sheet.width + outputX) * 4;
						for (let channel = 0; channel < 4; channel++)
							sheet.data[outputIndex + channel] = source.data[sourceIndex + channel];
					}
				}
			}
		}
		const border: readonly [number, number, number] = [255, 225, 30];
		rasterLine(sheet.data, sheet.width, sheet.height, tileX, tileY, tileX + tileSize - 1, tileY, border);
		rasterLine(sheet.data, sheet.width, sheet.height, tileX + tileSize - 1, tileY, tileX + tileSize - 1, tileY + tileSize - 1, border);
		rasterLine(sheet.data, sheet.width, sheet.height, tileX + tileSize - 1, tileY + tileSize - 1, tileX, tileY + tileSize - 1, border);
		rasterLine(sheet.data, sheet.width, sheet.height, tileX, tileY + tileSize - 1, tileX, tileY, border);
	}
	writeFileSync(path, PNG.sync.write(sheet));
}

function truthReceiptLines(unit: UnitTrace, input: RenderTraceFeaturesInput): string[] {
	const score = input.truthEvaluation?.scoreboard?.scores.find(
		(candidate) => candidate.gate === unit.gate
	);
	const comparison = input.truthEvaluation?.groundingComparisons.find(
		(candidate) => candidate.gate === unit.gate
	);
	if (!score && !comparison) {
		return [
			'truth localization: UNKNOWN -- no annotation evaluation was available for this gate',
			'ownership: UNKNOWN -- no ownership evaluation was available for this gate'
		];
	}
	const lines = ['truth localization (evaluation only; never detector input):'];
	if (score) {
		lines.push(
			`  official/as-emitted: detected=${score.detected ?? 'UNKNOWN'} expected=${score.expected} ` +
				`matched=${score.matched} falsePositives=${score.unownedDetections?.length ?? 0} ` +
				`falseNegatives=${score.unmatchedTruth?.length ?? score.misses.length} ` +
				`maxDeviation=${score.maxDeviationPx.toFixed(2)}px (source: TruthScoreboard from this engine board)`
		);
		for (const match of score.objectMatches ?? []) {
			lines.push(
				`    MATCH ${match.truthIdentity} <- ${match.detection.identity} ` +
				`detection=(${match.detection.xPx.toFixed(2)},${match.detection.yPx.toFixed(2)}) ` +
				`truth=(${match.truthCanonical.xPx.toFixed(2)},${match.truthCanonical.yPx.toFixed(2)}) ` +
				`delta=${match.deviationPx.toFixed(2)}px`
			);
		}
		for (const target of score.unmatchedTruth ?? []) {
			lines.push(
				`    FALSE_NEGATIVE ${target.identity} truth=(${target.point.xPx.toFixed(2)},${target.point.yPx.toFixed(2)})`
			);
		}
		for (const detection of score.unownedDetections ?? []) {
			lines.push(
				`    FALSE_POSITIVE ${detection.identity} detection=(${detection.xPx.toFixed(2)},${detection.yPx.toFixed(2)}) ownership=UNKNOWN`
			);
		}
	} else {
		lines.push('  official/as-emitted: UNKNOWN -- annotation source provenance did not pass the truth firewall');
	}
	if (comparison) {
		lines.push(
			`  grounding hypotheses: ${comparison.provenanceTrusted ? 'source provenance MATCHED' : 'DIAGNOSTIC ONLY -- source provenance UNMATCHED'}`
		);
		const ranked = [...comparison.hypotheses].sort(
			(a, b) =>
				a.medianDeviationPx - b.medianDeviationPx ||
				a.meanDeviationPx - b.meanDeviationPx
		);
		for (const [index, hypothesis] of ranked.entries()) {
			lines.push(
				`    ${index === 0 ? 'LOWEST_RESIDUAL ' : ''}${hypothesis.id}: detectionY+=${hypothesis.yShiftPx}px ` +
				`matched=${hypothesis.matchedWithinTolerance} falsePositives=${hypothesis.falsePositiveCount} ` +
				`falseNegatives=${hypothesis.falseNegativeCount} median=${hypothesis.medianDeviationPx.toFixed(2)}px ` +
				`mean=${hypothesis.meanDeviationPx.toFixed(2)}px max=${hypothesis.maxDeviationPx.toFixed(2)}px ` +
				`provenance="${hypothesis.provenance}"`
			);
		}
	}
	lines.push(
		`ownership: UNKNOWN -- ${unit.gate} truth scoring evaluates localization only; no hole ownership assignment was evaluated`
	);
	return lines;
}

function writePlan(
	plan: FeatureRenderPlan,
	feature: ABFeature,
	unit: UnitTrace,
	input: RenderTraceFeaturesInput,
	warnings: string[]
): FeatureRenderResult {
	const { outDir, canvas } = input;
	const bases = input.bases ?? [];
	const base = bases[0];
	const truthScore = input.truthEvaluation?.scoreboard?.scores.find(
		(candidate) => candidate.gate === unit.gate
	);
	const groundingComparison = input.truthEvaluation?.groundingComparisons.find(
		(candidate) => candidate.gate === unit.gate
	);
	const all = plan.layers.flatMap((l) => l.drawables);
	// Counted off the OWNING unit's drawables, not off the flattened plan: a
	// plan may pull in another gate's accepted drawables for context (this
	// feature's does), and folding those into "accepted" would inflate the
	// number this receipt is read for.
	const acceptedCount = verdictOf(unit.drawables, 'accepted').length;
	const rejectedCount = verdictOf(unit.drawables, 'rejected').length;
	const crossGateCount = all.length - unit.drawables.length;

	const derived = drawableExtent(plan);
	const width = canvas?.widthPx ?? derived.widthPx;
	const height = canvas?.heightPx ?? derived.heightPx;
	const canvasProvenance = canvas
		? `${width} x ${height} (source: ${canvas.source})`
		: `${width} x ${height} -- DERIVED from drawable extent, NOT the image size. ` +
			`The trace does not carry image dimensions; pass RenderTraceFeaturesInput.canvas to fix this.`;

	const baseName = `feature.${safeSegment(feature.id)}.${safeSegment(unit.id)}`;
	const svgPath = resolve(outDir, `${baseName}.svg`);
	const pngProofs = bases.map((candidate, index) => ({
		base: candidate,
		path: resolve(
			outDir,
			index === 0 ? `${baseName}.png` : `${baseName}.${safeSegment(candidate.id)}.png`
		)
	}));
	const truthProofPath =
		base && (truthScore || groundingComparison)
			? resolve(outDir, `${baseName}.truth-grounding.png`)
			: undefined;
	const truthCropSheetPath =
		truthProofPath && truthScore?.objectMatches?.length
			? resolve(outDir, `${baseName}.truth-grounding-crops.png`)
			: undefined;
	const receiptPath = resolve(outDir, `${baseName}.receipt.txt`);

	let baseLine: string;
	let baseTag = '';
	if (base) {
		const dx = base.offsetXPx ?? 0;
		const dy = base.offsetYPx ?? 0;
		const href = relative(dirname(svgPath), base.pngPath).split('\\').join('/');
		baseTag = `<image href="${esc(href)}" x="${dx}" y="${dy}" width="${width - dx}" height="${height - dy}" preserveAspectRatio="none"/>`;
		baseLine =
			`base rasters (${bases.length} reusable visualizations):\n` +
			bases
				.map(
					(candidate) =>
						`  ${candidate.id}: ${candidate.pngPath} ` +
						`offset=(${candidate.offsetXPx ?? 0},${candidate.offsetYPx ?? 0}) source=${candidate.source}`
				)
				.join('\n') +
			`\n  SVG base: ${base.id}; plan requested artifact '${plan.base ?? '(none)'}'.`;
	} else {
		baseLine =
			`base raster: NOT COMPOSITED. The plan names artifact '${plan.base ?? '(none)'}', but resolving an\n` +
			`  artifact id to bytes belongs to the kind-keyed path (rendererContract.ts/artifactIo.ts).\n` +
			`  Overlay drawn on a flat background instead -- no pixels were invented.`;
	}

	const layerSvg = plan.layers
		.map(
			(layer) =>
				`  <g id="${esc(safeSegment(layer.name))}">\n` +
				`    <!-- ${esc(layer.name)}${layer.note ? ` -- ${esc(layer.note)}` : ''} (${layer.drawables.length} drawable(s)) -->\n` +
				layer.drawables.map((d) => `    ${drawableSvg(d, layer.name)}`).join('\n') +
				`\n  </g>`
		)
		.join('\n');

	const legend = plan.layers
		.map((layer, index) => {
			const verdict = layer.drawables[0]?.verdict ?? 'info';
			const s = STYLE[verdict];
			const y = 28 + index * 26;
			return (
				`    <rect x="14" y="${y - 12}" width="16" height="16" fill="${s.fill}" stroke="${s.stroke}" stroke-width="2"/>` +
				`<text x="40" y="${y + 1}" font-family="monospace" font-size="15" fill="#e6e6e6">${esc(layer.name)}: ${layer.drawables.length}</text>`
			);
		})
		.join('\n');

	const svg =
		`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">\n` +
		`  <title>${esc(plan.title)}</title>\n` +
		`  <desc>${esc(plan.notes.join('\n'))}</desc>\n` +
		`  <rect x="0" y="0" width="${width}" height="${height}" fill="#101014"/>\n` +
		(baseTag ? `  ${baseTag}\n` : '') +
		`${layerSvg}\n` +
		`  <g id="legend">\n` +
		`    <rect x="6" y="6" width="520" height="${18 + plan.layers.length * 26}" fill="rgba(0,0,0,0.72)" stroke="#555"/>\n` +
		`${legend}\n` +
		`  </g>\n` +
		`</svg>\n`;

	const receiptLines = [
		'=== FEATURE RENDER RECEIPT (trace-driven) ===',
		plan.title,
		'',
		`feature id:   ${feature.id}   (ABFeature.id)`,
		`feature kind: ${feature.kind}`,
		`trace unit:   ${unit.id}   (RunTrace.units[].id)`,
		`gate:         ${unit.gate}`,
		`unit -> features, per OPERATION_UNIVERSE: [${featureIdsForUnit(unit.id).join(', ') || 'none declared'}]`,
		'',
		...plan.notes,
		'',
		...truthReceiptLines(unit, input),
		'',
		'layers drawn:',
		...plan.layers.map(
			(l) =>
				`  ${String(l.drawables.length).padStart(4)}  ${l.name}${l.note ? `  -- ${l.note}` : ''}`
		),
		'',
		'object rows (the exact objects drawn in the SVG; coordinates are not recomputed):',
		...plan.layers.flatMap((layer) =>
			layer.drawables.map((drawable, index) => {
				const coordinates = drawableCoordinates(drawable, input.sourceFrameOffset);
				return (
					`  layer="${layer.name}" object=${index + 1} type=${drawable.type} verdict=${drawable.verdict} ` +
					`identity=${drawable.ref ?? 'UNKNOWN'} canonical=${coordinates.canonical} original=${coordinates.original} ` +
					`measurements=${valuesText(drawable.values)} reason="${drawable.reason ?? (drawable.verdict === 'accepted' ? 'accepted by detector' : 'UNKNOWN')}"`
				);
			})
		),
		'',
		`canvas: ${canvasProvenance}`,
		`coordinate transform: ${input.sourceFrameOffset ? `canonical = original + (${input.sourceFrameOffset.xPx},${input.sourceFrameOffset.yPx}) (source: ${input.sourceFrameOffset.source})` : 'UNKNOWN -- stitched/multi-source frame has no single inverse source mapping'}`,
		baseLine,
		'',
		...(warnings.length > 0 ? ['WARNINGS:', ...warnings.map((w) => `  ${w}`), ''] : []),
		`svg written to:     ${svgPath}`,
		...(pngProofs.length > 0
			? pngProofs.map((proof) => `png proof written [${proof.base.id}]: ${proof.path}`)
			: ['png proof written:  NOT WRITTEN -- no base raster supplied']),
		`truth grounding proof: ${truthProofPath ?? 'NOT WRITTEN -- no truth/grounding evaluation available'}`,
		...(truthProofPath
			? [
					'  colors: yellow=annotation, cyan=as-emitted endpoint, magenta=lowest-residual diagnostic Y hypothesis, red-cross=FP/FN'
				]
			: []),
		`truth grounding crop sheet: ${truthCropSheetPath ?? 'NOT WRITTEN -- no matched truth objects available'}`,
		...(truthCropSheetPath && truthScore
			? [
					`  tiles left-to-right, top-to-bottom: ${(truthScore.objectMatches ?? []).map((match) => match.truthIdentity).join(', ')}`,
					'  each tile: 72x72 canonical pixels enlarged 3x; yellow border is presentation only'
				]
			: []),
		`receipt written to: ${receiptPath}`
	];
	const receiptText = receiptLines.join('\n');

	writeFileSync(svgPath, svg);
	for (const proof of pngProofs) writeRasterProof(plan, proof.base, width, height, proof.path);
	if (truthProofPath && base)
		writeTruthProof(
			plan,
			base,
			truthScore,
			groundingComparison,
			width,
			height,
			truthProofPath
		);
	if (truthCropSheetPath && truthProofPath && truthScore)
		writeTruthCropSheet(truthProofPath, truthScore, truthCropSheetPath);
	writeFileSync(receiptPath, `${receiptText}\n`);

	return {
		featureId: feature.id,
		unitId: unit.id,
		gate: unit.gate,
		title: plan.title,
		drawableCount: all.length,
		acceptedCount,
		rejectedCount,
		filesWritten: [
			svgPath,
			...pngProofs.map((proof) => proof.path),
			...(truthProofPath ? [truthProofPath] : []),
			...(truthCropSheetPath ? [truthCropSheetPath] : []),
			receiptPath
		],
		receiptText,
		summary:
			`${feature.id}@${unit.id}: ${acceptedCount} accepted / ${rejectedCount} rejected ` +
			`(both counted on unit '${unit.id}' only)` +
			(crossGateCount > 0 ? ` + ${crossGateCount} cross-gate context drawable(s)` : '') +
			` over ${plan.layers.length} layer(s) -> SVG + receipt`,
		warnings
	};
}

/** Prints every receipt in full, then the inventory. The acceptance gate for
 * this repo is that the CLI output alone is self-evident, so nothing is
 * summarized away here. */
export function printFeatureRenders(output: RenderTraceFeaturesOutput): void {
	for (const result of output.results) {
		console.log('');
		console.log(result.receiptText);
	}
	console.log('');
	console.log(`--- Feature-render inventory: ${output.results.length} rendered ---`);
	for (const result of output.results) console.log(`  ${result.summary}`);
	if (output.unrenderedUnits.length > 0) {
		console.log(
			`  units in the trace with no feature render (kind-keyed path still covers their artifacts): ${output.unrenderedUnits.join(', ')}`
		);
	}
	if (output.unmatchedRenders.length > 0) {
		console.log(
			`  WARNING: features declared a render for unit(s) this trace never produced: ${output.unmatchedRenders.join(', ')}`
		);
	}
	const warned = output.results.filter((r) => r.warnings.length > 0);
	if (warned.length > 0) {
		console.log('  WARNINGS (see receipts above):');
		for (const r of warned)
			for (const w of r.warnings) console.log(`    ${r.featureId}@${r.unitId}: ${w}`);
	}
}
