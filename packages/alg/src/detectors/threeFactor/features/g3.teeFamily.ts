// g3.teeFamily — LAB G3 "intact tee-family" refinement, ported verbatim from
// origin/codex/three-factor-dev72-lab:scripts/chainspot-lab/courseSweep.ts
// (commit ef2a4fc), functions frameForRing/measureTee/selectTeeFamily. See
// .task/PORT-G3-INTACT-TEE-FAMILY.md and .task/teefamily-recon-brief.md.
//
// LAB shape: for every tee-rect ring, find the smallest enclosing bright
// component ("frame") inside a size window; then, treating each measured
// (ring, frame) pair as a candidate anchor, pick the largest family of
// measures whose frame major/minor/area all sit within a log-ratio tolerance
// of the anchor's frame (ties broken by minimum summed spread). The LAB's
// grayStats (145<=max(R,G,B)<=175) check was DIAGNOSTIC ONLY and is
// deliberately NOT ported — no gray-payload gate exists anywhere below.
//
// Coordinate-system resolution (the brief's flagged trap): measure.ts's
// makeTees stamps TeeEvidence.xPx/yPx and ring.bbox in ORIGINAL-IMAGE px —
// only Y is shifted (`+ yOffsetPx`; yOffsetPx === viewport.topPx), X is
// untouched because the viewport crop is vertical-only (see makeTees, and
// its `shiftedComponent`/badge helpers, all of which shift Y only).
// stage.brightComponents (ComponentStats), by contrast, are STAGE-LOCAL
// (pre-offset — badgeStage runs on the cropped local image). So this unit
// shifts each candidate frame's bboxY by `+ viewport.topPx` before running
// the containment test against a ring-tier tee's already-offset xPx/yPx —
// putting both operands in the same (original-image) coordinate system.
// Getting this backwards (or comparing unshifted) is the port's most likely
// silent bug per the recon brief; that is why 'viewport' is an explicit
// extra consumed slot beyond the spec's "stage, tees" shorthand.
//
// Only tier 'ring' tees are in scope: the LAB call site measured exclusively
// `kind === 'tee-rect'` rings (`teeRings = ringsRaw.filter(r => r.kind ===
// 'tee-rect' && ...)`), which is what our 'ring' tier tees already are
// post-filter. Tiers 'component' and 'recovered' pass through UNTOUCHED
// (info drawable only) — refining them would exceed the ported behavior.
//
// detId / output order: surviving tees keep their ORIGINAL detId — no
// renumbering. Every overlay drawable emitted below uses a tee's board
// detId as `ref`; renumbering after the fact would silently break that
// correlation for the scrubber, and nothing downstream (scoring.ts,
// assignment.ts, measure.ts's makeRawPairs) needs tee ids contiguous or
// index-aligned — they're used purely as opaque Map keys / string-joined
// pairIds. The refined 'tees' board slot is produced by FILTERING the
// incoming (already `yPx, xPx, tier`-sorted, see makeTees) list rather than
// rebuilding + re-sorting it: this is a strict subsequence, so it
// automatically satisfies the spec's "family sorted by ring cy then cx"
// requirement for surviving ring tees (a filter preserves the order of a
// sorted sequence) while leaving passthrough component/recovered tees in
// their original relative positions. The pure `selectTeeFamily` core below
// still does its own independent cy/cx sort on `family` — that's the
// spec-mandated contract for the selector itself and what the unit tests
// exercise directly; the board-list filter is a separate, simpler step that
// happens to agree with it.

import type { ComponentStats } from '../components';
import type { TeeEvidence, TeePadEvidence, TeeTier } from '../types';
import type {
	ABFeature,
	EngineUnit,
	EvidenceBoard,
	FeatureContext,
	FeatureRender,
	RunTrace,
	UnitTrace
} from './types';
import { teePoseDecoration } from './teePoseVisuals';

