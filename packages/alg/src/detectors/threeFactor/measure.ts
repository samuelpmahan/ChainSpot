import basketSpriteData from './assets/basket-sprite.json';
import logisticModelData from './assets/logistic.json';
import type { ComponentStats } from './components';
import { DEFAULT_BADGE_STAGE_KNOBS, runBadgeStage, type BadgeStageKnobs } from './badgeStage';
import {
	collectTeePoints,
	DEFAULT_ENDPOINTS_KNOBS,
	detectTeeRings,
	type EndpointsKnobs,
	type SpriteMatch,
	type SuppressedTee,
	type TeeRing
} from './endpoints';
import {
	matchBasketSpritesSmart,
	type SmartBasketDecision,
	type SmartBasketEvidence,
	type SmartBasketTemplate
} from './smartBasket';
import { predictProbs, type LogisticModel } from './digits/logisticInference';
import { readCourseBadges, type BadgeReading, type DigitScorer } from './digits/readBadges';
import { DEFAULT_DIGITS_KNOBS, type DigitsKnobs } from './digits/segment';
import { DEFAULT_HSV_KNOBS, type HsvKnobs } from './raster';
import {
	computeRibbonSupport,
	DEFAULT_RIBBON_KNOBS,
	patchBadgeOcclusion,
	type RibbonKnobs
} from './ribbon';
import { DEFAULT_ROUTING_KNOBS, routeBadgeLegs, type RoutingKnobs } from './routing';
import { DEFAULT_SCORING_KNOBS, makeRawPairEvidence, type ScoringKnobs } from './scoring';
import { detectScreenChromeRegions, pointInScreenChrome } from './screenChrome';
import type {
	BadgeEvidence,
	BasketEvidence,
	CorridorParams,
	DigitEvidence,
	RgbaImage,
	RawPairEvidence,
	SupportFieldEvidence,
	TeeEvidence,
	ThreeFactorMeasurement,
	ThreeFactorParams
} from './types';
import { THREE_FACTOR_ALGO, THREE_FACTOR_ALGO_VERSION } from './types';
import {
	nullFeatureContext,
	type EngineUnit,
	type EvidenceBoard,
	type EvidenceSlot,
	type FeatureContext
} from './features/types';
import { g4ScoringFeature } from './features/g4.scoring';
import { g5RibbonFeature } from './features/g5.ribbon';
import { g5RoutingFeature } from './features/g5.routing';
import { g3EndpointsFeature } from './features/g3.endpoints';
import { g2SpriteFeature, type SmartSpriteKnobs } from './features/g2.sprite';
import { g1BadgesFeature } from './features/g1.badges';
import { g1DigitsFeature } from './features/g1.digits';
import { sharedHsvFeature } from './features/shared.hsv';

/** Minimal evidence board: named slots with fail-loud reads. */
export function createBoard(): EvidenceBoard {
	const slots = new Map<EvidenceSlot, unknown>();
	return {
		get<T>(slot: EvidenceSlot): T {
			if (!slots.has(slot)) throw new Error(`evidence board: slot '${slot}' not produced yet.`);
			return slots.get(slot) as T;
		},
		has: (slot) => slots.has(slot),
		set: (slot, value) => {
			slots.set(slot, value);
		}
	};
}

const basketTemplate = basketSpriteData as SmartBasketTemplate;
const logisticModel = logisticModelData as LogisticModel;
const digitScorer: DigitScorer = {
	name: 'nuthing-p2-logistic',
	scores: (mask) => predictProbs(logisticModel, mask)
};

const DEFAULT_WIDTHS_SRC = [24, 32, 40, 48, 56, 64] as const;
const DEFAULT_CORRIDOR_WIDTH = 37;
const DEFAULT_FIELD_SCALE = 3;
const DEFAULT_ORIENTATIONS = 12;
const DEFAULT_ALIGNMENT_POWER = 2;
const DEFAULT_WORST_WINDOW = 90;
const DEFAULT_SUPPORT_TAU = 0.5;

function clamp01(value: number): number {
	return Math.max(0, Math.min(1, value));
}

function clampInt(value: number, minimum: number, maximum: number): number {
	return Math.max(minimum, Math.min(maximum, Math.round(value)));
}

