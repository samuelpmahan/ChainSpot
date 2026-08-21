/**
 * Render the current Oracle-review endpoint state for AlexClark.
 * This is a review artifact, not an approved gate and not corridor geometry.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

type Point = { xPx: number; yPx: number };
type RGB = readonly [number, number, number];
type Hole = { number: number; tee?: Point; basket?: Point };
type Observation = {
	hole: number;
	object: 'tee' | 'badge' | 'basket';
	status: string;
	measurementLocalization?: Point;
	localization?: { provisionalCenterPx?: Point };
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifactRoot = join(repoRoot, 'lab-artifacts', 'AlexClark');
const outputRoot = join(artifactRoot, 'oracle-v1');
const approvedAnnotationPath = join(outputRoot, 'approved-endpoints.annotation.json');
const approvedOverlayPath = join(outputRoot, 'approved-endpoints-overlay.png');
const gateFixturePath = join(outputRoot, 'endpoint-gate-fixtures.json');
const approvedCheckpointExists = existsSync(gateFixturePath);
const source = PNG.sync.read(readFileSync(join(artifactRoot, 'AlexClark-cropped.png')));
const overlay = PNG.sync.read(PNG.sync.write(source));
const assisted = JSON.parse(readFileSync(join(artifactRoot, 'sol-assisted-v1.annotation.json'), 'utf8')) as { holes: Hole[] };
const badgeEvidence = JSON.parse(readFileSync(join(artifactRoot, 'sol-assisted-v1-evidence', 'badges.measurements.json'), 'utf8')) as {
	candidates: Array<{ decodedLabel: string; plate: { center: { x: number; y: number } } }>;
};
const reviewLog = JSON.parse(readFileSync(join(outputRoot, 'review-log.json'), 'utf8')) as {
	stageApprovals?: Array<{ stage: string; status: string }>;
	observations: Observation[];
};
const endpointsApproved = reviewLog.stageApprovals?.some(
	(approval) => approval.stage === 'endpoints' && approval.status === 'ORACLE_CONFIRMED',
) ?? false;

const badges = new Map<number, Point>();
for (const candidate of badgeEvidence.candidates) badges.set(Number(candidate.decodedLabel), {
	xPx: candidate.plate.center.x,
	yPx: candidate.plate.center.y,
});
// These two plates were not emitted by the badge detector.
badges.set(5, { xPx: 621, yPx: 1925 });
badges.set(18, { xPx: 548, yPx: 1041 });

const holes = new Map<number, Hole>(assisted.holes.map((hole) => [hole.number, structuredClone(hole)]));
const oracleKeys = new Set<string>();
for (const observation of reviewLog.observations) {
	if (!observation.status.startsWith('ORACLE_')) continue;
	const point = observation.measurementLocalization ?? observation.localization?.provisionalCenterPx;
	if (!point) continue;
	oracleKeys.add(`${observation.hole}:${observation.object}`);
	if (observation.object === 'badge') badges.set(observation.hole, point);
	else {
		const hole = holes.get(observation.hole);
		if (hole) hole[observation.object] = point;
	}
}
if (endpointsApproved) {
	for (let hole = 1; hole <= 18; hole++) for (const object of ['tee', 'badge', 'basket']) oracleKeys.add(`${hole}:${object}`);
}

function blend(x: number, y: number, color: RGB, alpha = 1): void {
	const ix = Math.round(x), iy = Math.round(y);
	if (ix < 0 || iy < 0 || ix >= overlay.width || iy >= overlay.height) return;
	const i = (iy * overlay.width + ix) * 4;
	overlay.data[i] = Math.round(overlay.data[i] * (1 - alpha) + color[0] * alpha);
	overlay.data[i + 1] = Math.round(overlay.data[i + 1] * (1 - alpha) + color[1] * alpha);
	overlay.data[i + 2] = Math.round(overlay.data[i + 2] * (1 - alpha) + color[2] * alpha);
	overlay.data[i + 3] = 255;
}

function line(a: Point, b: Point, color: RGB, width = 2, alpha = 1, dashed = false): void {
	const length = Math.hypot(b.xPx - a.xPx, b.yPx - a.yPx), steps = Math.max(1, Math.ceil(length));
	for (let step = 0; step <= steps; step++) {
		if (dashed && Math.floor(step / 8) % 2 === 1) continue;
		const t = step / steps, x = a.xPx + (b.xPx - a.xPx) * t, y = a.yPx + (b.yPx - a.yPx) * t;
		for (let dy = -width; dy <= width; dy++) for (let dx = -width; dx <= width; dx++) {
			if (dx * dx + dy * dy <= width * width) blend(x + dx, y + dy, color, alpha);
		}
	}
}

function cross(point: Point, color: RGB, radius = 9): void {
	line({ xPx: point.xPx - radius, yPx: point.yPx - radius }, { xPx: point.xPx + radius, yPx: point.yPx + radius }, [0, 0, 0], 4, 0.85);
	line({ xPx: point.xPx - radius, yPx: point.yPx + radius }, { xPx: point.xPx + radius, yPx: point.yPx - radius }, [0, 0, 0], 4, 0.85);
	line({ xPx: point.xPx - radius, yPx: point.yPx - radius }, { xPx: point.xPx + radius, yPx: point.yPx + radius }, color, 2);
	line({ xPx: point.xPx - radius, yPx: point.yPx + radius }, { xPx: point.xPx + radius, yPx: point.yPx - radius }, color, 2);
}

function circle(point: Point, radius: number, color: RGB, width = 2): void {
	for (let degrees = 0; degrees < 360; degrees += 0.5) {
		const angle = degrees * Math.PI / 180;
		for (let offset = -width; offset <= width; offset++) blend(
			point.xPx + (radius + offset) * Math.cos(angle),
			point.yPx + (radius + offset) * Math.sin(angle),
			color,
			0.95,
		);
	}
}

const DIGITS: Record<string, string[]> = {
	'0': ['111','101','101','101','111'], '1': ['010','110','010','010','111'],
	'2': ['111','001','111','100','111'], '3': ['111','001','111','001','111'],
	'4': ['101','101','111','001','001'], '5': ['111','100','111','001','111'],
	'6': ['111','100','111','101','111'], '7': ['111','001','010','010','010'],
	'8': ['111','101','111','101','111'], '9': ['111','101','111','001','111'],
};
function numberLabel(value: number, x: number, y: number): void {
	const chars = String(value).split(''), scale = 2, width = chars.length * 8 + 6;
	for (let yy = -3; yy < 15; yy++) for (let xx = -3; xx < width; xx++) blend(x + xx, y + yy, [0, 0, 0], 0.78);
	let cursor = x;
	for (const char of chars) {
		for (let row = 0; row < 5; row++) for (let col = 0; col < 3; col++) if (DIGITS[char][row][col] === '1') {
			for (let yy = 0; yy < scale; yy++) for (let xx = 0; xx < scale; xx++) blend(cursor + col * scale + xx, y + row * scale + yy, [255, 255, 255]);
		}
		cursor += 8;
	}
}

const teeColor: RGB = [60, 255, 100];
const badgeColor: RGB = [0, 235, 255];
const basketColor: RGB = [255, 220, 0];
const oracleColor: RGB = [255, 45, 205];

for (let number = 1; number <= 18; number++) {
	const hole = holes.get(number), badge = badges.get(number);
	if (!hole || !badge) continue;
	// Association only. These dashed chords are not corridor or bend geometry.
	if (hole.tee) line(hole.tee, badge, [255, 255, 255], 1, 0.7, true);
	if (hole.basket) line(badge, hole.basket, [255, 255, 255], 1, 0.7, true);
	if (hole.tee) {
		cross(hole.tee, teeColor);
		if (oracleKeys.has(`${number}:tee`)) circle(hole.tee, 14, oracleColor, 2);
	}
	cross(badge, badgeColor, 7);
	if (oracleKeys.has(`${number}:badge`)) circle(badge, 13, oracleColor, 2);
	if (hole.basket) {
		cross(hole.basket, basketColor);
		if (oracleKeys.has(`${number}:basket`)) circle(hole.basket, 14, oracleColor, 2);
	}
	numberLabel(number, badge.xPx + 12, badge.yPx - 6);
}

const annotation = {
	schemaVersion: 1,
	status: endpointsApproved
		? approvedCheckpointExists ? 'ORACLE_APPROVED_ENDPOINTS_GATE_ACTIVE' : 'ORACLE_APPROVED_ENDPOINTS_NOT_YET_GATE_IMPLEMENTED'
		: 'ORACLE_REVIEW_IN_PROGRESS_NOT_GATE_APPROVED',
	canonicalFrame: { widthPx: 1290, heightPx: 2082, origin: 'crop top-left', xAxis: 'right', yAxis: 'down' },
	renderLegend: {
		greenX: 'tee', cyanX: 'badge plate center', yellowX: 'basket point', magentaRing: 'explicit Oracle observation',
		dashedWhiteChord: 'ownership association only; not corridor geometry or a bend annotation',
	},
	holes: Array.from({ length: 18 }, (_, index) => {
		const number = index + 1, hole = holes.get(number) as Hole;
		return {
			hole: number,
			tee: hole.tee ? { ...hole.tee, oracleReviewed: oracleKeys.has(`${number}:tee`) } : null,
			badge: badges.get(number) ? { ...badges.get(number), oracleReviewed: oracleKeys.has(`${number}:badge`) } : null,
			basket: hole.basket ? { ...hole.basket, oracleReviewed: oracleKeys.has(`${number}:basket`) } : null,
		};
	}),
};

mkdirSync(outputRoot, { recursive: true });
writeFileSync(join(outputRoot, 'current-endpoints-review-overlay.png'), PNG.sync.write(overlay));
writeFileSync(join(outputRoot, 'current-endpoints-review.annotation.json'), `${JSON.stringify(annotation, null, 2)}\n`);
if (endpointsApproved) {
	if (approvedCheckpointExists) {
		console.log(`approved endpoint checkpoint already exists; preserved without rewrite: ${gateFixturePath}`);
	} else {
		writeFileSync(approvedOverlayPath, PNG.sync.write(overlay));
		writeFileSync(approvedAnnotationPath, `${JSON.stringify(annotation, null, 2)}\n`);
		writeFileSync(gateFixturePath, `${JSON.stringify({
			schemaVersion: 1,
			status: 'ORACLE_APPROVED_NOT_YET_ACTIVE',
			course: 'AlexClark',
			canonicalFrame: annotation.canonicalFrame,
			facts: annotation.holes,
		}, null, 2)}\n`);
	}
}
console.log(JSON.stringify({
	overlay: join(outputRoot, 'current-endpoints-review-overlay.png'),
	annotation: join(outputRoot, 'current-endpoints-review.annotation.json'),
	oracleFactsShown: oracleKeys.size,
	endpointsApproved,
}, null, 2));