export interface TeeFamilyKnobs {
	readonly frameAreaMin: number;
	readonly frameAreaMax: number;
	readonly frameMaxWidth: number;
	readonly frameMaxHeight: number;
	readonly majorRatioToleranceFactor: number;
	readonly minorRatioToleranceFactor: number;
	readonly areaRatioToleranceFactor: number;
}

function positiveNumber(name: string): (value: unknown) => string | null {
	return (value: unknown) =>
		typeof value === 'number' && Number.isFinite(value) && value > 0
			? null
			: `${name} must be a positive number`;
}

function toleranceFactor(name: string): (value: unknown) => string | null {
	return (value: unknown) =>
		typeof value === 'number' && Number.isFinite(value) && value > 1
			? null
			: `${name} must be a number > 1`;
}

const TEE_FAMILY_RENDER: FeatureRender = {
	units: ['teeFamily'],
	draw(unit: UnitTrace, run: RunTrace) {
		const accepted = unit.drawables.filter((drawable) => drawable.verdict === 'accepted');
		const acceptedBorders = accepted.filter((drawable) => drawable.type === 'polyline');
		const rejected = unit.drawables.filter((drawable) => drawable.verdict === 'rejected');
		const info = unit.drawables.filter((drawable) => drawable.verdict === 'info');
		const poseDecorations = acceptedBorders.map((drawable) =>
			teePoseDecoration(
				drawable.path.slice(0, 4),
				drawable.ref ?? 'UNKNOWN',
				'presentation geometry connected from the accepted visible-tee border corners'
			)
		);
		const cornerTicks = poseDecorations.flatMap((decoration) => decoration.cornerTicks);
		const diagonals = poseDecorations.flatMap((decoration) => decoration.diagonals);
		const badgeUnit = run.units.find((candidate) => candidate.id === 'badges');
		const detectedBadgeCount = badgeUnit?.drawables.filter(
			(drawable) => drawable.verdict === 'accepted'
		).length;
		const acceptedVisibleTeeCount = accepted.filter(
			(drawable) => drawable.type === 'polyline'
		).length;
		const expectedRecoverNum =
			detectedBadgeCount === undefined
				? undefined
				: Math.max(0, detectedBadgeCount - acceptedVisibleTeeCount);
		return {
			title: `g3.teeFamily -- final visible tee detections (${run.configName})`,
			base: 'badgeStage.masks.bright',
			layers: [
				{
					name: 'visible tee-family rejections (G3)',
					note: 'ring candidates rejected by enclosing-frame family consistency',
					drawables: rejected
				},
				{
					name: 'visible tee oriented full-pad bounds accepted (G3)',
					note: 'exact oriented detected border; secondary raster/interior evidence is kept in the trace but omitted here',
					drawables: acceptedBorders
				},
				{
					name: 'tee pose center guides (G3)',
					note: 'one-pixel red opposite-corner diagonals; their intersection is the fitted center',
					drawables: diagonals
				},
				{
					name: 'tee pose corner indicators (G3)',
					note: 'small cyan plus signs rotated into the two pad-edge axes at each corner',
					drawables: cornerTicks
				}
			],
			notes: [
				`feature: teeFamily (visible tees) -- ${unit.gate}, trace unit '${unit.id}'`,
				'accepted object geometry: closed oriented quadrilateral from the enclosing bright-mask component PCA center/angle/major/minor.',
				'corner math: retain the component projection extrema (axisMajorMin/Max and axisMinorMin/Max), expand each by 0.5px to cover whole raster cells, then rotate all four extrema intersections back into canonical image coordinates.',
				'visual standard: exact green border, four pad-axis-aligned cyan corner plus signs, and two one-pixel red corner diagonals whose intersection exposes the fitted center.',
				`secondary trace drawables omitted from the primary receipt: ${info.length} (raw trace remains available; no AABB, hollow-ring box, or passthrough marker is drawn here).`,
				'pair-scoring angle remains the original hollow-ring angle in TeeEvidence.angleRad; this geometry repair does not change assignment math.',
				`acceptedVisibleTeeCount: ${acceptedVisibleTeeCount}  (source: accepted UnitTrace.drawables for teeFamily)`,
				`detectedBadgeCount: ${detectedBadgeCount ?? 'UNKNOWN'}  (source: accepted RunTrace unit 'badges' drawables)`,
				`expectedRecoverNum: ${expectedRecoverNum ?? 'UNKNOWN'}  (math: max(0, detectedBadgeCount - acceptedVisibleTeeCount))`,
				'expectedRecoverNum is a cardinality-derived recovery expectation, not truth, localization, or ownership.',
				'Visible/recovery labels are unavailable in the annotation truth; all-category G3 misses must not be relabeled as visible-tee misses.',
				'ownership: UNKNOWN -- tee localization does not assign a tee to a hole.'
			]
		};
	}
};