function makeParameters(params: ThreeFactorParams | undefined): CorridorParams {
	const corridorWidthPx = params?.corridorWidthPx ?? DEFAULT_CORRIDOR_WIDTH;
	const fieldScale = params?.fieldScale ?? DEFAULT_FIELD_SCALE;
	const orientations = params?.orientations ?? DEFAULT_ORIENTATIONS;
	const widthsSrc = params?.widthsSrc ?? DEFAULT_WIDTHS_SRC;
	const alignmentPower = params?.alignmentPower ?? DEFAULT_ALIGNMENT_POWER;
	const worstWindowSrcPx = params?.worstWindowSrcPx ?? DEFAULT_WORST_WINDOW;
	const supportTau = params?.supportTau ?? DEFAULT_SUPPORT_TAU;
	if (!Number.isFinite(corridorWidthPx) || corridorWidthPx <= 0)
		throw new Error('corridorWidthPx must be positive.');
	if (!Number.isFinite(fieldScale) || fieldScale <= 0)
		throw new Error('fieldScale must be positive.');
	if (!Number.isInteger(orientations) || orientations < 1)
		throw new Error('orientations must be a positive integer.');
	if (!widthsSrc.length || widthsSrc.some((width) => !Number.isFinite(width) || width <= 0))
		throw new Error('widthsSrc must contain positive values.');
	if (!Number.isFinite(alignmentPower) || alignmentPower < 0)
		throw new Error('alignmentPower must be non-negative.');
	if (!Number.isFinite(worstWindowSrcPx) || worstWindowSrcPx <= 0)
		throw new Error('worstWindowSrcPx must be positive.');
	if (!Number.isFinite(supportTau) || supportTau < 0 || supportTau > 1)
		throw new Error('supportTau must be in [0, 1].');
	return {
		corridorWidthPx,
		fieldScale,
		orientations,
		widthsSrc: [...widthsSrc],
		patchBadges: params?.patchBadges ?? true,
		alignmentPower,
		worstWindowSrcPx,
		supportTau,
		// zfit passthrough — previously dropped here, which made the salvage
		// pass unreachable via the public path (bug). undefined stays absent.
		...(params?.zfit !== undefined ? { zfit: params.zfit } : {})
	};
}

function cropImage(image: RgbaImage, topPx: number, bottomPx: number): RgbaImage {
	const height = bottomPx - topPx;
	const data = new Uint8Array(image.width * height * 4);
	for (let y = 0; y < height; y++) {
		const source = (topPx + y) * image.width * 4;
		data.set(image.data.slice(source, source + image.width * 4), y * image.width * 4);
	}
	return { width: image.width, height, data };
}

function shiftedComponent(component: ComponentStats, yOffsetPx: number): ComponentStats {
	return { ...component, bboxY: component.bboxY + yOffsetPx, cy: component.cy + yOffsetPx };
}

function darkFraction(
	component: ComponentStats,
	dark: { width: number; data: Uint8Array }
): number {
	let count = 0;
	for (let y = component.bboxY; y < component.bboxY + component.bboxH; y++) {
		const row = y * dark.width;
		for (let x = component.bboxX; x < component.bboxX + component.bboxW; x++)
			count += dark.data[row + x];
	}
	return count / Math.max(1, component.bboxW * component.bboxH);
}

function labelCandidates(reading: BadgeReading): { label: number; confidence: number }[] {
	if (!reading.digits.length) return [];
	const candidates = Array.from({ length: 18 }, (_, index) => index + 1)
		.filter((label) => String(label).length === reading.digits.length)
		.map((label) => {
			const confidence = [...String(label)].reduce(
				(product, digit, index) => product * (reading.digits[index]?.scores[Number(digit)] ?? 0),
				1
			);
			return { label, confidence };
		})
		.sort((a, b) => b.confidence - a.confidence || a.label - b.label);
	const total = candidates.reduce((sum, candidate) => sum + candidate.confidence, 0);
	return candidates.map((candidate) => ({
		label: candidate.label,
		confidence: total > 0 ? candidate.confidence / total : 0
	}));
}

function digitEvidence(reading: BadgeReading, yOffsetPx: number): DigitEvidence[] {
	const [ix, iy] = reading.glyph.interiorBbox;
	return reading.digits.map((digit) => ({
		bbox: [
			ix + digit.candidate.bbox[0],
			iy + digit.candidate.bbox[1] + yOffsetPx,
			digit.candidate.bbox[2],
			digit.candidate.bbox[3]
		],
		method: digit.candidate.method,
		predicted: digit.predicted,
		runnerUp: digit.runnerUp,
		scores: [...digit.scores],
		margin: digit.margin,
		normalized: new Uint8Array(digit.normalized)
	}));
}

