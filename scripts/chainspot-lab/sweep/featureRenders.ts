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

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OPERATION_UNIVERSE } from '@chainspot/alg/exec';
import { runThreeFactor } from '@chainspot/alg/detectors/threeFactor';
import { ALL_FEATURES } from '@chainspot/alg/detectors/threeFactor/features/registry';
import type {
	ABFeature,
	Drawable,
	FeatureRender,
	FeatureRenderPlan,
	RunTrace,
	UnitTrace
} from '@chainspot/alg/detectors/threeFactor/features/types';

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
		const reason = d.reason ?? '(no reason recorded -- violates features/types.ts "no silent drops")';
		counts.set(reason, (counts.get(reason) ?? 0) + 1);
	}
	return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/**
 * Reads deviation state off the UnitTrace it was handed and says exactly
 * what it can and cannot conclude.
 *
 * FINDING (2026-08-25, this branch, measured -- not assumed): for unit
 * 'tees' this always returns the UNKNOWN branch. engine.ts's
 * createTraceContext() builds a UnitTrace's `knobs`/`knobsDeviating` from
 * `featureById(unitId)`, and there is no ABFeature whose id is 'tees' --
 * the knobs this unit runs on belong to feature 'endpoints'. So the trace
 * records `knobs: {}` and `knobsDeviating: []` for the single unit in the
 * algorithm where a deviated threshold changes what gets thrown away. An
 * empty list there does NOT mean "frozen defaults"; it means the question
 * was never asked. Printing that difference is the entire point of this
 * function -- silently rendering "no deviations" would be a fabricated
 * number, which is worse than no number.
 */
