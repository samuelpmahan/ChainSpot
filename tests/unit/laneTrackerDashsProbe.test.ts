import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { describe, expect, test } from 'vitest';
import {
	DEFAULT_EXECUTION,
	canonicalJson,
	parseConfig,
	resolveConfig,
	runThreeFactor,
	sha256Hex
} from '@chainspot/alg/detectors/threeFactor';
import straightOn from '@chainspot/alg/detectors/threeFactor/configs/straight-test-on.json';
import {
	DEFAULT_FOUR_LANE_SENSOR_KNOBS,
	observeFourLaneCrossSection,
	sampleFourLaneBand,
	type FourLaneOccluder,
	type FourLaneState
} from '@chainspot/alg/detectors/threeFactor/features/st.fourLaneSensor';
import {
	DASHSTRACK_VIA_ANNOTATED,
	loadCourseRaster,
	loadCourseTruth
} from './helpers/courseFixture';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');
const ARTIFACTS_DIR = resolve(REPO_ROOT, 'artifacts/sweep/lane-tracker-dashs');
const ENDPOINT_TOLERANCE_PX = 26;

const TRACK = {
	stepPx: 6,
	headingOffsetsDeg: [-18, -12, -6, 0, 6, 12, 18] as const,
	lookaheadSteps: 3,
	maxDistancePx: 600,
	failureSteps: 6,
	minVisibleScore: 0.07,
	maxUnknownSteps: 16
};

interface Point { readonly xPx: number; readonly yPx: number }
interface Tip extends Point { readonly basketId: string }
interface LaneObservation { readonly score: number | null }
interface TrackStep {
	readonly point: Point;
	readonly headingRad: number;
	readonly score: number | null;
	readonly sustainedScore: number | null;
	readonly headingDeltaDeg: number;
	readonly deterministicBadgeTransit: boolean;
}
type StopReason = 'basket-tip' | 'evidence-lost' | 'occluded-too-long' | 'max-distance';
interface TrackResult {
	readonly variant: 'three-lane' | 'four-lane';
	readonly hole: number;
	readonly basketId: string | null;
	readonly basketTip: Point | null;
	readonly distancePx: number;
	readonly stopReason: StopReason;
	readonly steps: readonly TrackStep[];
}
type DashHole = {
	readonly number: number;
	readonly tee: Point;
	readonly basket: Point;
	readonly corridorBends: readonly Point[];
};

function clamp01(value: number): number {
	return Math.min(1, Math.max(0, value));
}

function contains(occluder: FourLaneOccluder, point: Point): boolean {
	return point.xPx >= occluder.bboxX && point.xPx <= occluder.bboxX + occluder.bboxW &&
		point.yPx >= occluder.bboxY && point.yPx <= occluder.bboxY + occluder.bboxH;
}

function occluderFromBbox(bbox: readonly [number, number, number, number], kind: string): FourLaneOccluder {
	return { bboxX: bbox[0], bboxY: bbox[1], bboxW: bbox[2], bboxH: bbox[3], kind };
}

function deterministicExitDistancePx(state: FourLaneState, occluder: FourLaneOccluder): number {
	if (!contains(occluder, state)) return 0;
	const dx = Math.cos(state.headingRad);
	const dy = Math.sin(state.headingRad);
	const candidates: number[] = [];
	const epsilon = 1e-9;
	if (dx > epsilon) candidates.push((occluder.bboxX + occluder.bboxW - state.xPx) / dx);
	else if (dx < -epsilon) candidates.push((occluder.bboxX - state.xPx) / dx);
	if (dy > epsilon) candidates.push((occluder.bboxY + occluder.bboxH - state.yPx) / dy);
	else if (dy < -epsilon) candidates.push((occluder.bboxY - state.yPx) / dy);
	const forward = candidates.filter((distance) => Number.isFinite(distance) && distance >= 0);
	return forward.length ? Math.max(0, Math.min(...forward)) : 0;
}