function makeBadges(
	stage: ReturnType<typeof runBadgeStage>,
	yOffsetPx: number,
	knobs: DigitsKnobs = DEFAULT_DIGITS_KNOBS
): BadgeEvidence[] {
	const readings = readCourseBadges(stage, digitScorer, knobs);
	const entries = readings.map((reading, index) => ({
		reading,
		index,
		component: stage.badges[index],
		source: stage.badgeSources[index] ?? 'bright-family',
		plateBbox: stage.plateBboxes[index]
	}));
	entries.sort(
		(a, b) =>
			a.reading.badge.cy - b.reading.badge.cy ||
			a.reading.badge.cx - b.reading.badge.cx ||
			a.index - b.index
	);
	return entries.map((entry, index) => {
		const component = shiftedComponent(entry.component, yOffsetPx);
		const bbox: readonly [number, number, number, number] = [
			component.bboxX,
			component.bboxY,
			component.bboxW,
			component.bboxH
		];
		const plateBbox = entry.plateBbox
			? ([
					entry.plateBbox[0],
					entry.plateBbox[1] + yOffsetPx,
					entry.plateBbox[2],
					entry.plateBbox[3]
				] as const)
			: undefined;
		const candidates = labelCandidates(entry.reading);
		const confidence =
			entry.reading.confidence === Infinity
				? darkFraction(entry.component, stage.darkMask)
				: clamp01(entry.reading.confidence);
		return {
			detId: `badge-${index}`,
			component,
			cxPx: entry.component.cx,
			cyPx: entry.component.cy + yOffsetPx,
			bbox,
			plateBbox,
			source: entry.source,
			digits: digitEvidence(entry.reading, yOffsetPx),
			label: candidates[0] ? String(candidates[0].label) : entry.reading.label || null,
			labelCandidates: candidates,
			confidence
		};
	});
}

function makeBaskets(
	sprites: readonly (SpriteMatch & SmartBasketEvidence)[],
	yOffsetPx: number
): BasketEvidence[] {
	return [...sprites]
		.sort((a, b) => a.y - b.y || a.x - b.x || b.score - a.score)
		.map((sprite, index) => {
			const whiteBbox = [
				sprite.x,
				sprite.y + yOffsetPx,
				sprite.bboxW,
				sprite.bboxH
			] as const;
			return {
				detId: `basket-${index}`,
				bbox: [
					sprite.semanticBbox[0],
					sprite.semanticBbox[1] + yOffsetPx,
					sprite.semanticBbox[2],
					sprite.semanticBbox[3]
			] as const,
			whiteBbox,
			centerXPx: sprite.cx,
			centerYPx: sprite.cy + yOffsetPx,
			tipXPx: sprite.tipX,
			tipYPx: sprite.tipY + yOffsetPx,
			onFrac: sprite.onFrac,
			offFrac: sprite.offFrac,
			score: sprite.score,
			tier: sprite.tier,
			confidence: sprite.confidence,
			identity: sprite.identity,
			effectiveVisibility: sprite.effectiveVisibility,
			whiteCoverage: sprite.whiteCoverage,
			blackBorderSupport: sprite.blackBorderSupport,
			darkCoherence: sprite.darkCoherence,
			source: sprite.source
		};
		});
}

function makeTees(
	stage: ReturnType<typeof runBadgeStage>,
	sprites: readonly SpriteMatch[],
	yOffsetPx: number,
	ctx: FeatureContext = nullFeatureContext,
	knobs: ScoringKnobs = DEFAULT_SCORING_KNOBS,
	endpointsKnobs: EndpointsKnobs = DEFAULT_ENDPOINTS_KNOBS,
	badgeStageKnobs: BadgeStageKnobs = DEFAULT_BADGE_STAGE_KNOBS
): TeeEvidence[] {
	const rawRings = detectTeeRings(stage.brightMask, endpointsKnobs);
	return excludeAndAssembleTees(
		stage,
		rawRings,
		[],
		sprites,
		yOffsetPx,
		ctx,
		knobs,
		endpointsKnobs,
		badgeStageKnobs
	);
}

/**
 * Prose for one suppressed tee candidate, naming the knob its value failed
 * against so the drawable carries its own provenance and a human never has to
 * open this file to read the receipt.
 *
 * `sprite-exclusion` says OCCLUDED out loud on purpose. A candidate inside a
 * matched basket sprite's exclusion radius is a tee we SAW and chose to drop —
 * not evidence the hole has no tee. Three separate agents have read output
 * with a tee missing, concluded the detector was broken, and rewritten correct
 * code, because that distinction had no way to reach the raster.
 *
 * `dim`/`area`/`fill` each guard a two-sided band and the sink records only
 * the single limit that was breached, so the bound is recovered from the
 * comparison: value below the limit failed the Min knob, above it the Max one.
 * Both branches are strict inequalities in collectTeePoints, so value ===
 * limit never reaches here.
 */
