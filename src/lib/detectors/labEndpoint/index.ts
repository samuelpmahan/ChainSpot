import type { Detector, OnDetectorEmission, RgbaRaster, UiObjectDetected } from '../../detect';
import basketSpriteData from './assets/basket-sprite.json';
import logisticModelData from './assets/logistic.json';
import { runBadgeStage } from './badgeStage';
import type { ComponentStats } from './components';
import {
	collectTeePoints,
	detectTeeRings,
	matchBasketSprites,
	prepareSpriteTemplate,
	type SpriteTemplate
} from './endpoints';
import { predictProbs, type LogisticModel } from './digits/logisticInference';
import { readCourseBadges, type BadgeReading, type DigitScorer } from './digits/readBadges';
import { detectScreenChromeRegions, pointInScreenChrome } from './screenChrome';

export const LAB_ENDPOINT_ALGO = 'lab-quick-endpoints';
export const LAB_ENDPOINT_ALGO_VERSION = '1.0.0';

const basketTemplate = prepareSpriteTemplate(basketSpriteData as SpriteTemplate);
const logisticModel = logisticModelData as LogisticModel;
const digitScorer: DigitScorer = {
	name: 'nuthing-p2-logistic',
	scores: (mask) => predictProbs(logisticModel, mask)
};

function clamp01(value: number): number {
	return Math.max(0, Math.min(1, value));
}

function badgeDarkFraction(
	badge: ComponentStats,
	dark: { width: number; data: Uint8Array }
): number {
	let count = 0;
	for (let y = badge.bboxY; y < badge.bboxY + badge.bboxH; y++) {
		const row = y * dark.width;
		for (let x = badge.bboxX; x < badge.bboxX + badge.bboxW; x++) count += dark.data[row + x];
	}
	return count / Math.max(1, badge.bboxW * badge.bboxH);
}

function labelCandidates(reading: BadgeReading): { n: number; confidence: number }[] {
	if (reading.digits.length === 0) return [];
	const raw = Array.from({ length: 18 }, (_, index) => index + 1)
		.filter((n) => String(n).length === reading.digits.length)
		.map((n) => {
			const confidence = [...String(n)].reduce(
				(product, digit, index) => product * (reading.digits[index]?.scores[Number(digit)] ?? 0),
				1
			);
			return { n, confidence };
		})
		.sort((a, b) => b.confidence - a.confidence || a.n - b.n);
	const total = raw.reduce((sum, candidate) => sum + candidate.confidence, 0);
	return raw.map((candidate) => ({
		n: candidate.n,
		confidence: total > 0 ? candidate.confidence / total : 0
	}));
}

function emitObject(
	emit: OnDetectorEmission,
	image: RgbaRaster,
	detId: string,
	objType: UiObjectDetected['objType'],
	xPx: number,
	yPx: number,
	confidence: number
): void {
	emit({
		kind: 'object',
		imageId: image.imageId,
		detId,
		objType,
		xPx,
		yPx,
		confidence: clamp01(confidence),
		algo: LAB_ENDPOINT_ALGO,
		algoVersion: LAB_ENDPOINT_ALGO_VERSION
	});
}

/**
 * LAB's fast mask/component endpoint pass behind the app's Detector contract.
 * It emits object observations and badge-label readings. Ownership association
 * is intentionally a later Detector pass over these stable detIds.
 */
export const labEndpointDetector: Detector = async (image, emit) => {
	if (image.widthPx <= 0 || image.heightPx <= 0)
		throw new Error('Detector image dimensions must be positive.');
	if (image.rgba.length !== image.widthPx * image.heightPx * 4) {
		throw new Error('Detector RGBA byte length does not match image dimensions.');
	}

	const stage = runBadgeStage({ width: image.widthPx, height: image.heightPx, data: image.rgba });
	const badgeIds = stage.badges.map((badge, index) => {
		const detId = `badge-${index}`;
		emitObject(
			emit,
			image,
			detId,
			'hole-badge',
			badge.cx,
			badge.cy,
			badgeDarkFraction(badge, stage.darkMask)
		);
		return detId;
	});

	for (const [index, reading] of readCourseBadges(stage, digitScorer).entries()) {
		const candidates = labelCandidates(reading);
		const best = candidates[0];
		if (!best) continue;
		emit({
			kind: 'label',
			imageId: image.imageId,
			detId: badgeIds[index],
			n: best.n,
			confidence: best.confidence,
			candidates: candidates.slice(1, 4),
			algo: LAB_ENDPOINT_ALGO,
			algoVersion: LAB_ENDPOINT_ALGO_VERSION
		});
	}

	const sprites = matchBasketSprites(stage.brightMask, basketTemplate);
	for (const [index, sprite] of sprites.entries()) {
		emitObject(emit, image, `basket-${index}`, 'basket', sprite.tipX, sprite.tipY, sprite.score);
	}

	const chromeRegions = detectScreenChromeRegions(
		stage.brightComponents,
		image.widthPx,
		image.heightPx
	);
	const insideBadge = (x: number, y: number): boolean =>
		stage.badges.some(
			(badge) =>
				x >= badge.bboxX - 3 &&
				x <= badge.bboxX + badge.bboxW + 3 &&
				y >= badge.bboxY - 3 &&
				y <= badge.bboxY + badge.bboxH + 3
		);
	const attributedToChrome = (x: number, y: number): boolean =>
		pointInScreenChrome(x, y, chromeRegions);
	const rings = detectTeeRings(stage.brightMask).filter(
		(ring) => !insideBadge(ring.cx, ring.cy) && !attributedToChrome(ring.cx, ring.cy)
	);
	const badgeLabels = new Set(stage.badges.map((badge) => badge.label));
	const teeComponents = stage.brightComponents.filter(
		(component) =>
			!badgeLabels.has(component.label) &&
			!insideBadge(component.cx, component.cy) &&
			!attributedToChrome(component.cx, component.cy)
	);
	const tees = collectTeePoints(rings, teeComponents, sprites);
	for (const [index, tee] of tees.entries()) {
		emitObject(emit, image, `tee-${index}`, 'tee', tee.cx, tee.cy, tee.ring?.ringFrac ?? 0.5);
	}
};