export const teeFamilyFeature = {
	id: 'teeFamily',
	gate: 'G3',
	kind: 'baseline',
	defaultEnabled: true,
	note: 'Visible tee detection: keep only the largest mutually-consistent intact hollow-glyph family by enclosing-frame major/minor/area. Shard recovery is a separate phase.',
	render: TEE_FAMILY_RENDER,
	knobs: {
		frameAreaMin: {
			default: 10,
			note: 'minimum enclosing bright-component area to count as a frame candidate (LAB: area >= 10)',
			validate: positiveNumber('frameAreaMin')
		},
		frameAreaMax: {
			default: 500,
			note: 'maximum enclosing bright-component area to count as a frame candidate (LAB: area <= 500)',
			validate: positiveNumber('frameAreaMax')
		},
		frameMaxWidth: {
			default: 50,
			note: 'maximum frame bbox width (LAB: bboxW <= 50)',
			validate: positiveNumber('frameMaxWidth')
		},
		frameMaxHeight: {
			default: 50,
			note: 'maximum frame bbox height (LAB: bboxH <= 50)',
			validate: positiveNumber('frameMaxHeight')
		},
		majorRatioToleranceFactor: {
			default: 1.25,
			note: "a family member's frame major must satisfy |log(f.major/s.major)| <= log(this) vs the anchor frame (LAB: log(1.25))",
			validate: toleranceFactor('majorRatioToleranceFactor')
		},
		minorRatioToleranceFactor: {
			default: 1.25,
			note: 'same tolerance, applied to frame minor (LAB: log(1.25))',
			validate: toleranceFactor('minorRatioToleranceFactor')
		},
		areaRatioToleranceFactor: {
			default: 1.5,
			note: 'same tolerance, applied to frame area (LAB: log(1.5))',
			validate: toleranceFactor('areaRatioToleranceFactor')
		}
	}
} satisfies ABFeature;

// ---------------------------------------------------------------------------
// Pure core — exported for unit tests. No board/ctx dependency: callers hand
// in already coordinate-aligned frames/ring points.

export interface TeeFamilyFrame {
	readonly componentLabel: number;
	readonly bboxX: number;
	readonly bboxY: number;
	readonly bboxW: number;
	readonly bboxH: number;
	readonly componentCentroidXPx: number;
	readonly componentCentroidYPx: number;
	readonly area: number;
	readonly fill: number;
	readonly major: number;
	readonly minor: number;
	readonly angleRad: number;
	readonly axisMajorMin: number;
	readonly axisMajorMax: number;
	readonly axisMinorMin: number;
	readonly axisMinorMax: number;
}

export interface TeeFamilyRingPoint {
	readonly id: string;
	readonly cx: number;
	readonly cy: number;
}

export interface TeeFamilyMeasure {
	readonly ring: TeeFamilyRingPoint;
	readonly frame: TeeFamilyFrame;
}

export interface TeeFamilySelection {
	readonly family: readonly TeeFamilyMeasure[];
	readonly anchor: TeeFamilyMeasure | null;
}

/** Oriented rectangle centered on the already-measured component centroid.
 * Component PCA already paid for angle + projected major/minor extents; this
 * function only converts those retained measurements into four corners. */
