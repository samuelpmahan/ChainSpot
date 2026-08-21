import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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
type Point = { xPx: number; yPx: number };

interface ApprovedEndpoint {
	hole: number;
	tee: Point;
	badge: Point;
	basket: Point;
}

interface EndpointGateFixture {
	schemaVersion: number;
	status: string;
	course: string;
	canonicalFrame: {
		widthPx: number;
		heightPx: number;
		origin: string;
		xAxis: string;
		yAxis: string;
	};
	facts: ApprovedEndpoint[];
}

interface GateCandidate {
	point: Point;
	identity: string;
}

const POSITION_TOLERANCE_PX: Record<Stage, number> = {
	badges: 0,
	baskets: 0,
	tees: 0,
};

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

function pointText(point: Point): string {
	return `(${point.xPx}, ${point.yPx})`;
}

function nearestCandidate(approved: Point, candidates: GateCandidate[]): { candidate: GateCandidate; distancePx: number } | undefined {
	let nearest: { candidate: GateCandidate; distancePx: number } | undefined;
	for (const candidate of candidates) {
		const distancePx = Math.hypot(candidate.point.xPx - approved.xPx, candidate.point.yPx - approved.yPx);
		if (!nearest || distancePx < nearest.distancePx) nearest = { candidate, distancePx };
	}
	return nearest;
}

