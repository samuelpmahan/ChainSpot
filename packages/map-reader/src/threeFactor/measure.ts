import basketSpriteData from './assets/basket-sprite.json';
import logisticModelData from './assets/logistic.json';
import type { ComponentStats } from './components';
import { runBadgeStage } from './badgeStage';
import {
	collectTeePoints,
	detectTeeRings,
	matchBasketSprites,
	prepareSpriteTemplate,
	type SpriteMatch,
	type SpriteTemplate
} from './endpoints';
import { predictProbs, type LogisticModel } from './digits/logisticInference';
import { readCourseBadges, type BadgeReading, type DigitScorer } from './digits/readBadges';
import { computeRibbonSupport, patchBadgeOcclusion } from './ribbon';
import { routeBadgeLegs } from './routing';
import { makeRawPairEvidence } from './scoring';
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

const basketTemplate = prepareSpriteTemplate(basketSpriteData as SpriteTemplate);
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
	if (!Number.isFinite(corridorWidthPx) || corridorWidthPx <= 0) throw new Error('corridorWidthPx must be positive.');
	if (!Number.isFinite(fieldScale) || fieldScale <= 0) throw new Error('fieldScale must be positive.');
	if (!Number.isInteger(orientations) || orientations < 1) throw new Error('orientations must be a positive integer.');
	if (!widthsSrc.length || widthsSrc.some((width) => !Number.isFinite(width) || width <= 0)) throw new Error('widthsSrc must contain positive values.');
	if (!Number.isFinite(alignmentPower) || alignmentPower < 0) throw new Error('alignmentPower must be non-negative.');
	if (!Number.isFinite(worstWindowSrcPx) || worstWindowSrcPx <= 0) throw new Error('worstWindowSrcPx must be positive.');
	if (!Number.isFinite(supportTau) || supportTau < 0 || supportTau > 1) throw new Error('supportTau must be in [0, 1].');
	return {
		corridorWidthPx,
		fieldScale,
		orientations,
		widthsSrc: [...widthsSrc],
		patchBadges: params?.patchBadges ?? true,
		alignmentPower,
		worstWindowSrcPx,
		supportTau
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

function darkFraction(component: ComponentStats, dark: { width: number; data: Uint8Array }): number {
	let count = 0;
	for (let y = component.bboxY; y < component.bboxY + component.bboxH; y++) {
		const row = y * dark.width;
		for (let x = component.bboxX; x < component.bboxX + component.bboxW; x++) count += dark.data[row + x];
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

function makeBadges(stage: ReturnType<typeof runBadgeStage>, yOffsetPx: number): BadgeEvidence[] {
	const readings = readCourseBadges(stage, digitScorer);
	const entries = readings.map((reading, index) => ({
		reading,
		index,
		component: stage.badges[index],
		source: stage.badgeSources[index] ?? 'bright-family',
		plateBbox: stage.plateBboxes[index]
	}));
	entries.sort((a, b) => a.reading.badge.cy - b.reading.badge.cy || a.reading.badge.cx - b.reading.badge.cx || a.index - b.index);
	return entries.map((entry, index) => {
		const component = shiftedComponent(entry.component, yOffsetPx);
		const bbox: readonly [number, number, number, number] = [
			component.bboxX,
			component.bboxY,
			component.bboxW,
			component.bboxH
		];
		const plateBbox = entry.plateBbox
			? [entry.plateBbox[0], entry.plateBbox[1] + yOffsetPx, entry.plateBbox[2], entry.plateBbox[3]] as const
			: undefined;
		const candidates = labelCandidates(entry.reading);
		const confidence = entry.reading.confidence === Infinity
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

function makeBaskets(sprites: readonly SpriteMatch[], yOffsetPx: number): BasketEvidence[] {
	return [...sprites]
		.sort((a, b) => a.y - b.y || a.x - b.x || b.score - a.score)
		.map((sprite, index) => ({
			detId: `basket-${index}`,
			bbox: [sprite.x, sprite.y + yOffsetPx, 42, 66] as const,
			centerXPx: sprite.cx,
			centerYPx: sprite.cy + yOffsetPx,
			tipXPx: sprite.tipX,
			tipYPx: sprite.tipY + yOffsetPx,
			onFrac: sprite.onFrac,
			offFrac: sprite.offFrac,
			score: sprite.score
		}));
}

function makeTees(
	stage: ReturnType<typeof runBadgeStage>,
	sprites: readonly SpriteMatch[],
	yOffsetPx: number
): TeeEvidence[] {
	const chrome = detectScreenChromeRegions(stage.brightComponents, stage.width, stage.height);
	const insideBadge = (x: number, y: number): boolean => stage.badges.some(
		(badge) => x >= badge.bboxX - 3 && x <= badge.bboxX + badge.bboxW + 3 && y >= badge.bboxY - 3 && y <= badge.bboxY + badge.bboxH + 3
	);
	const rings = detectTeeRings(stage.brightMask).filter(
		(ring) => !insideBadge(ring.cx, ring.cy) && !pointInScreenChrome(ring.cx, ring.cy, chrome)
	);
	const badgeLabels = new Set(stage.badges.map((badge) => badge.label));
	const components = stage.brightComponents.filter(
		(component) => !badgeLabels.has(component.label) && !insideBadge(component.cx, component.cy) && !pointInScreenChrome(component.cx, component.cy, chrome)
	);
	const points = collectTeePoints(rings, components, sprites.map((sprite) => ({ cx: sprite.cx, cy: sprite.cy })));
	return points
		.map((tee) => {
			const ring = tee.ring;
			const component = tee.component;
			const xPx = tee.cx;
			const yPx = tee.cy + yOffsetPx;
			const bbox = ring
				? [ring.bboxX, ring.bboxY + yOffsetPx, ring.bboxW, ring.bboxH] as const
				: component
					? [component.bboxX ?? Math.round(xPx - 6), (component.bboxY ?? Math.round(tee.cy - 6)) + yOffsetPx, component.bboxW, component.bboxH] as const
					: [Math.round(xPx - 6), Math.round(yPx - 6), 12, 12] as const;
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
				onRing: sprites.some((sprite) => Math.abs(Math.hypot(xPx - sprite.cx, yPx - (sprite.cy + yOffsetPx)) - 84) <= 12)
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
	yOffsetPx: number
): RawPairEvidence[] {
	const teePoints = tees.map((tee) => ({ id: tee.detId, xPx: tee.xPx, yPx: tee.yPx }));
	const basketPoints = baskets.map((basket) => ({ id: basket.detId, xPx: basket.tipXPx, yPx: basket.tipYPx }));
	const pairs: RawPairEvidence[] = [];
	for (const badge of badges) {
		const legs = routeBadgeLegs(field, { id: badge.detId, xPx: badge.cxPx, yPx: badge.cyPx }, teePoints, basketPoints, yOffsetPx);
		for (let teeIndex = 0; teeIndex < tees.length; teeIndex++) {
			for (let basketIndex = 0; basketIndex < baskets.length; basketIndex++) {
				pairs.push(makeRawPairEvidence(field, badge, tees[teeIndex], baskets[basketIndex], legs.tees[teeIndex], legs.baskets[basketIndex], params, yOffsetPx));
			}
		}
	}
	return pairs.sort((a, b) => a.pairId.localeCompare(b.pairId));
}

export function measureThreeFactor(image: RgbaImage, params?: ThreeFactorParams): ThreeFactorMeasurement {
	if (image.width <= 0 || image.height <= 0) throw new Error('Image dimensions must be positive.');
	if (image.data.length !== image.width * image.height * 4) throw new Error('RGBA byte length does not match image dimensions.');
	const topPx = clampInt(params?.viewport?.topPx ?? 0, 0, image.height - 1);
	const bottomPx = clampInt(params?.viewport?.bottomPx ?? image.height, topPx + 1, image.height);
	const parameters = makeParameters(params);
	const localImage = cropImage(image, topPx, bottomPx);
	const stage = runBadgeStage(localImage);
	const badges = makeBadges(stage, topPx);
	const localBadges = badges.map((badge) => ({ ...badge, cyPx: badge.cyPx - topPx, bbox: [badge.bbox[0], badge.bbox[1] - topPx, badge.bbox[2], badge.bbox[3]] as const, component: { ...badge.component, cy: badge.component.cy - topPx, bboxY: badge.component.bboxY - topPx } }));
	const field = computeRibbonSupport(localImage, parameters);
	if (parameters.patchBadges) patchBadgeOcclusion(field, localImage, localBadges, parameters.corridorWidthPx);
	const sprites = matchBasketSprites(stage.brightMask, basketTemplate);
	const baskets = makeBaskets(sprites, topPx);
	const tees = makeTees(stage, sprites, topPx);
	const rawPairs = makeRawPairs(field, badges, tees, baskets, parameters, topPx);
	return {
		algo: THREE_FACTOR_ALGO,
		algoVersion: THREE_FACTOR_ALGO_VERSION,
		widthPx: image.width,
		heightPx: image.height,
		viewport: { topPx, bottomPx, sourceFrame: 'original-image' },
		parameters,
		brightMask: stage.brightMask,
		darkMask: stage.darkMask,
		badges,
		baskets,
		tees,
		field,
		rawPairs
	};
}