export function orientedPadCorners(frame: TeeFamilyFrame): TeePadEvidence['orientedCorners'] {
	const majorX = Math.cos(frame.angleRad);
	const majorY = Math.sin(frame.angleRad);
	const minorX = -majorY;
	const minorY = majorX;
	// Component statistics use integer pixel indices as pixel centers. Shift
	// the origin by half a raster cell so an angle=0 oriented bound uses the
	// same [bboxX,bboxX+bboxW] edge convention as the ordinary raster AABB.
	const originX = frame.componentCentroidXPx + 0.5;
	const originY = frame.componentCentroidYPx + 0.5;
	const majorMin = frame.axisMajorMin - 0.5;
	const majorMax = frame.axisMajorMax + 0.5;
	const minorMin = frame.axisMinorMin - 0.5;
	const minorMax = frame.axisMinorMax + 0.5;
	const corner = (majorProjection: number, minorProjection: number) =>
		[
			originX + majorX * majorProjection + minorX * minorProjection,
			originY + majorY * majorProjection + minorY * minorProjection
		] as const;
	return [
		corner(majorMin, minorMin),
		corner(majorMax, minorMin),
		corner(majorMax, minorMax),
		corner(majorMin, minorMax)
	];
}

function teePadEvidence(frame: TeeFamilyFrame): TeePadEvidence {
	const majorMid = (frame.axisMajorMin + frame.axisMajorMax) / 2;
	const minorMid = (frame.axisMinorMin + frame.axisMinorMax) / 2;
	const majorX = Math.cos(frame.angleRad);
	const majorY = Math.sin(frame.angleRad);
	const minorX = -majorY;
	const minorY = majorX;
	return {
		source: 'bright-mask-component',
		componentLabel: frame.componentLabel,
		bbox: [frame.bboxX, frame.bboxY, frame.bboxW, frame.bboxH],
		componentCentroidXPx: frame.componentCentroidXPx,
		componentCentroidYPx: frame.componentCentroidYPx,
		centerXPx: frame.componentCentroidXPx + 0.5 + majorX * majorMid + minorX * minorMid,
		centerYPx: frame.componentCentroidYPx + 0.5 + majorY * majorMid + minorY * minorMid,
		angleRad: frame.angleRad,
		majorPx: frame.major,
		minorPx: frame.minor,
		area: frame.area,
		fill: frame.fill,
		axisMajorMin: frame.axisMajorMin,
		axisMajorMax: frame.axisMajorMax,
		axisMinorMin: frame.axisMinorMin,
		axisMinorMax: frame.axisMinorMax,
		orientedCorners: orientedPadCorners(frame)
	};
}

/**
 * LAB frameForRing: the smallest-bbox (tie: largest-area) frame among
 * size-windowed candidates whose bbox contains the ring center, inclusive.
 * Null when no candidate contains the center.
 */
export function findEnclosingFrame(
	ring: TeeFamilyRingPoint,
	frames: readonly TeeFamilyFrame[],
	knobs: TeeFamilyKnobs
): TeeFamilyFrame | null {
	const candidates = frames.filter(
		(f) =>
			f.area >= knobs.frameAreaMin &&
			f.area <= knobs.frameAreaMax &&
			f.bboxW <= knobs.frameMaxWidth &&
			f.bboxH <= knobs.frameMaxHeight &&
			ring.cx >= f.bboxX &&
			ring.cx <= f.bboxX + f.bboxW &&
			ring.cy >= f.bboxY &&
			ring.cy <= f.bboxY + f.bboxH
	);
	if (!candidates.length) return null;
	return candidates
		.slice()
		.sort((a, b) => a.bboxW * a.bboxH - b.bboxW * b.bboxH || b.area - a.area)[0];
}

/**
 * LAB selectTeeFamily: for every measure as a candidate anchor, the family
 * is every measure whose frame major/minor/area all sit within the
 * configured log-ratio tolerance of the anchor's frame; keep the largest
 * family, ties broken by minimum summed spread. Output (and the winning
 * anchor, for trace reporting) sorted deterministically by ring cy then cx.
 */