function suppressionReason(drop: SuppressedTee): string {
	const near = drop.nearest
		? ` of (${drop.nearest.cx.toFixed(1)}, ${drop.nearest.cy.toFixed(1)})`
		: '';
	switch (drop.reason) {
		case 'dedup-tee':
			return `dedup-tee: component ${drop.value.toFixed(2)}px${near}, an already-accepted tee (< teeRingDedupDistance=${drop.limit})`;
		case 'sprite-exclusion':
			return `sprite-exclusion: component ${drop.value.toFixed(2)}px${near}, a matched basket sprite (< teeSpriteExclusionDistance=${drop.limit}) — OCCLUDED tee, not an absent one`;
		default: {
			const bound = drop.value < drop.limit ? 'Min' : 'Max';
			const cap = drop.reason === 'dim' ? 'Dim' : drop.reason === 'area' ? 'Area' : 'Fill';
			return `${drop.reason}: component ${drop.value.toFixed(2)} vs component${bound}${cap}=${drop.limit}`;
		}
	}
}

/**
 * Exclude ring/component tee candidates that fall inside a badge bbox or a
 * screen-chrome cluster, then merge + sort + assign detIds. Extracted from
 * makeTees's tail (moved verbatim, not rewritten) so the exec layer's
 * tees.exclusion operation (packages/alg/src/exec/operations.ts) can run
 * the exact same exclusion + assembly pass over independently-produced raw
 * ring/component candidate sets, without duplicating this logic. Callers
 * own producing `rawRings` (e.g. detectTeeRings) and `rawComponents`
 * (bright components with badge-labeled ones already dropped) — see
 * makeTees below for the canonical, single-call-site composition.
 */
export function excludeAndAssembleTees(
	stage: Pick<ReturnType<typeof runBadgeStage>, 'brightComponents' | 'width' | 'height' | 'badges'>,
	rawRings: readonly TeeRing[],
	rawComponents: readonly ComponentStats[],
	sprites: readonly SpriteMatch[],
	yOffsetPx: number,
	ctx: FeatureContext = nullFeatureContext,
	knobs: ScoringKnobs = DEFAULT_SCORING_KNOBS,
	endpointsKnobs: EndpointsKnobs = DEFAULT_ENDPOINTS_KNOBS,
	badgeStageKnobs: BadgeStageKnobs = DEFAULT_BADGE_STAGE_KNOBS
): TeeEvidence[] {
	const chrome = detectScreenChromeRegions(stage.brightComponents, stage.width, stage.height);
	const insideBadgePadding = badgeStageKnobs.badgeInsidePadding;
	const insideBadge = (x: number, y: number): boolean =>
		stage.badges.some(
			(badge) =>
				x >= badge.bboxX - insideBadgePadding &&
				x <= badge.bboxX + badge.bboxW + insideBadgePadding &&
				y >= badge.bboxY - insideBadgePadding &&
				y <= badge.bboxY + badge.bboxH + insideBadgePadding
		);
	// no silent drops: every examined-and-killed candidate leaves a rejected
	// drawable with its reason — this is the "why 0 tees?" answer on the raster
	const reject = (x: number, y: number, reason: string, values?: Record<string, number>) =>
		ctx.overlay('tees', {
			type: 'point',
			xPx: x,
			yPx: y + yOffsetPx,
			verdict: 'rejected',
			reason,
			...(values ? { values } : {})
		});
	const rings = rawRings.filter((ring) => {
		if (insideBadge(ring.cx, ring.cy)) {
			reject(ring.cx, ring.cy, `ring inside badge bbox (+${insideBadgePadding}px pad)`);
			return false;
		}
		if (pointInScreenChrome(ring.cx, ring.cy, chrome)) {
			reject(ring.cx, ring.cy, 'ring inside screen-chrome cluster');
			return false;
		}
		return true;
	});
	const components = rawComponents.filter((component) => {
		if (insideBadge(component.cx, component.cy)) {
			reject(
				component.cx,
				component.cy,
				`component inside badge bbox (+${insideBadgePadding}px pad)`
			);
			return false;
		}
		if (pointInScreenChrome(component.cx, component.cy, chrome)) {
			reject(component.cx, component.cy, 'component inside screen-chrome cluster');
			return false;
		}
		return true;
	});
	// collectTeePoints' five threshold gates were silent `continue`s. Its
	// optional sink records reason + failing value + the knob limit it failed
	// against; this loop is the only thing that was missing — it drains the
	// sink onto the SAME rejected-drawable channel as the badge/chrome drops
	// above, satisfying features/types.ts's "no silent drops" rule instead of
	// adding a second reporting path. Instrumentation only: `points` is
	// identical whether or not the sink is passed.
	const suppressed: SuppressedTee[] = [];
	const points = collectTeePoints(
		rings,
		components,
		sprites.map((sprite) => ({ cx: sprite.cx, cy: sprite.cy })),
		endpointsKnobs,
		suppressed
	);
	for (const drop of suppressed) {
		reject(drop.cx, drop.cy, suppressionReason(drop), { value: drop.value, limit: drop.limit });
	}
	return points
		.map((tee) => {
			const ring = tee.ring;
			const component = tee.component;
			const xPx = tee.cx;
			const yPx = tee.cy + yOffsetPx;
			const bbox = ring
				? ([ring.bboxX, ring.bboxY + yOffsetPx, ring.bboxW, ring.bboxH] as const)
				: component
					? ([
							component.bboxX ?? Math.round(xPx - knobs.fallbackTeeBboxOffset),
							(component.bboxY ?? Math.round(tee.cy - knobs.fallbackTeeBboxOffset)) + yOffsetPx,
							component.bboxW,
							component.bboxH
						] as const)
					: ([
							Math.round(xPx - knobs.fallbackTeeBboxOffset),
							Math.round(yPx - knobs.fallbackTeeBboxOffset),
							knobs.fallbackTeeBboxSize,
							knobs.fallbackTeeBboxSize
						] as const);
			return {
				detId: '',
				xPx,
				yPx,
				tier: tee.tier,
				angleRad: ring?.angle ?? component?.angle ?? null,
				ring: ring
					? {
							bbox: [ring.bboxX, ring.bboxY + yOffsetPx, ring.bboxW, ring.bboxH] as const,
							area: ring.holeArea,
							elongation: ring.elongation,
							ringFrac: ring.ringFrac
						}
					: undefined,
				bbox,
				area: ring?.holeArea ?? component?.area ?? 0,
				fill: component?.fill ?? ring?.ringFrac ?? 0,
				onRing: sprites.some(
					(sprite) =>
						Math.abs(
							Math.hypot(xPx - sprite.cx, yPx - (sprite.cy + yOffsetPx)) - knobs.ringDistance
						) <= knobs.ringTolerance
				)
			};
		})
		.sort((a, b) => a.yPx - b.yPx || a.xPx - b.xPx || a.tier.localeCompare(b.tier))
		.map((tee, index) => ({ ...tee, detId: `tee-${index}` }));
}