/**
 * The remembered 3-lane reduction: left rail / one center-interior lane / right rail.
 * Steering, lookahead, thresholds, badge transit, and basket termination stay identical
 * to the recovered Four-Lane tracker. Only the cross-section representation changes.
 */
function observeThreeLane(
	image: { readonly width: number; readonly height: number; readonly data: Uint8Array | Uint8ClampedArray },
	state: FourLaneState,
	occluders: readonly FourLaneOccluder[]
): LaneObservation {
	const knobs = DEFAULT_FOUR_LANE_SENSOR_KNOBS;
	const width = Math.max(1, state.corridorWidthPx);
	const guards = [(-2 * width) / 3, (2 * width) / 3]
		.map((offset) => sampleFourLaneBand(image, state, state.headingRad, offset, occluders, knobs))
		.filter((sample) => !sample.occluded && sample.mean !== null)
		.map((sample) => sample.mean as number);
	const ground = guards.length ? guards.reduce((a, b) => a + b, 0) / guards.length : null;

	const rail = (offset: number, insideSign: -1 | 1): number | null => {
		const inside = sampleFourLaneBand(
			image, state, state.headingRad,
			offset + insideSign * knobs.edgeDeltaPx,
			occluders, knobs
		);
		const outside = sampleFourLaneBand(
			image, state, state.headingRad,
			offset - insideSign * knobs.edgeDeltaPx,
			occluders, knobs
		);
		if (inside.occluded || outside.occluded || inside.mean === null || outside.mean === null) return null;
		return clamp01((inside.mean - outside.mean) / knobs.liftReference);
	};

	const left = rail(-width / 2, 1);
	const right = rail(width / 2, -1);
	const visibleRails = [left, right].filter((value): value is number => value !== null);
	const railScore = visibleRails.length === 2 ? Math.min(...visibleRails) : visibleRails[0] ?? null;

	const centerSamples = [-width / 6, 0, width / 6]
		.map((offset) => sampleFourLaneBand(image, state, state.headingRad, offset, occluders, knobs))
		.filter((sample) => !sample.occluded && sample.mean !== null)
		.map((sample) => sample.mean as number);
	const centerScore = ground !== null && centerSamples.length
		? clamp01((centerSamples.reduce((a, b) => a + b, 0) / centerSamples.length - ground) / knobs.liftReference)
		: null;
	const visible = [railScore, centerScore].filter((value): value is number => value !== null);
	return { score: visible.length ? Math.min(...visible) : null };
}

function observeFourLane(
	image: { readonly width: number; readonly height: number; readonly data: Uint8Array | Uint8ClampedArray },
	state: FourLaneState,
	occluders: readonly FourLaneOccluder[]
): LaneObservation {
	return observeFourLaneCrossSection(image, state, occluders, DEFAULT_FOUR_LANE_SENSOR_KNOBS);
}

function tipEncounter(
	from: Point,
	to: Point,
	corridorWidthPx: number,
	tips: readonly Tip[]
): { tip: Tip; segmentFraction: number; perpendicularPx: number } | null {
	const dx = to.xPx - from.xPx;
	const dy = to.yPx - from.yPx;
	const length2 = dx * dx + dy * dy;
	if (!(length2 > 0)) return null;
	const candidates = tips.flatMap((tip) => {
		const vx = tip.xPx - from.xPx;
		const vy = tip.yPx - from.yPx;
		const t = (vx * dx + vy * dy) / length2;
		if (t < 0 || t > 1) return [];
		const px = from.xPx + t * dx;
		const py = from.yPx + t * dy;
		const perpendicularPx = Math.hypot(tip.xPx - px, tip.yPx - py);
		if (perpendicularPx > corridorWidthPx / 2) return [];
		return [{ tip, segmentFraction: t, perpendicularPx }];
	});
	return candidates.sort((a, b) => a.segmentFraction - b.segmentFraction || a.perpendicularPx - b.perpendicularPx)[0] ?? null;
}

