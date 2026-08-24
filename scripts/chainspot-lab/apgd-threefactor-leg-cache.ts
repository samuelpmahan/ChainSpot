import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import basketSpriteData from '../../src/lib/detectors/threeFactor/assets/basket-sprite.json';
import logisticModelData from '../../src/lib/detectors/threeFactor/assets/logistic.json';
import { runBadgeStage } from '../../src/lib/detectors/threeFactor/badgeStage';
import {
	collectTeePoints,
	detectTeeRings,
	matchBasketSprites,
	prepareSpriteTemplate,
	type SpriteTemplate
} from '../../src/lib/detectors/threeFactor/endpoints';
import { predictProbs, type LogisticModel } from '../../src/lib/detectors/threeFactor/digits/logisticInference';
import { readCourseBadges, type BadgeReading, type DigitScorer } from '../../src/lib/detectors/threeFactor/digits/readBadges';
import { computeRibbonSupport, patchBadgeOcclusion } from '../../src/lib/detectors/threeFactor/ribbon';
import { routeBadgeLegs } from '../../src/lib/detectors/threeFactor/routing';
import { detectScreenChromeRegions, pointInScreenChrome } from '../../src/lib/detectors/threeFactor/screenChrome';
import type {
	BadgeEvidence,
	CorridorParams,
	RgbaImage,
	TeeEvidence
} from '../../src/lib/detectors/threeFactor/types';

const DEV_WIDTHS: Record<string, number> = {
	'DashsTrack-full': 40,
	'HeritagePark-full': 30,
	'Lenard-full': 37,
	'TowneLake-full': 37
};
const DEV_VIEWPORTS: Record<string, { topPx: number; bottomPx: number }> = {
	'DashsTrack-full': { topPx: 0, bottomPx: 2091 },
	'HeritagePark-full': { topPx: 429, bottomPx: 2544 },
	'Lenard-full': { topPx: 429, bottomPx: 2518 },
	'TowneLake-full': { topPx: 532, bottomPx: 2544 }
};
const VALIDATION_WIDTH = 37;
const FIELD_SCALE = 3;
const ORIENTATIONS = 12;
const WIDTHS_SRC = [24, 32, 40, 48, 56, 64] as const;
const ALIGNMENT_POWER = 2;
const WORST_WINDOW_SRC_PX = 90;
const SUPPORT_TAU = 0.5;

interface RgbaRaster {
	imageId: string;
	widthPx: number;
	heightPx: number;
	rgba: Uint8ClampedArray;
}
interface Annotation {
	holes: {
		number: number;
		tee: { xPx: number; yPx: number };
		basket: { xPx: number; yPx: number };
	}[];
}

const spriteTemplate = prepareSpriteTemplate(basketSpriteData as SpriteTemplate);
const logisticModel = logisticModelData as LogisticModel;
const digitScorer: DigitScorer = {
	name: 'nuthing-p2-logistic',
	scores: (mask) => predictProbs(logisticModel, mask)
};

function decode(path: string): RgbaRaster {
	const bytes = readFileSync(path);
	const ext = extname(path).toLowerCase();
	let width: number;
	let height: number;
	let data: Uint8Array;
	if (ext === '.png') {
		const png = PNG.sync.read(bytes);
		width = png.width;
		height = png.height;
		data = new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.byteLength);
	} else if (ext === '.jpg' || ext === '.jpeg') {
		const image = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
		width = image.width;
		height = image.height;
		data = new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength);
	} else {
		throw new Error(`Unsupported image extension: ${ext}`);
	}
	return {
		imageId: createHash('sha256').update(bytes).digest('hex'),
		widthPx: width,
		heightPx: height,
		rgba: new Uint8ClampedArray(data)
	};
}

function crop(raster: RgbaRaster, topPx: number, bottomPx: number): RgbaImage {
	const height = bottomPx - topPx;
	const data = new Uint8Array(raster.widthPx * height * 4);
	for (let y = 0; y < height; y++) {
		const source = (topPx + y) * raster.widthPx * 4;
		data.set(raster.rgba.slice(source, source + raster.widthPx * 4), y * raster.widthPx * 4);
	}
	return { width: raster.widthPx, height, data };
}

