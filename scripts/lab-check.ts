import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { runBadgeStage } from '../src/lib/nuthing/badgeStage';
import { readCourseBadges } from '../src/lib/nuthing/digits/readBadges';
import type { DigitScorer } from '../src/lib/nuthing/digits/readBadges';
import { predictProbs, type LogisticModel } from '../src/lib/nuthing/digits/logistic';
import { runEndpointStage } from '../src/lib/nuthing/endpointStage';
import {
	matchBasketSprites,
	prepareSpriteTemplate,
	type SpriteTemplate,
} from '../src/lib/nuthing/endpoints';
import type { ComponentStats } from '../src/lib/nuthing/components';
import type { RgbaImage } from '../src/lib/nuthing/raster';
import { cropRows, detectMapViewport } from '../src/lib/nuthing/viewport';
import { decodeImageFile } from './nuthing/decode';

type Stage = 'badges' | 'baskets' | 'tees';
type Color = readonly [number, number, number];

const COLORS = {
	badge: [0, 240, 255] as Color,
	basket: [255, 70, 65] as Color,
	tip: [255, 230, 0] as Color,
	ring: [60, 255, 100] as Color,
	component: [255, 145, 0] as Color,
	diamond: [120, 150, 255] as Color,
};

function sha256(data: Uint8Array | Buffer): string {
	return createHash('sha256').update(data).digest('hex');
}

function findCourseRaster(corpusRoot: string, course: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(course)) throw new Error(`Invalid course name: ${course}`);
	const courseDir = join(corpusRoot, 'dev', course);
	const candidates = readdirSync(courseDir)
		.filter((name) => /-full\.(?:png|jpe?g|rgba\.bin)$/i.test(name))
		.sort((a, b) => a.localeCompare(b));
	if (candidates.length !== 1) {
		throw new Error(`Expected exactly one full raster in ${courseDir}; found ${candidates.length}`);
	}
	return join(courseDir, candidates[0]);
}

function encodePng(image: RgbaImage): Buffer {
	const png = new PNG({ width: image.width, height: image.height });
	Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength).copy(png.data);
	return PNG.sync.write(png);
}

function setPixel(png: PNG, x: number, y: number, color: Color): void {
	if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
	const i = (Math.round(y) * png.width + Math.round(x)) * 4;
	png.data[i] = color[0];
	png.data[i + 1] = color[1];
	png.data[i + 2] = color[2];
	png.data[i + 3] = 255;
}

function drawLine(png: PNG, x0: number, y0: number, x1: number, y1: number, color: Color, width = 2): void {
	const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
	for (let i = 0; i <= steps; i++) {
		const x = x0 + ((x1 - x0) * i) / steps;
		const y = y0 + ((y1 - y0) * i) / steps;
		for (let dy = -width; dy <= width; dy++) {
			for (let dx = -width; dx <= width; dx++) setPixel(png, x + dx, y + dy, color);
		}
	}
}

function drawRect(png: PNG, x: number, y: number, w: number, h: number, color: Color, width = 2): void {
	drawLine(png, x, y, x + w, y, color, width);
	drawLine(png, x + w, y, x + w, y + h, color, width);
	drawLine(png, x + w, y + h, x, y + h, color, width);
	drawLine(png, x, y + h, x, y, color, width);
}

function drawCross(png: PNG, x: number, y: number, color: Color, radius = 8): void {
	drawLine(png, x - radius, y, x + radius, y, color, 1);
	drawLine(png, x, y - radius, x, y + radius, color, 1);
}

function componentEvidence(c: ComponentStats) {
	return {
		label: c.label,
		center: { x: c.cx, y: c.cy },
		bbox: { x: c.bboxX, y: c.bboxY, width: c.bboxW, height: c.bboxH },
		area: c.area,
		major: c.major,
		minor: c.minor,
		angleRadians: c.angle,
		fill: c.fill,
	};
}

function commonProvenance(
	stage: Stage,
	course: string,
	sourcePath: string,
	sourceBytes: Buffer,
	full: RgbaImage,
	cropped: RgbaImage,
	viewport: { top: number; bottom: number },
) {
	return {
		schemaVersion: 1,
		course,
		stage,
		coordinateFrame: {
			name: 'production-auto-cropped-map-raster',
			origin: 'cropped top-left',
			xAxis: 'right',
			yAxis: 'down',
			widthPx: cropped.width,
			heightPx: cropped.height,
		},
		cropProvenanceOnly: {
			implementation: 'src/lib/nuthing/viewport.ts:detectMapViewport+cropRows',
			sourceWidthPx: full.width,
			sourceHeightPx: full.height,
			sourceRows: [viewport.top, viewport.bottom],
		},
		inputs: {
			sourcePath,
			sourceSha256: sha256(sourceBytes),
			croppedRgbaSha256: sha256(Buffer.from(cropped.data.buffer, cropped.data.byteOffset, cropped.data.byteLength)),
		},
	};
}