function track(
	variant: 'three-lane' | 'four-lane',
	hole: number,
	image: { readonly width: number; readonly height: number; readonly data: Uint8Array | Uint8ClampedArray },
	start: FourLaneState,
	ownBadge: FourLaneOccluder,
	occluders: readonly FourLaneOccluder[],
	tips: readonly Tip[]
): TrackResult {
	const observe = variant === 'three-lane' ? observeThreeLane : observeFourLane;
	const steps: TrackStep[] = [];
	let current: FourLaneState = { ...start };
	let distancePx = 0;
	let consecutiveUnknown = 0;
	const recentVisible: number[] = [];
	let deterministicRemainingPx = deterministicExitDistancePx(start, ownBadge) + TRACK.stepPx;

	while (distancePx < TRACK.maxDistancePx) {
		let next: FourLaneState;
		let observation: LaneObservation;
		let sustainedScore: number | null = null;
		let deltaDeg = 0;
		let deterministic = false;

		if (deterministicRemainingPx > 1e-9) {
			const stepPx = Math.min(TRACK.stepPx, TRACK.maxDistancePx - distancePx);
			next = {
				xPx: current.xPx + Math.cos(current.headingRad) * stepPx,
				yPx: current.yPx + Math.sin(current.headingRad) * stepPx,
				headingRad: current.headingRad,
				corridorWidthPx: current.corridorWidthPx
			};
			observation = observe(image, next, occluders);
			deterministicRemainingPx = Math.max(0, deterministicRemainingPx - stepPx);
			deterministic = true;
		} else {
			const candidates = TRACK.headingOffsetsDeg.map((candidateDeltaDeg) => {
				const heading = current.headingRad + (candidateDeltaDeg * Math.PI) / 180;
				let first: LaneObservation | null = null;
				const visibleScores: number[] = [];
				for (let k = 1; k <= TRACK.lookaheadSteps; k++) {
					const candidateState: FourLaneState = {
						xPx: current.xPx + Math.cos(heading) * TRACK.stepPx * k,
						yPx: current.yPx + Math.sin(heading) * TRACK.stepPx * k,
						headingRad: heading,
						corridorWidthPx: current.corridorWidthPx
					};
					const observed = observe(image, candidateState, occluders);
					if (k === 1) first = observed;
					if (observed.score !== null) visibleScores.push(observed.score);
				}
				return {
					deltaDeg: candidateDeltaDeg,
					heading,
					observation: first as LaneObservation,
					sustainedScore: visibleScores.length ? Math.min(...visibleScores) : null
				};
			});
			candidates.sort((a, b) => {
				const qa = a.sustainedScore ?? (Math.abs(a.deltaDeg) < 1e-9 ? 0 : -1);
				const qb = b.sustainedScore ?? (Math.abs(b.deltaDeg) < 1e-9 ? 0 : -1);
				return qb - qa || Math.abs(a.deltaDeg) - Math.abs(b.deltaDeg);
			});
			const chosen = candidates[0];
			deltaDeg = chosen.deltaDeg;
			sustainedScore = chosen.sustainedScore;
			observation = chosen.observation;
			next = {
				xPx: current.xPx + Math.cos(chosen.heading) * TRACK.stepPx,
				yPx: current.yPx + Math.sin(chosen.heading) * TRACK.stepPx,
				headingRad: chosen.heading,
				corridorWidthPx: current.corridorWidthPx
			};
		}

		const from = { xPx: current.xPx, yPx: current.yPx };
		current = next;
		distancePx += TRACK.stepPx;
		steps.push({
			point: { xPx: current.xPx, yPx: current.yPx },
			headingRad: current.headingRad,
			score: observation.score,
			sustainedScore,
			headingDeltaDeg: deltaDeg,
			deterministicBadgeTransit: deterministic
		});

		const encountered = tipEncounter(from, current, current.corridorWidthPx, tips);
		if (encountered) {
			return {
				variant, hole,
				basketId: encountered.tip.basketId,
				basketTip: { xPx: encountered.tip.xPx, yPx: encountered.tip.yPx },
				distancePx: distancePx - TRACK.stepPx + TRACK.stepPx * encountered.segmentFraction,
				stopReason: 'basket-tip',
				steps
			};
		}

		if (deterministic) continue;
		if (observation.score === null) {
			consecutiveUnknown++;
		} else {
			consecutiveUnknown = 0;
			recentVisible.push(observation.score);
			if (recentVisible.length > TRACK.failureSteps) recentVisible.shift();
			if (recentVisible.length === TRACK.failureSteps && recentVisible.every((score) => score < TRACK.minVisibleScore)) {
				return { variant, hole, basketId: null, basketTip: null, distancePx, stopReason: 'evidence-lost', steps };
			}
		}
		if (consecutiveUnknown > TRACK.maxUnknownSteps) {
			return { variant, hole, basketId: null, basketTip: null, distancePx, stopReason: 'occluded-too-long', steps };
		}
	}
	return { variant, hole, basketId: null, basketTip: null, distancePx, stopReason: 'max-distance', steps };
}