function clamp01(value: number): number {
	return Math.max(0, Math.min(1, value));
}
function darkFraction(component: { bboxX: number; bboxY: number; bboxW: number; bboxH: number }, dark: { width: number; data: Uint8Array }): number {
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
		.map((label) => ({
			label,
			confidence: [...String(label)].reduce(
				(product, digit, index) => product * (reading.digits[index]?.scores[Number(digit)] ?? 0),
				1
			)
		}))
		.sort((a, b) => b.confidence - a.confidence || a.label - b.label);
	const total = candidates.reduce((sum, candidate) => sum + candidate.confidence, 0);
	return candidates.map((candidate) => ({
		label: candidate.label,
		confidence: total > 0 ? candidate.confidence / total : 0
	}));
}
function makeLocalBadges(stage: ReturnType<typeof runBadgeStage>): BadgeEvidence[] {
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
		const component = entry.component;
		const candidates = labelCandidates(entry.reading);
		const confidence = entry.reading.confidence === Infinity
			? darkFraction(component, stage.darkMask)
			: clamp01(entry.reading.confidence);
		return {
			detId: `badge-${index}`,
			component,
			cxPx: component.cx,
			cyPx: component.cy,
			bbox: [component.bboxX, component.bboxY, component.bboxW, component.bboxH] as const,
			...(entry.plateBbox ? { plateBbox: entry.plateBbox as readonly [number, number, number, number] } : {}),
			source: entry.source,
			digits: [],
			label: candidates[0] ? String(candidates[0].label) : entry.reading.label || null,
			labelCandidates: candidates,
			confidence
		};
	});
}
function selectedLabelConfidence(badge: BadgeEvidence): number {
	if (badge.label === null) return -Infinity;
	const n = Number(badge.label);
	return badge.labelCandidates.find((candidate) => candidate.label === n)?.confidence ?? badge.confidence;
}
function chooseBadges(badges: readonly BadgeEvidence[]): BadgeEvidence[] {
	const byLabel = new Map<number, BadgeEvidence>();
	for (const badge of badges) {
		if (badge.label === null) continue;
		const label = Number(badge.label);
		if (!Number.isInteger(label) || label < 1 || label > 18) continue;
		const current = byLabel.get(label);
		if (!current || selectedLabelConfidence(badge) > selectedLabelConfidence(current) ||
			(selectedLabelConfidence(badge) === selectedLabelConfidence(current) && badge.detId < current.detId)) {
			byLabel.set(label, badge);
		}
	}
	return [...byLabel.entries()].sort((a, b) => a[0] - b[0]).map(([, badge]) => badge);
}
function makeLocalTees(stage: ReturnType<typeof runBadgeStage>, sprites: ReturnType<typeof matchBasketSprites>): TeeEvidence[] {
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
			const bbox = ring
				? [ring.bboxX, ring.bboxY, ring.bboxW, ring.bboxH] as const
				: component
					? [component.bboxX ?? Math.round(tee.cx - 6), component.bboxY ?? Math.round(tee.cy - 6), component.bboxW, component.bboxH] as const
					: [Math.round(tee.cx - 6), Math.round(tee.cy - 6), 12, 12] as const;
			return {
				detId: '',
				xPx: tee.cx,
				yPx: tee.cy,
				tier: tee.tier,
				angleRad: ring?.angle ?? component?.angle ?? null,
				...(ring ? { ring: { bbox, area: ring.holeArea, elongation: ring.elongation, ringFrac: ring.ringFrac } } : {}),
				bbox,
				area: ring?.holeArea ?? component?.area ?? 0,
				fill: component?.fill ?? ring?.ringFrac ?? 0,
				onRing: sprites.some((sprite) => Math.abs(Math.hypot(tee.cx - sprite.cx, tee.cy - sprite.cy) - 84) <= 12)
			};
		})
		.sort((a, b) => a.yPx - b.yPx || a.xPx - b.xPx || a.tier.localeCompare(b.tier))
		.map((tee, index) => ({ ...tee, detId: `tee-${index}` }));
}
function matchNearest(points: readonly { x: number; y: number }[], target: { xPx: number; yPx: number }, maxDistance: number): number {
	let best = -1;
	let bestDistance = maxDistance;
	for (let i = 0; i < points.length; i++) {
		const distance = Math.hypot(points[i].x - target.xPx, points[i].y - target.yPx);
		if (distance <= bestDistance) {
			best = i;
			bestDistance = distance;
		}
	}
	return best;
}