function makeRawPairs(
	field: SupportFieldEvidence,
	badges: readonly BadgeEvidence[],
	tees: readonly TeeEvidence[],
	baskets: readonly BasketEvidence[],
	params: CorridorParams,
	yOffsetPx: number,
	ribbonKnobs: RibbonKnobs = DEFAULT_RIBBON_KNOBS,
	routingKnobs: RoutingKnobs = DEFAULT_ROUTING_KNOBS,
	scoringKnobs: ScoringKnobs = DEFAULT_SCORING_KNOBS
): RawPairEvidence[] {
	const teePoints = tees.map((tee) => ({ id: tee.detId, xPx: tee.xPx, yPx: tee.yPx }));
	const basketPoints = baskets.map((basket) => ({
		id: basket.detId,
		xPx: basket.tipXPx,
		yPx: basket.tipYPx
	}));
	const pairs: RawPairEvidence[] = [];
	for (const badge of badges) {
		const legs = routeBadgeLegs(
			field,
			{ id: badge.detId, xPx: badge.cxPx, yPx: badge.cyPx },
			teePoints,
			basketPoints,
			yOffsetPx,
			ribbonKnobs,
			routingKnobs
		);
		for (let teeIndex = 0; teeIndex < tees.length; teeIndex++) {
			for (let basketIndex = 0; basketIndex < baskets.length; basketIndex++) {
				pairs.push(
					makeRawPairEvidence(
						field,
						badge,
						tees[teeIndex],
						baskets[basketIndex],
						legs.tees[teeIndex],
						legs.baskets[basketIndex],
						params,
						yOffsetPx,
						scoringKnobs
					)
				);
			}
		}
	}
	return pairs.sort((a, b) => a.pairId.localeCompare(b.pairId));
}

// ---------------------------------------------------------------------------
// Engine units. Each unit's body is the exact code the monolithic
// measureThreeFactor used to run at that seam (moved, not rewritten); the
// evidence board carries what used to be local variables. Execution order
// comes from the config — DEFAULT_MEASURE_EXECUTION is the base semantic order.