function main(): void {
	const [stageArg, course, ...rest] = process.argv.slice(2);
	if (!['badges', 'baskets', 'tees'].includes(stageArg) || !course || rest.length) {
		console.error('Usage: ./lab check <badges|baskets|tees> <course>');
		process.exit(2);
	}
	const stage = stageArg as Stage;
	const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
	const corpusRoot = process.env.CHAINSPOT_CORPUS_PATH ?? resolve(repoRoot, '..', 'chainspot-corpus');
	const sourcePath = findCourseRaster(corpusRoot, course);
	const sourceBytes = readFileSync(sourcePath);
	const full = decodeImageFile(sourcePath);
	const viewport = detectMapViewport(full);
	const cropped = cropRows(full, viewport);
	const evidenceDir = join(repoRoot, 'lab-artifacts', course, 'sol-assisted-v1-evidence');
	mkdirSync(evidenceDir, { recursive: true });
	const outputJson = join(evidenceDir, `${stage}.measurements.json`);
	const outputPng = join(evidenceDir, `${stage}-course.png`);
	const png = PNG.sync.read(encodePng(cropped));
	const common = commonProvenance(stage, course, sourcePath, sourceBytes, full, cropped, viewport);
	let payload: unknown;

	if (stage === 'badges') {
		const modelPath = join(repoRoot, 'resources', 'nuthing-p2', 'digits', 'models', 'logistic.json');
		const modelBytes = readFileSync(modelPath);
		const model = JSON.parse(modelBytes.toString('utf8')) as LogisticModel;
		const scorer: DigitScorer = {
			name: 'logistic',
			scores: (mask) => predictProbs(model, mask),
		};
		const badgeStage = runBadgeStage(cropped);
		const readings = readCourseBadges(badgeStage, scorer);
		for (const reading of readings) {
			const b = reading.badge;
			drawRect(png, b.bboxX, b.bboxY, b.bboxW, b.bboxH, COLORS.badge);
			drawCross(png, b.cx, b.cy, COLORS.badge);
		}
		payload = {
			...common,
			implementation: {
				localization: 'src/lib/nuthing/badgeStage.ts:runBadgeStage',
				reading: 'src/lib/nuthing/digits/readBadges.ts:readCourseBadges',
				modelPath,
				modelSha256: sha256(modelBytes),
			},
			candidateCount: readings.length,
			candidates: readings.map((reading) => ({
				plate: componentEvidence(reading.badge),
				interiorBbox: reading.glyph.interiorBbox,
				decodedLabel: reading.label,
				minimumDigitMargin: Number.isFinite(reading.confidence) ? reading.confidence : null,
				digits: reading.digits.map((digit) => ({
					glyphLocalBbox: digit.candidate.bbox,
					segmentationMethod: digit.candidate.method,
					predicted: digit.predicted,
					runnerUp: digit.runnerUp,
					margin: digit.margin,
					scoresByDigit: Object.fromEntries(model.classes.map((label, i) => [label, digit.scores[i]])),
				})),
			})),
		};
	} else {
		const templatePath = join(repoRoot, 'resources', 'nuthing-p2', 'endpoints', 'basket-sprite.json');
		const templateBytes = readFileSync(templatePath);
		const template = JSON.parse(templateBytes.toString('utf8')) as SpriteTemplate;
		if (stage === 'baskets') {
			const badgeStage = runBadgeStage(cropped);
			const candidates = matchBasketSprites(badgeStage.brightMask, prepareSpriteTemplate(template));
			for (const candidate of candidates) {
				drawRect(png, candidate.x, candidate.y, template.width, template.height, COLORS.basket);
				drawCross(png, candidate.tipX, candidate.tipY, COLORS.tip);
			}
			payload = {
				...common,
				implementation: {
					brightMask: 'src/lib/nuthing/badgeStage.ts:runBadgeStage',
					matching: 'src/lib/nuthing/endpoints.ts:prepareSpriteTemplate+matchBasketSprites',
					templatePath,
					templateSha256: sha256(templateBytes),
					templateSize: { width: template.width, height: template.height },
				},
				candidateCount: candidates.length,
				candidates,
			};
		} else {
			const result = runEndpointStage(cropped, template);
			for (const ring of result.rings) {
				const color = ring.kind === 'diamond' ? COLORS.diamond : COLORS.ring;
				drawRect(png, ring.bboxX, ring.bboxY, ring.bboxW, ring.bboxH, color);
				drawCross(png, ring.cx, ring.cy, color, 6);
			}
			for (const tee of result.tees) {
				if (tee.tier === 'component') drawCross(png, tee.cx, tee.cy, COLORS.component, 9);
			}
			const componentFor = (x: number, y: number) =>
				result.brightComponents.find((c) => Math.abs(c.cx - x) < 1e-9 && Math.abs(c.cy - y) < 1e-9);
			payload = {
				...common,
				implementation: {
					endpointComposition: 'src/lib/nuthing/endpointStage.ts:runEndpointStage',
					rings: 'src/lib/nuthing/endpoints.ts:detectTeeRings',
					candidateCollection: 'src/lib/nuthing/endpoints.ts:collectTeePoints',
					templatePath,
					templateSha256: sha256(templateBytes),
				},
				recoveredTier: {
					used: false,
					reason: 'Existing recovered-tee probe consumes truth basket coordinates and hard-coded course answers; no truth-independent recovered measurement was found.',
				},
				chromeRegions: result.chromeRegions,
				ringCount: result.rings.length,
				rings: result.rings,
				teeCandidateCount: result.tees.length,
				teeCandidates: result.tees.map((tee) => ({
					center: { x: tee.cx, y: tee.cy },
					tier: tee.tier,
					ring: tee.ring,
					component: tee.tier === 'component' && componentFor(tee.cx, tee.cy)
						? componentEvidence(componentFor(tee.cx, tee.cy) as ComponentStats)
						: undefined,
				})),
			};
		}
	}

	writeFileSync(outputJson, `${JSON.stringify(payload, null, 2)}\n`);
	writeFileSync(outputPng, PNG.sync.write(png));
	console.log(`course: ${course}`);
	console.log(`stage: ${stage}`);
	console.log(`crop rows: [${viewport.top}, ${viewport.bottom}) (provenance only)`);
	console.log(`canonical frame: ${cropped.width}x${cropped.height} crop-local pixels`);
	console.log(`measurements: ${outputJson}`);
	console.log(`course evidence: ${outputPng}`);
}

main();
