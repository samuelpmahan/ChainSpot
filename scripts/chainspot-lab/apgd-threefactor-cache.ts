import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import { measureThreeFactor } from '../../src/lib/detectors/threeFactor';
import type { RgbaRaster } from '../../src/lib/detect';
import type { BadgeEvidence, LegEvidence, ThreeFactorMeasurement } from '../../src/lib/detectors/threeFactor';

const DEV_WIDTHS: Record<string, number> = {
	'DashsTrack-full': 40,
	'HeritagePark-full': 30,
	'Lenard-full': 37,
	'TowneLake-full': 37
};
const VALIDATION_WIDTH = 37;

interface Annotation {
	holes: {
		number: number;
		tee: { xPx: number; yPx: number };
		basket: { xPx: number; yPx: number };
	}[];
}

function decode(path: string): RgbaRaster {
	const bytes = readFileSync(path);
	const ext = extname(path).toLowerCase();
	let width: number;
	let height: number;
	let rgba: Uint8Array;
	if (ext === '.png') {
		const png = PNG.sync.read(bytes);
		width = png.width;
		height = png.height;
		rgba = new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.byteLength);
	} else if (ext === '.jpg' || ext === '.jpeg') {
		const image = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
		width = image.width;
		height = image.height;
		rgba = new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength);
	} else {
		throw new Error(`Unsupported image extension: ${ext}`);
	}
	return {
		imageId: createHash('sha256').update(bytes).digest('hex'),
		widthPx: width,
		heightPx: height,
		rgba: new Uint8ClampedArray(rgba)
	};
}

function selectedLabelConfidence(badge: BadgeEvidence): number {
	if (badge.label === null) return -Infinity;
	const n = Number(badge.label);
	return badge.labelCandidates.find((candidate) => candidate.label === n)?.confidence ?? badge.confidence;
}

function chooseBadges(measurement: ThreeFactorMeasurement): BadgeEvidence[] {
	const byLabel = new Map<number, BadgeEvidence>();
	for (const badge of measurement.badges) {
		if (badge.label === null) continue;
		const label = Number(badge.label);
		if (!Number.isInteger(label) || label < 1 || label > 18) continue;
		const current = byLabel.get(label);
		if (
			!current ||
			selectedLabelConfidence(badge) > selectedLabelConfidence(current) ||
			(selectedLabelConfidence(badge) === selectedLabelConfidence(current) && badge.detId < current.detId)
		) {
			byLabel.set(label, badge);
		}
	}
	return [...byLabel.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([, badge]) => badge);
}

function localLeg(
	leg: LegEvidence,
	endpointId: string,
	scale: number,
	topPx: number
): { endpointId: string; geodesic: number | null; path: number[]; reachable: boolean } {
	const path: number[] = [];
	for (const [xPx, yPx] of leg.path) {
		path.push(Math.round(xPx / scale), Math.round((yPx - topPx) / scale));
	}
	return {
		endpointId,
		geodesic: Number.isFinite(leg.geodesic) ? leg.geodesic : null,
		path,
		reachable: leg.reachable
	};
}