function distance(a: Point, b: Point): number {
	return Math.hypot(a.xPx - b.xPx, a.yPx - b.yPx);
}

function setPixel(png: PNG, x: number, y: number, rgba: readonly [number, number, number, number]): void {
	const xi = Math.round(x), yi = Math.round(y);
	if (xi < 0 || yi < 0 || xi >= png.width || yi >= png.height) return;
	const p = (yi * png.width + xi) * 4;
	png.data[p] = rgba[0]; png.data[p + 1] = rgba[1]; png.data[p + 2] = rgba[2]; png.data[p + 3] = rgba[3];
}

function drawLine(png: PNG, a: Point, b: Point, rgba: readonly [number, number, number, number], radius = 1): void {
	const length = Math.max(1, Math.ceil(distance(a, b)));
	for (let i = 0; i <= length; i++) {
		const t = i / length;
		const x = a.xPx + (b.xPx - a.xPx) * t;
		const y = a.yPx + (b.yPx - a.yPx) * t;
		for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) setPixel(png, x + dx, y + dy, rgba);
	}
}

function drawCross(png: PNG, point: Point, rgba: readonly [number, number, number, number], radius = 5): void {
	for (let d = -radius; d <= radius; d++) {
		setPixel(png, point.xPx + d, point.yPx + d, rgba);
		setPixel(png, point.xPx + d, point.yPx - d, rgba);
	}
}

function renderBentTracks(
	path: string,
	raster: { readonly widthPx: number; readonly heightPx: number; readonly rgba: Uint8ClampedArray },
	tracks: readonly TrackResult[],
	bentHoles: ReadonlySet<number>,
	tips: readonly Tip[]
): void {
	const png = new PNG({ width: raster.widthPx, height: raster.heightPx });
	png.data.set(raster.rgba);
	for (const tip of tips) drawCross(png, tip, [255, 0, 255, 255], 2);
	for (const track of tracks.filter((candidate) => bentHoles.has(candidate.hole))) {
		let previous: Point | null = null;
		for (const step of track.steps) {
			if (previous) drawLine(
				png,
				previous,
				step.point,
				step.deterministicBadgeTransit ? [255, 255, 0, 255] : [0, 255, 255, 255],
				1
			);
			previous = step.point;
		}
		const end = track.steps.at(-1)?.point;
		if (track.basketTip) drawCross(png, track.basketTip, [0, 255, 0, 255], 6);
		else if (end) drawCross(png, end, [255, 0, 0, 255], 6);
	}
	writeFileSync(path, PNG.sync.write(png));
}