interface ViewportSeed {
	readonly topPx: number;
	readonly bottomPx: number;
}

export const measureUnits: readonly EngineUnit[] = [
	{
		id: 'badgeStage',
		gate: 'G1',
		consumes: ['localImage'],
		produces: ['stage'],
		note: 'HSV masks, connected components, badge candidate detection',
		run(board, ctx) {
			const stop = ctx.span('badgeStage');
			const badgeStageKnobs = ctx.resolve(g1BadgesFeature).knobs as unknown as BadgeStageKnobs;
			const hsvKnobs = ctx.resolve(sharedHsvFeature).knobs as unknown as HsvKnobs;
			board.set(
				'stage',
				runBadgeStage(board.get<RgbaImage>('localImage'), badgeStageKnobs, hsvKnobs)
			);
			stop();
		}
	},
	{
		id: 'badges',
		gate: 'G1',
		consumes: ['stage', 'viewport'],
		produces: ['badges'],
		note: 'digit reading + label candidates, original-image coordinates',
		run(board, ctx) {
			const stop = ctx.span('badges');
			const stage = board.get<ReturnType<typeof runBadgeStage>>('stage');
			const { topPx } = board.get<ViewportSeed>('viewport');
			const digitsKnobs = ctx.resolve(g1DigitsFeature).knobs as unknown as DigitsKnobs;
			const badges = makeBadges(stage, topPx, digitsKnobs);
			for (const badge of badges) {
				ctx.overlay('badges', {
					type: 'box',
					bbox: badge.bbox,
					verdict: 'accepted',
					ref: badge.detId,
					values: { confidence: badge.confidence },
					reason: undefined
				});
				ctx.measure('badges', 'confidence', badge.confidence);
			}
			board.set('badges', badges);
			stop();
		}
	},
	{
		id: 'supportField',
		gate: 'G5',
		consumes: ['localImage', 'params'],
		produces: ['supportField'],
		note: 'ribbon support field — what the line follower sees',
		run(board, ctx) {
			const stop = ctx.span('supportField');
			const ribbonKnobs = ctx.resolve(g5RibbonFeature).knobs as unknown as RibbonKnobs;
			const field = computeRibbonSupport(
				board.get<RgbaImage>('localImage'),
				board.get<CorridorParams>('params'),
				ribbonKnobs
			);
			const { topPx } = board.get<ViewportSeed>('viewport');
			ctx.heatmap('supportField', 'supportField', field.support);
			ctx.overlay('supportField', {
				type: 'heatmap',
				key: 'supportField',
				widthCells: field.width,
				heightCells: field.height,
				cellPx: field.scale,
				originXPx: 0,
				originYPx: topPx,
				verdict: 'info'
			});
			board.set('supportField', field);
			stop();
		}
	},
	{
		id: 'badgeOcclusionPatch',
		gate: 'G5',
		consumes: ['supportField', 'localImage', 'badges', 'params', 'viewport'],
		produces: ['supportField'],
		note: 'lifts support under badges that occlude the corridor (patchBadges)',
		run(board, ctx) {
			const stop = ctx.span('badgeOcclusionPatch');
			const parameters = board.get<CorridorParams>('params');
			if (parameters.patchBadges) {
				const { topPx } = board.get<ViewportSeed>('viewport');
				const badges = board.get<BadgeEvidence[]>('badges');
				const localBadges = badges.map((badge) => ({
					...badge,
					cyPx: badge.cyPx - topPx,
					bbox: [badge.bbox[0], badge.bbox[1] - topPx, badge.bbox[2], badge.bbox[3]] as const,
					component: {
						...badge.component,
						cy: badge.component.cy - topPx,
						bboxY: badge.component.bboxY - topPx
					}
				}));
				const ribbonKnobs = ctx.resolve(g5RibbonFeature).knobs as unknown as RibbonKnobs;
				patchBadgeOcclusion(
					board.get<SupportFieldEvidence>('supportField'),
					board.get<RgbaImage>('localImage'),
					localBadges,
					parameters.corridorWidthPx,
					ribbonKnobs
				);
			}
			stop();
		}
	},
	{
		id: 'baskets',
		gate: 'G2',
		consumes: ['stage', 'viewport'],
		produces: ['sprites', 'baskets'],
		note: 'basket sprite matching (coarse→fine) + evidence assembly',
		run(board, ctx) {
			const stop = ctx.span('baskets');
			const stage = board.get<ReturnType<typeof runBadgeStage>>('stage');
			const { topPx } = board.get<ViewportSeed>('viewport');
			const spriteKnobs = ctx.resolve(g2SpriteFeature).knobs as unknown as SmartSpriteKnobs;
			const decisions: SmartBasketDecision[] = [];
			const smart = matchBasketSpritesSmart(
				stage.brightMask,
				stage.darkMask,
				stage.badges,
				basketTemplate,
				spriteKnobs,
				decisions
			);
			const sprites: (SpriteMatch & SmartBasketEvidence)[] = smart.map((candidate) => ({
				...candidate,
				onFrac: candidate.whiteCoverage,
				offFrac: 1 - candidate.blackBorderSupport,
				score: candidate.identity
			}));
			const baskets = makeBaskets(sprites, topPx);
			const basketByPosition = new Map(
				baskets.map((basket) =>
					[`${basket.whiteBbox[0]}:${basket.whiteBbox[1] - topPx}`, basket] as const
				)
			);
			for (const [index, decision] of decisions.entries()) {
				const basket = basketByPosition.get(`${decision.x}:${decision.y}`);
				const whiteBbox = [
					decision.x,
					decision.y + topPx,
					decision.bboxW,
					decision.bboxH
				] as const;
				const semanticBbox = [
					decision.semanticBbox[0],
					decision.semanticBbox[1] + topPx,
					decision.semanticBbox[2],
					decision.semanticBbox[3]
				] as const;
				const ref = decision.accepted ? basket?.detId : `basket-candidate-${index}`;
				ctx.overlay('baskets', {
					type: 'box',
					bbox: semanticBbox,
					verdict: decision.accepted ? 'accepted' : 'rejected',
					ref,
					reason: `${decision.reason}; tier=${decision.tier}; source=${decision.source}`,
					values: {
						areaRatio: decision.areaRatio,
						identity: decision.identity,
						effectiveVisibility: decision.effectiveVisibility,
						whiteCoverage: decision.whiteCoverage,
						blackBorderSupport: decision.blackBorderSupport,
						darkCoherence: decision.darkCoherence,
						recovered: decision.tier === 'occlusion-recovery' ? 1 : 0
					}
				});
				ctx.overlay('baskets', {
					type: 'box',
					bbox: whiteBbox,
					verdict: 'info',
					ref: `${ref ?? `basket-candidate-${index}`}:white-component`,
					reason: 'bright connected-component bounds used by detector; not the basket object bbox',
					values: {
						blackConsensusSearchMarginPx: spriteKnobs.blackConsensusMarginPx,
						semanticWidthPx: semanticBbox[2],
						semanticHeightPx: semanticBbox[3]
					}
				});
			}
			for (const basket of baskets) {
				const bboxLastPixelYPx = basket.bbox[1] + basket.bbox[3] - 1;
				const whiteBboxLastPixelYPx =
					basket.whiteBbox[1] + basket.whiteBbox[3] - 1;
				ctx.overlay('baskets', {
					type: 'point',
					xPx: basket.tipXPx,
					yPx: basket.tipYPx,
					verdict: 'info',
					ref: `${basket.detId}:semantic-tip`,
					reason: 'engine-emitted semantic basket endpoint; ownership not evaluated',
					values: {
						bboxLastPixelYPx,
						whiteBboxLastPixelYPx,
						semanticTipYPx: basket.tipYPx,
						tipBelowBboxLastPixelPx: basket.tipYPx - bboxLastPixelYPx,
						tipBelowWhiteBboxLastPixelPx:
							basket.tipYPx - whiteBboxLastPixelYPx,
						configuredSemanticTipOffsetPx: spriteKnobs.semanticTipOffsetPx
					}
				});
				ctx.measure('baskets', 'score', basket.score);
			}
			board.set('sprites', sprites);
			board.set('baskets', baskets);
			stop();
		}
	},
	{
		id: 'tees',
		gate: 'G3',
		consumes: ['stage', 'sprites', 'viewport'],
		produces: ['tees'],
		note: 'visible hollow-ring tee candidates with chrome + badge exclusion; shard recovery is separate',
		run(board, ctx) {
			const stop = ctx.span('tees');
			const stage = board.get<ReturnType<typeof runBadgeStage>>('stage');
			const sprites = board.get<readonly SpriteMatch[]>('sprites');
			const { topPx } = board.get<ViewportSeed>('viewport');
			const scoringKnobs = ctx.resolve(g4ScoringFeature).knobs as unknown as ScoringKnobs;
			const endpointsKnobs = ctx.resolve(g3EndpointsFeature).knobs as unknown as EndpointsKnobs;
			const badgeStageKnobs = ctx.resolve(g1BadgesFeature).knobs as unknown as BadgeStageKnobs;
			const tees = makeTees(
				stage,
				sprites,
				topPx,
				ctx,
				scoringKnobs,
				endpointsKnobs,
				badgeStageKnobs
			);
			for (const tee of tees) {
				ctx.overlay('tees', {
					type: 'box',
					bbox: tee.bbox,
					verdict: 'accepted',
					ref: tee.detId,
					values: { fill: tee.fill, area: tee.area }
				});
			}
			board.set('tees', tees);
			stop();
		}
	},
	{
		id: 'rawPairs',
		gate: 'G5',
		consumes: ['supportField', 'badges', 'tees', 'baskets', 'params', 'viewport'],
		produces: ['rawPairs'],
		note: 'route both legs for every badge×tee×basket hypothesis',
		run(board, ctx) {
			const stop = ctx.span('rawPairs');
			const ribbonKnobs = ctx.resolve(g5RibbonFeature).knobs as unknown as RibbonKnobs;
			const routingKnobs = ctx.resolve(g5RoutingFeature).knobs as unknown as RoutingKnobs;
			const scoringKnobs = ctx.resolve(g4ScoringFeature).knobs as unknown as ScoringKnobs;
			const rawPairs = makeRawPairs(
				board.get<SupportFieldEvidence>('supportField'),
				board.get<BadgeEvidence[]>('badges'),
				board.get<TeeEvidence[]>('tees'),
				board.get<BasketEvidence[]>('baskets'),
				board.get<CorridorParams>('params'),
				board.get<ViewportSeed>('viewport').topPx,
				ribbonKnobs,
				routingKnobs,
				scoringKnobs
			);
			for (const pair of rawPairs) ctx.measure('rawPairs', 'supportMin', pair.supportMin);
			board.set('rawPairs', rawPairs);
			stop();
		}
	},
	{
		id: 'measurement',
		gate: 'shared',
		consumes: [
			'image',
			'viewport',
			'params',
			'stage',
			'badges',
			'baskets',
			'tees',
			'supportField',
			'rawPairs'
		],
		produces: ['measurement'],
		note: 'assemble the ThreeFactorMeasurement artifact',
		run(board, ctx) {
			const stop = ctx.span('measurement');
			const image = board.get<RgbaImage>('image');
			const { topPx, bottomPx } = board.get<ViewportSeed>('viewport');
			const stage = board.get<ReturnType<typeof runBadgeStage>>('stage');
			const measurement: ThreeFactorMeasurement = {
				algo: THREE_FACTOR_ALGO,
				algoVersion: THREE_FACTOR_ALGO_VERSION,
				widthPx: image.width,
				heightPx: image.height,
				viewport: { topPx, bottomPx, sourceFrame: 'original-image' },
				parameters: board.get<CorridorParams>('params'),
				brightMask: stage.brightMask,
				darkMask: stage.darkMask,
				badges: board.get<BadgeEvidence[]>('badges'),
				baskets: board.get<BasketEvidence[]>('baskets'),
				tees: board.get<TeeEvidence[]>('tees'),
				field: board.get<SupportFieldEvidence>('supportField'),
				rawPairs: board.get<RawPairEvidence[]>('rawPairs')
			};
			board.set('measurement', measurement);
			stop();
		}
	}
];