function main(): void {
	const args = process.argv.slice(2);
	const take = (flag: string): string | null => {
		const index = args.indexOf(flag);
		if (index < 0) return null;
		const value = args[index + 1] ?? null;
		args.splice(index, 2);
		return value;
	};
	const input = take('--input');
	const out = take('--out');
	const course = take('--course') ?? 'validation-course';
	const annotationPath = take('--annotation');
	const explicitWidth = take('--corridor-width');
	if (!input || !out) throw new Error('Usage: apgd-threefactor-leg-cache.ts --input IMAGE --out CACHE.json --course NAME [--annotation DEV.json] [--corridor-width PX]');
	const raster = decode(resolve(input));
	const corridorWidthPx = explicitWidth ? Number(explicitWidth) : (DEV_WIDTHS[course] ?? VALIDATION_WIDTH);
	const viewport = annotationPath ? DEV_VIEWPORTS[course] : { topPx: 0, bottomPx: raster.heightPx };
	if (!viewport) throw new Error(`No frozen dev viewport for ${course}`);
	const localImage = crop(raster, viewport.topPx, viewport.bottomPx);
	const stage = runBadgeStage(localImage);
	const localBadges = makeLocalBadges(stage);
	const badges = chooseBadges(localBadges);
	const parameters: CorridorParams = {
		corridorWidthPx,
		fieldScale: FIELD_SCALE,
		orientations: ORIENTATIONS,
		widthsSrc: [...WIDTHS_SRC],
		patchBadges: true,
		alignmentPower: ALIGNMENT_POWER,
		worstWindowSrcPx: WORST_WINDOW_SRC_PX,
		supportTau: SUPPORT_TAU,
		zfit: false
	};
	const field = computeRibbonSupport(localImage, parameters);
	patchBadgeOcclusion(field, localImage, localBadges, corridorWidthPx);
	const sprites = matchBasketSprites(stage.brightMask, spriteTemplate);
	const tees = makeLocalTees(stage, sprites);
	const baskets = [...sprites]
		.sort((a, b) => a.y - b.y || a.x - b.x || b.score - a.score)
		.map((sprite, index) => ({
			id: `B${index}`,
			x: sprite.tipX,
			y: sprite.tipY,
			spriteCx: sprite.cx,
			spriteCy: sprite.cy,
			score: sprite.score,
			onFrac: sprite.onFrac,
			offFrac: sprite.offFrac
		}));
	const cacheTees = tees.map((tee, index) => ({
		id: `T${index}`,
		x: tee.xPx,
		y: tee.yPx,
		tier: tee.tier,
		angle: tee.angleRad,
		onRing: tee.onRing,
		fill: tee.fill,
		area: tee.area
	}));
	const teePoints = cacheTees.map((tee) => ({ id: tee.id, xPx: tee.x, yPx: tee.y }));
	const basketPoints = baskets.map((basket) => ({ id: basket.id, xPx: basket.x, yPx: basket.y }));
	const cacheBadges = badges.map((badge) => {
		const routed = routeBadgeLegs(
			field,
			{ id: badge.detId, xPx: badge.cxPx, yPx: badge.cyPx },
			teePoints,
			basketPoints,
			0
		);
		const encode = (leg: (typeof routed.tees)[number]) => {
			const path: number[] = [];
			for (const [xPx, yPx] of leg.path) path.push(Math.round(xPx / field.scale), Math.round(yPx / field.scale));
			return { endpointId: leg.endpointId, geodesic: Number.isFinite(leg.geodesic) ? leg.geodesic : null, path, reachable: leg.reachable };
		};
		return {
			id: badge.detId,
			label: badge.label as string,
			confidence: selectedLabelConfidence(badge),
			cx: badge.cxPx,
			cy: badge.cyPx,
			legs: [...routed.tees.map(encode), ...routed.baskets.map(encode)]
		};
	});
	let judgments: { hole: number; trueTee: number; trueBasket: number }[] | undefined;
	if (annotationPath) {
		const annotation = JSON.parse(readFileSync(resolve(annotationPath), 'utf8')) as Annotation;
		judgments = annotation.holes.map((hole) => ({
			hole: hole.number,
			trueTee: matchNearest(cacheTees, hole.tee, 18),
			trueBasket: matchNearest(baskets, hole.basket, 16)
		}));
	}
	const output = {
		course,
		imageId: raster.imageId,
		full: { width: raster.widthPx, height: raster.heightPx },
		viewport: { topPx: viewport.topPx, bottomPx: viewport.bottomPx, sourceFrame: 'original-image' as const },
		field: { width: field.width, height: field.height, scale: field.scale },
		params: parameters,
		endpoints: { tees: cacheTees, baskets },
		badges: cacheBadges,
		...(judgments ? { judgments } : {}),
		audit: {
			allBadges: localBadges.length,
			selectedBadges: cacheBadges.length,
			allBadgeLabels: localBadges.map((badge) => ({ detId: badge.detId, label: badge.label, confidence: selectedLabelConfidence(badge) })),
			tees: cacheTees.length,
			baskets: baskets.length,
			legs: cacheBadges.reduce((sum, badge) => sum + badge.legs.length, 0),
			cartesianPairsMaterialized: 0
		}
	};
	const outputPath = resolve(out);
	mkdirSync(dirname(outputPath), { recursive: true });
	writeFileSync(outputPath, JSON.stringify(output, null, 2));
	const stem = outputPath.replace(/\.json$/i, '');
	writeFileSync(`${stem}-field.bin`, Buffer.from(field.support.buffer, field.support.byteOffset, field.support.byteLength));
	writeFileSync(`${stem}-theta.bin`, Buffer.from(field.bestTheta.buffer, field.bestTheta.byteOffset, field.bestTheta.byteLength));
	console.log(`${course}: badges=${cacheBadges.length}/${localBadges.length} tees=${cacheTees.length} baskets=${baskets.length} legs=${output.audit.legs} pairs=0 viewport=[${viewport.topPx},${viewport.bottomPx}) W=${corridorWidthPx}`);
	if (judgments) console.log(`${course}: truth candidate recall tee=${judgments.filter((row) => row.trueTee >= 0).length}/${judgments.length} basket=${judgments.filter((row) => row.trueBasket >= 0).length}/${judgments.length}`);
}

main();