function deviationNotes(unit: UnitTrace, featureId: string): string[] {
	const knobNames = Object.keys(unit.knobs);
	if (unit.knobsDeviating.length > 0) {
		return [
			`knobsDeviating: ${unit.knobsDeviating.length} of ${knobNames.length} knob(s) DEVIATE from the feature's frozen default --`,
			...unit.knobsDeviating.map(
				(name) => `    ${name} = ${JSON.stringify(unit.knobs[name])}  (source: UnitTrace.knobs['${name}'])`
			),
			`  => this run did NOT use frozen '${featureId}' thresholds. Read every rejection below against the deviated value, not the default.`
		];
	}
	if (knobNames.length > 0) {
		return [
			`knobsDeviating: none -- all ${knobNames.length} knob(s) sit at feature '${featureId}''s frozen defaults`,
			`  (source: UnitTrace.knobsDeviating, computed in engine.ts createTraceContext against ABFeature.knobs[name].default)`
		];
	}
	return [
		`knobsDeviating: UNKNOWN -- not "none".`,
		`  UnitTrace '${unit.id}' carries 0 knobs, so an empty knobsDeviating carries no information.`,
		`  Why: engine.ts createTraceContext() resolves a unit's knobs via featureById('${unit.id}'),`,
		`  and no ABFeature has id '${unit.id}' -- these knobs belong to feature '${featureId}'`,
		`  (declared by OperationSpec.features on this unit's ops: ${featureIdsForUnit(unit.id).join(', ') || 'none'}).`,
		`  Consequence: a deviated '${featureId}' threshold cannot appear anywhere in this trace,`,
		`  so the rejections below cannot be attributed to a default vs a deviation from the trace alone.`,
		`  Fix is one lookup in engine.ts (unit -> OperationSpec.features -> resolved.features), NOT a change here.`
	];
}

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
			...deviationNotes(unit, 'endpoints'),
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
			notes.push('', 'rejections by reason (each line is a candidate the algorithm examined and threw away):');
			for (const [reason, count] of reasons) notes.push(`  ${String(count).padStart(4)} x  ${reason}`);
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
			`base raster: '${BRIGHT_MASK_ARTIFACT}' (artifact id, not bytes). It is computed over 'localImage',`,
			`  the viewport crop, so it aligns with these original-image coordinates only when viewport.topPx = 0.`,
			`  The trace does not carry topPx, so this render states the name and refuses to assume the offset.`
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
					? [{ name: 'tee candidates info (G3)', note: 'neither accepted nor rejected', drawables: info }]
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
	readonly base?: FeatureRenderBase;
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
		for (const declared of render.units) declaredUnitIds.add(declared);
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
						`Land \`render: ENDPOINTS_RENDER\` in features/${feature.gate.toLowerCase()}.${feature.id}.ts and drop the entry.`
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
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function safeSegment(s: string): string {
	return s.replace(/[^a-zA-Z0-9_.-]+/g, '_');
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

function writePlan(
	plan: FeatureRenderPlan,
	feature: ABFeature,
	unit: UnitTrace,
	input: RenderTraceFeaturesInput,
	warnings: string[]
): FeatureRenderResult {
	const { outDir, canvas, base } = input;
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
	const receiptPath = resolve(outDir, `${baseName}.receipt.txt`);

	let baseLine: string;
	let baseTag = '';
	if (base) {
		const dx = base.offsetXPx ?? 0;
		const dy = base.offsetYPx ?? 0;
		const href = relative(dirname(svgPath), base.pngPath).split('\\').join('/');
		baseTag = `<image href="${esc(href)}" x="${dx}" y="${dy}" width="${width - dx}" height="${height - dy}" preserveAspectRatio="none"/>`;
		baseLine =
			`base raster: ${base.pngPath}\n` +
			`  offset applied: dx=${dx} dy=${dy} (source: caller, ${base.source} -- never inferred here)\n` +
			`  plan asked for artifact '${plan.base ?? '(none)'}'; the caller is responsible for having resolved that id to this file.`;
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
		'layers drawn:',
		...plan.layers.map((l) => `  ${String(l.drawables.length).padStart(4)}  ${l.name}${l.note ? `  -- ${l.note}` : ''}`),
		'',
		`canvas: ${canvasProvenance}`,
		baseLine,
		'',
		...(warnings.length > 0 ? ['WARNINGS:', ...warnings.map((w) => `  ${w}`), ''] : []),
		`svg written to:     ${svgPath}`,
		`receipt written to: ${receiptPath}`
	];
	const receiptText = receiptLines.join('\n');

	writeFileSync(svgPath, svg);
	writeFileSync(receiptPath, `${receiptText}\n`);

	return {
		featureId: feature.id,
		unitId: unit.id,
		gate: unit.gate,
		title: plan.title,
		drawableCount: all.length,
		acceptedCount,
		rejectedCount,
		filesWritten: [svgPath, receiptPath],
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
		for (const r of warned) for (const w of r.warnings) console.log(`    ${r.featureId}@${r.unitId}: ${w}`);
	}
}

// ---------------------------------------------------------------------------
// Direct entry point, so this path is runnable and checkable on its own
// today. `lab sweep` (sweep/operation.ts) currently executes with
// nullFeatureContext and therefore produces NO RunTrace at all -- wiring a
// tracing context into that operation is a change to a file this module does
// not own. Until that lands, this main() is how a human sees the output:
//
//   node --import tsx scripts/chainspot-lab/sweep/featureRenders.ts \
//     packages/alg/src/detectors/threeFactor/configs/default.json \
//     ../chainspot-corpus/dev/DashsTrack/DashsTrack-full.jpg \
//     [--out DIR] [--base PNG] [--base-offset-y N]
// ---------------------------------------------------------------------------

async function main(argv: readonly string[]): Promise<void> {
	const positional: string[] = [];
	const flags = new Map<string, string>();
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg.startsWith('--')) flags.set(arg.slice(2), argv[++i] ?? '');
		else positional.push(arg);
	}
	const [configPath, imagePath] = positional;
	if (!configPath || !imagePath) {
		console.error(
			'Usage: featureRenders.ts CONFIG.json IMAGE [--out DIR] [--base PNG] [--base-offset-x N] [--base-offset-y N]'
		);
		process.exit(2);
	}

	// Imported lazily so the module stays importable from a browser-safe
	// context; these two reach node:fs and the decoder.
	const { loadConfig } = await import('./configIo');
	const { canonicalizeInputs } = await import('./inputShim');
	const { canonicalJson, sha256Hex } = await import('@chainspot/alg/detectors/threeFactor');

	const { resolved } = loadConfig(resolve(configPath));
	const { report, image } = await canonicalizeInputs([resolve(imagePath)]);
	const paramsHash = await sha256Hex(canonicalJson(resolved));
	const run = runThreeFactor(
		{ imageId: report.imageId, widthPx: image.width, heightPx: image.height, rgba: image.data },
		{ config: resolved, paramsHash }
	);
	if (!run.trace) throw new Error('featureRenders: runThreeFactor returned no trace (a resolved config is required).');

	const here = dirname(fileURLToPath(import.meta.url));
	const outDir = resolve(flags.get('out') ?? resolve(here, '../../../artifacts/featureRenders', resolved.name));
	const basePng = flags.get('base');

	console.log(`config: ${resolved.name}  paramsHash: ${paramsHash}`);
	console.log(`image:  ${report.imageId} ${image.width}x${image.height} from ${resolve(imagePath)}`);
	console.log(`trace units: ${run.trace.units.map((u) => u.id).join(', ')}`);

	printFeatureRenders(
		renderTraceFeatures({
			run: run.trace,
			outDir,
			canvas: {
				widthPx: image.width,
				heightPx: image.height,
				source: 'LAB G0 canonical intake (sweep/inputShim.ts canonicalizeInputs), the same raster the engine ran on'
			},
			...(basePng
				? {
						base: {
							pngPath: resolve(basePng),
							offsetXPx: Number(flags.get('base-offset-x') ?? 0),
							offsetYPx: Number(flags.get('base-offset-y') ?? 0),
							source: '--base/--base-offset-* flags'
						}
					}
				: {})
		})
	);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
	main(process.argv.slice(2)).catch((error) => {
		console.error(`featureRenders: ${(error as Error).message}`);
		process.exit(1);
	});
}