export const DEFAULT_MEASURE_EXECUTION: readonly string[] = [
	'badgeStage',
	'badges',
	'baskets',
	'tees',
	'supportField',
	'badgeOcclusionPatch',
	'rawPairs',
	'measurement'
];

/** Seed the evidence board exactly as the monolithic entry point did. */
export function seedBoard(
	board: EvidenceBoard,
	image: RgbaImage,
	params?: ThreeFactorParams
): void {
	if (image.width <= 0 || image.height <= 0) throw new Error('Image dimensions must be positive.');
	if (image.data.length !== image.width * image.height * 4)
		throw new Error('RGBA byte length does not match image dimensions.');
	const topPx = clampInt(params?.viewport?.topPx ?? 0, 0, image.height - 1);
	const bottomPx = clampInt(params?.viewport?.bottomPx ?? image.height, topPx + 1, image.height);
	board.set('image', image);
	board.set('viewport', { topPx, bottomPx });
	board.set('params', makeParameters(params));
	board.set('localImage', cropImage(image, topPx, bottomPx));
}

export function measureThreeFactor(
	image: RgbaImage,
	params?: ThreeFactorParams
): ThreeFactorMeasurement {
	const board = createBoard();
	seedBoard(board, image, params);
	for (const unit of measureUnits) unit.run(board, nullFeatureContext);
	return board.get<ThreeFactorMeasurement>('measurement');
}