describe("Dash's Track badge->UNKNOWN basket lane-follow A/B", () => {
	test('runs recovered Four-Lane versus a 3-lane reduction with basket candidates terminal-only', async () => {
		const raster = loadCourseRaster(DASHSTRACK_VIA_ANNOTATED);
		const resolved = resolveConfig(parseConfig(straightOn), DEFAULT_EXECUTION);
		const paramsHash = await sha256Hex(canonicalJson(resolved));
		const run = runThreeFactor(raster, { config: resolved, paramsHash });
		const trace = run.trace;
		if (!trace) throw new Error('trace missing');
		const lockUnit = trace.units.find((unit) => unit.id === 'teeBadgeLock');
		if (!lockUnit) throw new Error('teeBadgeLock unit missing');
		const locks = lockUnit.drawables.filter((drawable) =>
			drawable.type === 'polyline' && drawable.verdict === 'accepted' &&
			drawable.visualRole === 'tee-badge-path' && Array.isArray(drawable.path) &&
			typeof drawable.values?.hole === 'number'
		);
		const corridorWidthPx = run.measurement.parameters.corridorWidthPx;
		const image = { width: raster.widthPx, height: raster.heightPx, data: raster.rgba };
		const tips: Tip[] = run.measurement.baskets.map((basket) => ({
			basketId: basket.detId, xPx: basket.tipXPx, yPx: basket.tipYPx
		}));
		const badgeOccluders = run.measurement.badges.map((badge) =>
			occluderFromBbox(badge.plateBbox ?? badge.bbox, `badge:${badge.detId}`)
		);
		const basketOccluders = run.measurement.baskets.map((basket) =>
			occluderFromBbox(basket.bbox, `basket:${basket.detId}`)
		);
		const occluders = [...badgeOccluders, ...basketOccluders];

		// BLIND PHASE: all 18 locks are followed before annotation truth is loaded.
		const blindTracks = locks.flatMap((lock) => {
			if (lock.type !== 'polyline' || !Array.isArray(lock.path) || lock.path.length < 2) return [];
			const hole = Number(lock.values?.hole);
			const first = lock.path[0], last = lock.path[lock.path.length - 1];
			const start: FourLaneState = {
				xPx: last[0], yPx: last[1],
				headingRad: Math.atan2(last[1] - first[1], last[0] - first[0]),
				corridorWidthPx
			};
			const badge = run.measurement.badges.find((candidate) => candidate.label === String(hole));
			if (!badge) throw new Error(`H${hole}: labeled badge evidence missing`);
			const ownBadge = occluderFromBbox(badge.plateBbox ?? badge.bbox, `own-badge:${badge.detId}`);
			return [
				track('three-lane', hole, image, start, ownBadge, occluders, tips),
				track('four-lane', hole, image, start, ownBadge, occluders, tips)
			];
		});

		// EVALUATOR PHASE ONLY: classify already-frozen tracks by bend truth and endpoint truth.
		const truth = loadCourseTruth(DASHSTRACK_VIA_ANNOTATED).holes as readonly DashHole[];
		const trueBasketByHole = new Map(truth.map((hole) => {
			const nearest = [...run.measurement.baskets]
				.map((basket) => ({ basket, d: distance(hole.basket, { xPx: basket.tipXPx, yPx: basket.tipYPx }) }))
				.sort((a, b) => a.d - b.d)[0];
			if (!nearest || nearest.d > ENDPOINT_TOLERANCE_PX) throw new Error(`H${hole.number}: true detected basket missing`);
			return [hole.number, nearest.basket.detId] as const;
		}));
		const bendCountByHole = new Map(truth.map((hole) => [hole.number, hole.corridorBends.length] as const));
		const rows = blindTracks.map((trackResult) => ({
			variant: trackResult.variant,
			hole: trackResult.hole,
			bends: bendCountByHole.get(trackResult.hole) ?? -1,
			basketId: trackResult.basketId,
			trueBasketId: trueBasketByHole.get(trackResult.hole) ?? 'UNKNOWN',
			correct: trackResult.basketId !== null && trackResult.basketId === trueBasketByHole.get(trackResult.hole),
			stopReason: trackResult.stopReason,
			distancePx: Number(trackResult.distancePx.toFixed(1)),
			headingChanges: trackResult.steps.filter((step) => Math.abs(step.headingDeltaDeg) > 1e-9).length,
			badgeTransitSteps: trackResult.steps.filter((step) => step.deterministicBadgeTransit).length
		})).sort((a, b) => a.variant.localeCompare(b.variant) || a.hole - b.hole);

		const summaries = (['three-lane', 'four-lane'] as const).map((variant) => {
			const variantRows = rows.filter((row) => row.variant === variant);
			const bent = variantRows.filter((row) => row.bends > 0);
			const straight = variantRows.filter((row) => row.bends === 0);
			return {
				variant,
				bent: {
					holes: bent.length,
					correct: bent.filter((row) => row.correct).length,
					wrongTip: bent.filter((row) => row.basketId !== null && !row.correct).length,
					noTip: bent.filter((row) => row.basketId === null).length,
					stops: Object.fromEntries([...new Set(bent.map((row) => row.stopReason))].map((reason) => [reason, bent.filter((row) => row.stopReason === reason).length]))
				},
				straightSanity: {
					holes: straight.length,
					correct: straight.filter((row) => row.correct).length,
					wrongTip: straight.filter((row) => row.basketId !== null && !row.correct).length,
					noTip: straight.filter((row) => row.basketId === null).length
				}
			};
		});

		mkdirSync(ARTIFACTS_DIR, { recursive: true });
		writeFileSync(resolve(ARTIFACTS_DIR, 'DashsTrack.lane-ab.summary.json'), JSON.stringify({
			paramsHash,
			contract: 'known tee -> known badge -> UNKNOWN basket; basket tips are terminal-only and never steer',
			badgeRule: 'all badge boxes are known occluders; own badge is deterministic straight-through from tee->badge pose plus one step',
			basketRule: 'basket sprites are occluders for appearance; semantic basket tips terminate when swept corridor first encounters them',
			trackParams: TRACK,
			summaries,
			rows
		}, null, 2));
		writeFileSync(resolve(ARTIFACTS_DIR, 'DashsTrack.lane-ab.receipt.txt'), [
			"Dash's Track lane-follow A/B — badge -> UNKNOWN basket",
			'cyan=searched trace; yellow=deterministic badge transit; magenta=all candidate basket tips; green=encountered tip; red=no-tip stop',
			...summaries.map((summary) => `${summary.variant}: bent ${summary.bent.correct}/${summary.bent.holes} correct, ${summary.bent.wrongTip} wrong-tip, ${summary.bent.noTip} no-tip; straight sanity ${summary.straightSanity.correct}/${summary.straightSanity.holes}`)
		].join('\n') + '\n');
		const bentHoles = new Set(truth.filter((hole) => hole.corridorBends.length > 0).map((hole) => hole.number));
		renderBentTracks(resolve(ARTIFACTS_DIR, 'DashsTrack.three-lane.bent.png'), raster, blindTracks.filter((trackResult) => trackResult.variant === 'three-lane'), bentHoles, tips);
		renderBentTracks(resolve(ARTIFACTS_DIR, 'DashsTrack.four-lane.bent.png'), raster, blindTracks.filter((trackResult) => trackResult.variant === 'four-lane'), bentHoles, tips);

		console.table(rows);
		console.log(`DASHS_LANE_AB_SUMMARY=${JSON.stringify(summaries)}`);
		expect(locks).toHaveLength(18);
		expect(run.measurement.baskets).toHaveLength(18);
		expect(blindTracks).toHaveLength(36);
		expect(truth.filter((hole) => hole.corridorBends.length > 0)).toHaveLength(9);
	}, 120_000);
});