export function selectTeeFamily(
	measures: readonly TeeFamilyMeasure[],
	knobs: TeeFamilyKnobs
): TeeFamilySelection {
	const majorTol = Math.log(knobs.majorRatioToleranceFactor);
	const minorTol = Math.log(knobs.minorRatioToleranceFactor);
	const areaTol = Math.log(knobs.areaRatioToleranceFactor);

	let best: TeeFamilyMeasure[] = [];
	let bestSpread = Infinity;
	let bestAnchor: TeeFamilyMeasure | null = null;

	for (const seed of measures) {
		const s = seed.frame;
		const family = measures.filter((m) => {
			const f = m.frame;
			return (
				Math.abs(Math.log(Math.max(f.major, 1) / Math.max(s.major, 1))) <= majorTol &&
				Math.abs(Math.log(Math.max(f.minor, 1) / Math.max(s.minor, 1))) <= minorTol &&
				Math.abs(Math.log(Math.max(f.area, 1) / Math.max(s.area, 1))) <= areaTol
			);
		});
		const spread = family.reduce(
			(sum, m) =>
				sum +
				Math.abs(Math.log(Math.max(m.frame.major, 1) / Math.max(s.major, 1))) +
				Math.abs(Math.log(Math.max(m.frame.minor, 1) / Math.max(s.minor, 1))) +
				Math.abs(Math.log(Math.max(m.frame.area, 1) / Math.max(s.area, 1))),
			0
		);
		if (family.length > best.length || (family.length === best.length && spread < bestSpread)) {
			best = family;
			bestSpread = spread;
			bestAnchor = seed;
		}
	}

	return {
		family: best.slice().sort((a, b) => a.ring.cy - b.ring.cy || a.ring.cx - b.ring.cx),
		anchor: bestAnchor
	};
}

// ---------------------------------------------------------------------------
// EngineUnit — adapts stage.brightComponents + the current 'tees' slot into
// the pure core above, and refines 'tees' in place.

interface StageSlot {
	readonly brightComponents: readonly ComponentStats[];
}

interface ViewportSlot {
	readonly topPx: number;
}

function toFrame(component: ComponentStats, topPx: number): TeeFamilyFrame {
	// Only Y shifts: the viewport crop is vertical-only (see file header).
	if (
		component.axisMajorMin === undefined ||
		component.axisMajorMax === undefined ||
		component.axisMinorMin === undefined ||
		component.axisMinorMax === undefined
	) {
		throw new Error(
			`teeFamily: bright-mask component ${component.label} is missing measured PCA projection extrema`
		);
	}
	return {
		componentLabel: component.label,
		bboxX: component.bboxX,
		bboxY: component.bboxY + topPx,
		bboxW: component.bboxW,
		bboxH: component.bboxH,
		componentCentroidXPx: component.cx,
		componentCentroidYPx: component.cy + topPx,
		area: component.area,
		fill: component.fill,
		major: component.major,
		minor: component.minor,
		angleRad: component.angle,
		axisMajorMin: component.axisMajorMin,
		axisMajorMax: component.axisMajorMax,
		axisMinorMin: component.axisMinorMin,
		axisMinorMax: component.axisMinorMax
	};
}

function logRatioDelta(f: number, s: number): number {
	return Math.abs(Math.log(Math.max(f, 1) / Math.max(s, 1)));
}