function endpointGateReport(
	stage: Stage,
	course: string,
	fixturePath: string,
	fixture: EndpointGateFixture,
	cropped: RgbaImage,
	candidates: GateCandidate[],
): { passed: boolean; lines: string[] } {
	if (fixture.course !== course) throw new Error(`Gate fixture course ${fixture.course} does not match ${course}`);
	if (fixture.canonicalFrame.widthPx !== cropped.width || fixture.canonicalFrame.heightPx !== cropped.height) {
		throw new Error(
			`Gate fixture frame ${fixture.canonicalFrame.widthPx}x${fixture.canonicalFrame.heightPx} does not match current crop ${cropped.width}x${cropped.height}`,
		);
	}
	if (fixture.facts.length !== 18) throw new Error(`Expected 18 approved endpoint facts; found ${fixture.facts.length}`);

	const object = stage === 'badges' ? 'badge' : stage === 'baskets' ? 'basket' : 'tee';
	const tolerancePx = POSITION_TOLERANCE_PX[stage];
	const lines = [
		'',
		`GATE ${course} / ${stage}`,
		`fixture: ${fixturePath}`,
		`fixture status: ${fixture.status}`,
		`canonical frame: ${cropped.width}x${cropped.height} crop-local pixels`,
		`position tolerance: ${tolerancePx} px (exact fixture localization; no tolerance is encoded in the fixture)`,
	];
	let failures = 0;

	if (stage !== 'badges') {
		lines.push(
			`instrument limitation: current ${stage} output has no hole ownership labels; proximity is not used to fabricate ownership.`,
		);
	}

	for (const fact of fixture.facts) {
		const approved = fact[object];
		const stageCandidates = stage === 'badges'
			? candidates.filter((candidate) => candidate.identity === `H${fact.hole}`)
			: candidates;
		const nearest = nearestCandidate(approved, stageCandidates);
		const changed: string[] = [];

		if (!nearest) {
			changed.push('missing approved object');
		} else if (nearest.distancePx > tolerancePx) {
			changed.push(`localization changed by ${nearest.distancePx.toFixed(6)} px`);
		}
		if (stage === 'badges' && stageCandidates.length > 1) {
			changed.push(`identity ambiguous: ${stageCandidates.length} candidates decode as H${fact.hole}`);
		}
		if (stage === 'baskets') changed.push('ownership unavailable in current detector output');
		if (stage === 'tees') {
			changed.push('identity unavailable: current output establishes only tee-like morphology');
			changed.push('ownership unavailable in current detector output');
		}

		if (!changed.length) continue;
		failures++;
		lines.push('', `FAIL ${course} / ${stage} / H${fact.hole}`, '');
		lines.push('approved:', `  identity ${object}`, `  owner H${fact.hole}`, `  center ${pointText(approved)}`);
		lines.push('', 'current:');
		if (!nearest) {
			lines.push('  missing');
		} else {
			lines.push(`  testimony ${nearest.candidate.identity}`);
			lines.push(`  nearest unassigned center ${pointText(nearest.candidate.point)}`);
			lines.push(`  distance from approved center ${nearest.distancePx.toFixed(6)} px`);
		}
		if (stage === 'badges') lines.push(`  decoded owner ${stageCandidates.length ? `H${fact.hole}` : 'missing'}`);
		else lines.push('  owner unavailable');
		lines.push('', 'changed:', ...changed.map((entry) => `  ${entry}`), '', 'REGRESSION: approved fact changed or was not reproduced');
	}

	lines.push('', `RESULT: ${failures ? 'FAIL' : 'PASS'} ${course} / ${stage}`);
	lines.push(`approved facts checked: ${fixture.facts.length}`);
	lines.push(`changed approved facts: ${failures}`);
	return { passed: failures === 0, lines };
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
	const gate = rest.length === 1 && rest[0] === '--gate';
	if (!['badges', 'baskets', 'tees'].includes(stageArg) || !course || (rest.length && !gate)) {
		console.error('Usage: ./lab check <badges|baskets|tees> <course> [--gate]');
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
	const gateRoot = join(repoRoot, 'lab-artifacts', course, 'oracle-v1', 'endpoint-gate-v1');
	const firstRunOutput = join(gateRoot, `${stage}.first-run.txt`);
	const firstGateRun = gate && !existsSync(firstRunOutput);
	const evidenceDir = gate
		? join(gateRoot, firstGateRun ? 'first-run' : 'latest')
		: join(repoRoot, 'lab-artifacts', course, 'sol-assisted-v1-evidence');
	mkdirSync(evidenceDir, { recursive: true });
	const outputJson = join(evidenceDir, `${stage}.measurements.json`);
	const outputPng = join(evidenceDir, `${stage}-course.png`);
	const png = PNG.sync.read(encodePng(cropped));
	const common = commonProvenance(stage, course, sourcePath, sourceBytes, full, cropped, viewport);
	let payload: unknown;
	let gateCandidates: GateCandidate[] = [];

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
		gateCandidates = readings.map((reading) => ({
			point: { xPx: reading.badge.cx, yPx: reading.badge.cy },
			identity: `H${reading.label}`,
		}));
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
			gateCandidates = candidates.map((candidate) => ({
				point: { xPx: candidate.tipX, yPx: candidate.tipY },
				identity: 'basket sprite candidate',
			}));
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
			gateCandidates = result.tees.map((tee) => ({
				point: { xPx: tee.cx, yPx: tee.cy },
				identity: `${tee.tier}-tier tee-like candidate`,
			}));
		}
	}

	writeFileSync(outputJson, `${JSON.stringify(payload, null, 2)}\n`);
	writeFileSync(outputPng, PNG.sync.write(png));
	const lines = [
		`course: ${course}`,
		`stage: ${stage}`,
		`crop rows: [${viewport.top}, ${viewport.bottom}) (provenance only)`,
		`canonical frame: ${cropped.width}x${cropped.height} crop-local pixels`,
		`measurements: ${outputJson}`,
		`course evidence: ${outputPng}`,
	];
	let gatePassed = true;
	if (gate) {
		if (course !== 'AlexClark') throw new Error(`No approved endpoint gate fixture for ${course}`);
		const fixturePath = join(repoRoot, 'lab-artifacts', course, 'oracle-v1', 'endpoint-gate-fixtures.json');
		const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as EndpointGateFixture;
		const report = endpointGateReport(stage, course, fixturePath, fixture, cropped, gateCandidates);
		gatePassed = report.passed;
		lines.push(...report.lines);
		if (firstGateRun) {
			lines.push('', `first gate output preserved: ${firstRunOutput}`);
			mkdirSync(gateRoot, { recursive: true });
			writeFileSync(firstRunOutput, `${lines.join('\n')}\n`);
		}
	}
	console.log(lines.join('\n'));
	if (!gatePassed) process.exitCode = 1;
}

main();
