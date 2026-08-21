/**
 * Tiny, AlexClark-specific Oracle review orienter.
 *
 * Reads the sealed historical-reference assessment and nearby raw detector
 * candidates. It never changes an annotation and never answers the Oracle
 * question. A future oracle-v1/review-log.json may cause explicitly reviewed
 * items to be skipped; absence of that file means review starts at H8 basket.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type ObjectKind = 'badge' | 'basket' | 'tee';
type Point = { xPx: number; yPx: number };

interface ReviewItem {
	hole: number;
	stage: ObjectKind;
	reason: string;
	truth: Point;
	a?: Point;
	b?: Point;
	m: Point[];
	artifactPath: string;
}

interface Comparison {
	reviewQueue: ReviewItem[];
}

interface OracleObservation {
	hole: number;
	object: ObjectKind;
	status: string;
}

interface BasketCandidate {
	tipX: number;
	tipY: number;
	onFrac: number;
	offFrac: number;
	score: number;
}

interface TeeCandidate {
	center: { x: number; y: number };
	tier: 'ring' | 'component';
	ring?: { elongation: number; ringFrac: number; holeArea: number };
}

interface BadgeCandidate {
	decodedLabel: string;
	plate: { center: { x: number; y: number } };
	minimumDigitMargin: number | null;
}

const priority: Array<{ hole: number; stage: ObjectKind }> = [
	{ hole: 8, stage: 'basket' },
	{ hole: 16, stage: 'basket' },
	{ hole: 17, stage: 'basket' },
	{ hole: 8, stage: 'tee' },
	{ hole: 12, stage: 'tee' },
	{ hole: 16, stage: 'tee' },
	{ hole: 5, stage: 'tee' },
	{ hole: 5, stage: 'basket' },
];

function distance(a: Point, b: Point): number {
	return Math.hypot(a.xPx - b.xPx, a.yPx - b.yPx);
}

function pointText(point: Point | undefined): string {
	return point ? `(${point.xPx.toFixed(2)}, ${point.yPx.toFixed(2)})` : 'unresolved';
}

function nearby(point: Point, anchors: Point[]): boolean {
	return anchors.some((anchor) => distance(point, anchor) <= 55);
}

function main(): void {
	const [course, ...rest] = process.argv.slice(2);
	if (course !== 'AlexClark' || rest.length) {
		console.error('Usage: ./lab review AlexClark');
		process.exit(2);
	}

	const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
	const artifactRoot = join(repoRoot, 'lab-artifacts', course);
	const comparisonPath = join(artifactRoot, 'truth-reveal-v1', 'endpoint-comparison.json');
	const comparison = JSON.parse(readFileSync(comparisonPath, 'utf8')) as Comparison;
	const oracleLogPath = join(artifactRoot, 'oracle-v1', 'review-log.json');
	const observations: OracleObservation[] = existsSync(oracleLogPath)
		? (JSON.parse(readFileSync(oracleLogPath, 'utf8')) as { observations?: OracleObservation[] }).observations ?? []
		: [];
	const reviewed = (hole: number, stage: ObjectKind): boolean =>
		observations.some((observation) =>
			observation.hole === hole &&
			observation.object === stage &&
			observation.status.startsWith('ORACLE_'),
		);
	const target = priority.find((entry) => !reviewed(entry.hole, entry.stage));
	if (!target) {
		console.log('All prioritized AlexClark endpoint disputes have explicit Oracle observations.');
		console.log(`review log: ${oracleLogPath}`);
		return;
	}
	const item = comparison.reviewQueue.find(
		(entry) => entry.hole === target.hole && entry.stage === target.stage,
	);
	if (!item) throw new Error(`Assessment queue is missing H${target.hole} ${target.stage}`);
	const anchors = [item.truth, item.a, item.b, ...item.m].filter(Boolean) as Point[];
	const machineLines: string[] = [];
	if (target.stage === 'basket') {
		const measurements = JSON.parse(
			readFileSync(join(artifactRoot, 'sol-assisted-v1-evidence', 'baskets.measurements.json'), 'utf8'),
		) as { candidates: BasketCandidate[] };
		for (const candidate of measurements.candidates) {
			const point = { xPx: candidate.tipX, yPx: candidate.tipY };
			if (!nearby(point, anchors)) continue;
			machineLines.push(
				`  candidate ${pointText(point)} score=${candidate.score.toFixed(4)} on=${candidate.onFrac.toFixed(4)} off=${candidate.offFrac.toFixed(4)}`,
			);
		}
	} else if (target.stage === 'tee') {
		const measurements = JSON.parse(
			readFileSync(join(artifactRoot, 'sol-assisted-v1-evidence', 'tees.measurements.json'), 'utf8'),
		) as { teeCandidates: TeeCandidate[] };
		for (const candidate of measurements.teeCandidates) {
			const point = { xPx: candidate.center.x, yPx: candidate.center.y };
			if (!nearby(point, anchors)) continue;
			const ring = candidate.ring
				? ` elongation=${candidate.ring.elongation.toFixed(3)} ringFrac=${candidate.ring.ringFrac.toFixed(3)} area=${candidate.ring.holeArea}`
				: '';
			machineLines.push(`  candidate ${pointText(point)} tier=${candidate.tier}${ring}`);
		}
	} else {
		const measurements = JSON.parse(
			readFileSync(join(artifactRoot, 'sol-assisted-v1-evidence', 'badges.measurements.json'), 'utf8'),
		) as { candidates: BadgeCandidate[] };
		for (const candidate of measurements.candidates) {
			if (candidate.decodedLabel !== String(target.hole)) continue;
			const point = { xPx: candidate.plate.center.x, yPx: candidate.plate.center.y };
			machineLines.push(`  plate ${pointText(point)} decoded=${candidate.decodedLabel} minMargin=${candidate.minimumDigitMargin?.toFixed(4) ?? 'n/a'}`);
		}
	}

	const renderPath = join(repoRoot, item.artifactPath);
	const objectLabel = target.stage.toUpperCase();
	console.log(`${course} H${target.hole} — ${objectLabel} ${target.stage === 'basket' ? 'OWNERSHIP' : 'IDENTITY / OWNERSHIP'}`);
	console.log('');
	console.log('WHAT IS VISIBLE');
	console.log('  The render isolates the competing endpoint neighborhoods in the canonical cropped raster.');
	console.log('  Visible object identity does not itself establish hole ownership.');
	console.log('');
	console.log('WHAT THE MACHINE MEASURED');
	console.log(machineLines.length ? machineLines.join('\n') : '  no nearby candidate');
	console.log('');
	console.log('WHAT THE HISTORICAL REFERENCE SAYS');
	console.log(`  endpoint ${pointText(item.truth)}`);
	console.log('  relation: REFERENCE_DISAGREES — awaiting Oracle review');
	console.log('');
	console.log('WHAT SOL PREVIOUSLY INFERRED');
	console.log(`  Sol A: ${pointText(item.a)}`);
	console.log(`  Sol B: ${pointText(item.b)}`);
	console.log('');
	console.log('WHAT SAM NEEDS TO DECIDE');
	console.log(`  Which visible ${target.stage} belongs to H${target.hole}?`);
	if (target.stage === 'basket' && [8, 16, 17].includes(target.hole)) {
		console.log('  This participates in the H8/H16/H17 basket permutation. Resolving one constrains the inventory,');
		console.log('  but the remaining ownerships stay INFERRED until Sam approves them.');
	}
	console.log('');
	console.log(`course / hole / evidence panels: ${renderPath}`);
	console.log(`assessment reason: ${item.reason}`);
}

main();