function matchNearest(
	points: readonly { x: number; y: number }[],
	target: { xPx: number; yPx: number },
	maxDistance: number
): number {
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
	if (!input || !out) {
		throw new Error('Usage: apgd-threefactor-cache.ts --input IMAGE --out CACHE.json --course NAME [--annotation DEV.json] [--corridor-width PX]');
	}

	const raster = decode(resolve(input));
	const corridorWidthPx = explicitWidth ? Number(explicitWidth) : (DEV_WIDTHS[course] ?? VALIDATION_WIDTH);
	const measurement = measureThreeFactor(raster, {
		corridorWidthPx,
		zfit: false
	});
	const topPx = measurement.viewport.topPx;
	const scale = measurement.field.scale;
	const badges = chooseBadges(measurement);
	const teeId = new Map(measurement.tees.map((tee, index) => [tee.detId, `T${index}`]));
	const basketId = new Map(measurement.baskets.map((basket, index) => [basket.detId, `B${index}`]));
	const selectedBadgeIds = new Set(badges.map((badge) => badge.detId));

	const cacheBadges = badges.map((badge) => {
		const legs = new Map<string, ReturnType<typeof localLeg>>();
		for (const pair of measurement.rawPairs) {
			if (pair.badgeId !== badge.detId) continue;
			const tid = teeId.get(pair.teeId);
			const bid = basketId.get(pair.basketId);
			if (tid && !legs.has(tid)) legs.set(tid, localLeg(pair.teeLeg, tid, scale, topPx));
			if (bid && !legs.has(bid)) legs.set(bid, localLeg(pair.basketLeg, bid, scale, topPx));
		}
		return {
			id: badge.detId,
			label: badge.label as string,
			confidence: selectedLabelConfidence(badge),
			cx: badge.cxPx,
			cy: badge.cyPx - topPx,
			legs: [...legs.values()].sort((a, b) => a.endpointId.localeCompare(b.endpointId))
		};
	});

	const tees = measurement.tees.map((tee, index) => ({
		id: `T${index}`,
		x: tee.xPx,
		y: tee.yPx - topPx,
		tier: tee.tier,
		angle: tee.angleRad,
		onRing: tee.onRing,
		fill: tee.fill,
		area: tee.area
	}));
	const baskets = measurement.baskets.map((basket, index) => ({
		id: `B${index}`,
		x: basket.tipXPx,
		y: basket.tipYPx - topPx,
		spriteCx: basket.centerXPx,
		spriteCy: basket.centerYPx - topPx,
		score: basket.score,
		onFrac: basket.onFrac,
		offFrac: basket.offFrac
	}));

	let judgments: { hole: number; trueTee: number; trueBasket: number }[] | undefined;
	if (annotationPath) {
		// Candidate generation is complete before truth is opened. Truth exists only
		// to attach dev evaluation/training ownership to already-measured candidates.
		const annotation = JSON.parse(readFileSync(resolve(annotationPath), 'utf8')) as Annotation;
		judgments = annotation.holes.map((hole) => ({
			hole: hole.number,
			trueTee: matchNearest(
				measurement.tees.map((tee) => ({ x: tee.xPx, y: tee.yPx })),
				hole.tee,
				18
			),
			trueBasket: matchNearest(
				measurement.baskets.map((basket) => ({ x: basket.tipXPx, y: basket.tipYPx })),
				hole.basket,
				16
			)
		}));
	}

	const output = {
		course,
		imageId: raster.imageId,
		full: { width: raster.widthPx, height: raster.heightPx },
		viewport: measurement.viewport,
		field: { width: measurement.field.width, height: measurement.field.height, scale },
		params: measurement.parameters,
		endpoints: { tees, baskets },
		badges: cacheBadges,
		...(judgments ? { judgments } : {}),
		audit: {
			allBadges: measurement.badges.length,
			selectedBadges: cacheBadges.length,
			allBadgeLabels: measurement.badges.map((badge) => ({ detId: badge.detId, label: badge.label, confidence: selectedLabelConfidence(badge) })),
			tees: tees.length,
			baskets: baskets.length,
			rawPairs: measurement.rawPairs.filter((pair) => selectedBadgeIds.has(pair.badgeId)).length
		}
	};
	const outputPath = resolve(out);
	mkdirSync(dirname(outputPath), { recursive: true });
	writeFileSync(outputPath, JSON.stringify(output, null, 2));
	const stem = outputPath.replace(/\.json$/i, '');
	writeFileSync(`${stem}-field.bin`, Buffer.from(measurement.field.support.buffer, measurement.field.support.byteOffset, measurement.field.support.byteLength));
	writeFileSync(`${stem}-theta.bin`, Buffer.from(measurement.field.bestTheta.buffer, measurement.field.bestTheta.byteOffset, measurement.field.bestTheta.byteLength));
	console.log(`${course}: badges=${cacheBadges.length}/${measurement.badges.length} tees=${tees.length} baskets=${baskets.length} pairs=${output.audit.rawPairs} viewport=[${topPx},${measurement.viewport.bottomPx}) W=${corridorWidthPx}`);
	if (judgments) {
		console.log(`${course}: truth candidate recall tee=${judgments.filter((x) => x.trueTee >= 0).length}/${judgments.length} basket=${judgments.filter((x) => x.trueBasket >= 0).length}/${judgments.length}`);
	}
}

main();