export const teeFamilyUnit: EngineUnit = {
	id: 'teeFamily',
	gate: 'G3',
	consumes: ['stage', 'tees', 'viewport'],
	produces: ['tees'],
	note: 'refine ring-tier tee candidates to the largest mutually-consistent intact-renderer family; component/recovered tiers pass through untouched',
	run(board: EvidenceBoard, ctx: FeatureContext) {
		const stop = ctx.span('teeFamily');
		const state = ctx.resolve(teeFamilyFeature);
		if (state.enabled) {
			const stage = board.get<StageSlot>('stage');
			const tees = board.get<readonly TeeEvidence[]>('tees');
			const { topPx } = board.get<ViewportSlot>('viewport');
			const knobs = state.knobs as unknown as TeeFamilyKnobs;

			const frames = stage.brightComponents.map((component) => toFrame(component, topPx));
			const sizeEligibleCount = frames.filter(
				(f) =>
					f.area >= knobs.frameAreaMin &&
					f.area <= knobs.frameAreaMax &&
					f.bboxW <= knobs.frameMaxWidth &&
					f.bboxH <= knobs.frameMaxHeight
			).length;

			const ringTees = tees.filter((tee) => tee.tier === 'ring');
			const passthrough = tees.filter((tee) => tee.tier !== 'ring');

			// tiers out of the LAB's ported scope: no silent drops, but no
			// refinement decision either — an info drawable records the reason.
			for (const tee of passthrough) {
				ctx.overlay('teeFamily', {
					type: 'point',
					xPx: tee.xPx,
					yPx: tee.yPx,
					verdict: 'info',
					ref: tee.detId,
					reason: `not in family scope (tier ${tee.tier satisfies TeeTier})`
				});
			}

			const measureByTeeId = new Map<string, TeeFamilyMeasure>();
			for (const tee of ringTees) {
				const ring: TeeFamilyRingPoint = { id: tee.detId, cx: tee.xPx, cy: tee.yPx };
				const frame = findEnclosingFrame(ring, frames, knobs);
				if (!frame) {
					ctx.overlay('teeFamily', {
						type: 'point',
						xPx: tee.xPx,
						yPx: tee.yPx,
						verdict: 'rejected',
						ref: tee.detId,
						reason:
							sizeEligibleCount === 0
								? `no valid enclosing frame: zero components satisfy area∈[${knobs.frameAreaMin},${knobs.frameAreaMax}] ∧ bboxW<=${knobs.frameMaxWidth} ∧ bboxH<=${knobs.frameMaxHeight}`
								: `no valid enclosing frame: 0 of ${sizeEligibleCount} size-eligible components contain the ring center`,
						values: {
							ringCx: tee.xPx,
							ringCy: tee.yPx,
							sizeEligibleComponents: sizeEligibleCount,
							totalComponents: frames.length
						}
					});
					continue;
				}
				measureByTeeId.set(tee.detId, { ring, frame });
			}

			const measures = [...measureByTeeId.values()];
			const { family, anchor } = selectTeeFamily(measures, knobs);
			const familyIds = new Set(family.map((m) => m.ring.id));
			const teeById = new Map(ringTees.map((tee) => [tee.detId, tee]));

			for (const [detId, measure] of measureByTeeId) {
				if (familyIds.has(detId)) {
					const tee = teeById.get(detId);
					const pad = teePadEvidence(measure.frame);
					ctx.overlay('teeFamily', {
						type: 'polyline',
						path: [...pad.orientedCorners, pad.orientedCorners[0]],
						verdict: 'accepted',
						visualRole: 'tee-border',
						ref: detId,
						reason: `accepted intact visible tee family; oriented bounds from bright component ${pad.componentLabel}`,
						values: {
							componentLabel: pad.componentLabel,
							frameMajor: pad.majorPx,
							frameMinor: pad.minorPx,
							frameArea: pad.area,
							frameFill: pad.fill,
							frameAngleRad: pad.angleRad,
							frameAngleDeg: (pad.angleRad * 180) / Math.PI,
							componentCentroidX: pad.componentCentroidXPx,
							componentCentroidY: pad.componentCentroidYPx,
							orientedCenterX: pad.centerXPx,
							orientedCenterY: pad.centerYPx,
							axisMajorMin: pad.axisMajorMin,
							axisMajorMax: pad.axisMajorMax,
							axisMinorMin: pad.axisMinorMin,
							axisMinorMax: pad.axisMinorMax,
							...(tee?.angleRad === null || tee?.angleRad === undefined
								? {}
								: {
										ringAngleRad: tee.angleRad,
										ringAngleDeg: (tee.angleRad * 180) / Math.PI
									})
						}
					});
					ctx.overlay('teeFamily', {
						type: 'box',
						bbox: pad.bbox,
						verdict: 'info',
						ref: `${detId}:pad-aabb`,
						reason:
							'enclosing bright component raster AABB retained as secondary evidence; not the oriented object boundary',
						values: {
							componentLabel: pad.componentLabel,
							bboxWidth: pad.bbox[2],
							bboxHeight: pad.bbox[3]
						}
					});
					if (tee?.ring) {
						ctx.overlay('teeFamily', {
							type: 'box',
							bbox: tee.ring.bbox,
							verdict: 'info',
							ref: `${detId}:ring-interior`,
							reason:
								'hollow-interior detector bbox retained separately; never the full tee-pad boundary',
							values: {
								ringArea: tee.ring.area,
								ringElongation: tee.ring.elongation,
								ringFrac: tee.ring.ringFrac
							}
						});
					}
					continue;
				}
				// measured but excluded from the winning family: report the
				// failing log-ratio(s) against the winning anchor (never generic).
				const s = anchor?.frame;
				const f = measure.frame;
				const dMajor = s ? logRatioDelta(f.major, s.major) : NaN;
				const dMinor = s ? logRatioDelta(f.minor, s.minor) : NaN;
				const dArea = s ? logRatioDelta(f.area, s.area) : NaN;
				const majorTol = Math.log(knobs.majorRatioToleranceFactor);
				const minorTol = Math.log(knobs.minorRatioToleranceFactor);
				const areaTol = Math.log(knobs.areaRatioToleranceFactor);
				const failing: string[] = [];
				if (s && dMajor > majorTol) failing.push('major');
				if (s && dMinor > minorTol) failing.push('minor');
				if (s && dArea > areaTol) failing.push('area');
				const orientedCorners = orientedPadCorners(f);
				ctx.overlay('teeFamily', {
					type: 'polyline',
					path: [...orientedCorners, orientedCorners[0]],
					verdict: 'rejected',
					ref: detId,
					reason: `excluded from winning family (anchor ${anchor?.ring.id ?? 'none'}): failing ${failing.length ? failing.join(', ') : 'unknown'} log-ratio(s) — |Δlog major|=${dMajor.toFixed(4)} (tol ${majorTol.toFixed(4)}), |Δlog minor|=${dMinor.toFixed(4)} (tol ${minorTol.toFixed(4)}), |Δlog area|=${dArea.toFixed(4)} (tol ${areaTol.toFixed(4)})`,
					values: {
						dLogMajor: dMajor,
						dLogMinor: dMinor,
						dLogArea: dArea,
						majorTol,
						minorTol,
						areaTol
					}
				});
			}

			// Filter in input order, enriching only accepted ring tees with the
			// promoted full-pad geometry. Surviving tees therefore retain their
			// cy/cx order and opaque detIds while the detector-local ring bbox
			// remains separately available inside each TeeEvidence.
			const familyFrameByTeeId = new Map(
				family.map((measure) => [measure.ring.id, measure.frame] as const)
			);
			const merged: TeeEvidence[] = [];
			for (const tee of tees) {
				if (tee.tier !== 'ring') {
					merged.push(tee);
					continue;
				}
				const frame = familyFrameByTeeId.get(tee.detId);
				if (!frame) continue;
				const pad = teePadEvidence(frame);
				merged.push({ ...tee, bbox: pad.bbox, pad });
			}
			const kept = merged.filter((tee) => tee.tier === 'ring');

			ctx.measure('teeFamily', 'ringCandidates', ringTees.length);
			ctx.measure('teeFamily', 'kept', kept.length);
			ctx.measure('teeFamily', 'dropped', ringTees.length - kept.length);
			board.set('tees', merged);
		}
		stop();
	}
};
