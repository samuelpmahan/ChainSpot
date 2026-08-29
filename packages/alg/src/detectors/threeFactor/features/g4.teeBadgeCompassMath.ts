/**
 * Pure tee→badge COMPASS math for the G4 teeBadgeCompass deviation.
 *
 * Owner directive (2026-08-28): "start with JUST tee->badge. That's the part
 * that carries genuine geometric certainty." This feature pairs each VISIBLE
 * tee to a badge using ONLY tee-local geometry read straight off G1 badges
 * and G3 tees -- the pad's own baseline pose (teeFamily's
 * TeePadEvidence.angleRad/majorPx/minorPx), never G4's optional minAreaPose
 * refinement, never a routed path, never a basket, never anything from
 * `assignment`. There is no import here from g4.teeBadgeLockMath's
 * TeeBadgePath-shaped candidate surface, no corridor/support-field read, no
 * basket geometry -- see g4.teeBadgeCompass.ts for the evidence wiring that
 * enforces this at the board level (consumes only `measurement`).
 *
 * S2 (docs/contracts/2026-08-28-render-stack-reading-contract.md): the TEE
 * is the compass and the BADGE is what it points at. A pad's long axis is a
 * LINE, not a ray -- direction-ambiguous mod 180 degrees -- so every
 * angular comparison below takes the minimum over BOTH directions, literally
 * (not the modulo-pi algebraic shortcut used elsewhere in this codebase),
 * so the 180-degree-ambiguity behavior stays trivially checkable by
 * inspection and by the accompanying unit tests.
 *
 * Footgun law (owner, 2026-08-28): "150 ft holes and 1700 ft holes ... are
 * ALWAYS footguns." Distance is NEVER a cap or filter here -- every badge is
 * a candidate for every tee regardless of how far apart they are. Distance
 * may only break an EXACT floating-point weight tie (see TIE_BREAK_EPSILON).
 */

// ---------------------------------------------------------------------------
// Narrow adapter input shapes. Deliberately do not import TeeEvidence/
// BadgeEvidence's full shapes: this module only ever reads the fields below.

export interface CompassPad {
	readonly angleRad: number;
	readonly majorPx: number;
	readonly minorPx: number;
	/** Raw pose-quality ingredients (TeePadEvidence.area/fill, teeFamily's own
	 * measured values -- no new detection). area doubles as "support pixels":
	 * teeFamily promotes the pad from an exact bright-mask component, so its
	 * area IS that component's pixel count. */
	readonly area: number;
	readonly fill: number;
}

export interface CompassTee {
	readonly detId: string;
	readonly xPx: number;
	readonly yPx: number;
	/** Absent means "no pad geometry" -- receipted as 'no-pad' and excluded,
	 * never silently dropped (the caller must still account for every id in
	 * `noPadTeeIds`). */
	readonly pad?: CompassPad;
}

export interface CompassBadge {
	readonly detId: string;
	/** BadgeEvidence.label -- the exact G1 digit read, or null (UNREAD). Never
	 * a guess; this module never invents a label. */
	readonly label: string | null;
	readonly cxPx: number;
	readonly cyPx: number;
}

function finite(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Printed once, verbatim, in the CLI receipt (owner amendment, mid-build):
 * recovery-fitted poses are excluded by construction here -- this feature
 * reads only `measurement.tees`, the pre-recovery G3 visible-tee list; G4
 * recovery's tees live solely in `assignment.tees`, a slot this feature
 * never consumes. The reason is empirical, not theoretical: in today's
 * NorthPark run every recovery-fitted tee's axis error against its badge is
 * exactly 2.4999999999999973 degrees -- bit-identical across multiple
 * distinct tees, which means it is the fitter's scan-window edge value, not
 * an independent measurement of anything real. Admitting recovered poses
 * here would silently contaminate both the course sigma and the lock table.
 */
export const RECOVERY_POSE_EXCLUSION_NOTE =
	'recovery-fitted tee poses are excluded by construction (this feature reads only ' +
	"measurement.tees, the pre-recovery G3 visible-tee list) -- empirically, today's NorthPark " +
	'recovery axis errors are all exactly 2.4999999999999973 deg, a scan-window-edge constant ' +
	'from the fitter, not an independent measurement, so recovered poses would silently ' +
	'contaminate both the course sigma and the lock table if ever admitted here.';

// ---------------------------------------------------------------------------
// Axis vs. bearing: the literal 180-degree-ambiguous comparison.

export interface AxisBearingComparison {
	readonly angularErrorDeg: number;
	/** Whichever of (axisRad, axisRad + PI) most nearly matches bearingRad --
	 * the direction the pad is actually "aiming", used only for drawing the
	 * compass polyline; it never affects the size of the error itself
	 * (min(a,b) is symmetric). */
	readonly aimRad: number;
}

function wrapToPi(rad: number): number {
	const twoPi = 2 * Math.PI;
	let wrapped = rad % twoPi;
	if (wrapped > Math.PI) wrapped -= twoPi;
	if (wrapped < -Math.PI) wrapped += twoPi;
	return wrapped;
}

function directedAngleDiffDeg(aRad: number, bRad: number): number {
	return (Math.abs(wrapToPi(aRad - bRad)) * 180) / Math.PI;
}

/**
 * The pad's major axis is a LINE: it points equally in the `axisRad` and
 * `axisRad + PI` directions. Comparing it against a directed bearing takes
 * the minimum over both directions -- literally two comparisons, not a
 * mod-PI algebraic identity, so the 180-degree ambiguity this function
 * exists to handle stays visible in the code and in its tests.
 */
export function axisBearingError(axisRad: number, bearingRad: number): AxisBearingComparison {
	const towardDeg = directedAngleDiffDeg(axisRad, bearingRad);
	const awayDeg = directedAngleDiffDeg(axisRad + Math.PI, bearingRad);
	return towardDeg <= awayDeg
		? { angularErrorDeg: towardDeg, aimRad: axisRad }
		: { angularErrorDeg: awayDeg, aimRad: axisRad + Math.PI };
}

// ---------------------------------------------------------------------------
// Geometry: one row per (eligible tee, badge) pair. Every badge is a
// candidate for every eligible tee -- no spatial prefilter, no distance cap.

export interface CompassGeometryRow {
	readonly teeId: string;
	readonly badgeId: string;
	readonly teeXPx: number;
	readonly teeYPx: number;
	readonly badgeXPx: number;
	readonly badgeYPx: number;
	readonly bearingRad: number;
	readonly aimRad: number;
	readonly angularErrorDeg: number;
	readonly distancePx: number;
}

export interface CompassGeometry {
	readonly rows: readonly CompassGeometryRow[];
	/** Tees with usable pad geometry, in input order. */
	readonly eligibleTeeIds: readonly string[];
	/** Tees excluded for having no pad at all -- 'no-pad' verdict, never a
	 * silent drop. */
	readonly noPadTeeIds: readonly string[];
	readonly badgeIds: readonly string[];
}

export function buildCompassGeometry(
	tees: readonly CompassTee[],
	badges: readonly CompassBadge[]
): CompassGeometry {
	const eligibleTeeIds: string[] = [];
	const noPadTeeIds: string[] = [];
	const rows: CompassGeometryRow[] = [];
	for (const tee of tees) {
		const pad = tee.pad;
		if (!pad || !finite(pad.angleRad) || !finite(pad.majorPx) || !finite(pad.minorPx)) {
			noPadTeeIds.push(tee.detId);
			continue;
		}
		eligibleTeeIds.push(tee.detId);
		for (const badge of badges) {
			const dx = badge.cxPx - tee.xPx;
			const dy = badge.cyPx - tee.yPx;
			const distancePx = Math.hypot(dx, dy);
			const bearingRad = Math.atan2(dy, dx);
			const { angularErrorDeg, aimRad } = axisBearingError(pad.angleRad, bearingRad);
			rows.push({
				teeId: tee.detId,
				badgeId: badge.detId,
				teeXPx: tee.xPx,
				teeYPx: tee.yPx,
				badgeXPx: badge.cxPx,
				badgeYPx: badge.cyPx,
				bearingRad,
				aimRad,
				angularErrorDeg,
				distancePx
			});
		}
	}
	return { rows, eligibleTeeIds, noPadTeeIds, badgeIds: badges.map((badge) => badge.detId) };
}

// ---------------------------------------------------------------------------
// Sigma: course-derived, printed provenance, floored at raster quantization,
// UNKNOWN + loud fallback when the course gives too few tees to trust.

export interface CompassSigmaKnobs {
	/** Robust upper quantile fraction applied to each tee's best-badge
	 * angular error (e.g. 0.9 = P90). A statistical parameter, not a physics
	 * constant -- see g4.teeBadgeCompass.ts's knob declaration for the
	 * rationale. */
	readonly quantileFraction: number;
	/** Below this many eligible (padded) tees, a quantile has nothing
	 * meaningful to rank -- sigma falls back loudly to the raster floor. */
	readonly minimumSampleSize: number;
	/** Half a raster cell plus its diagonal quantization allowance, in
	 * source pixels -- the same value and rationale as
	 * g3.teeRecovery.ts's RASTER_TOLERANCE_PX (duplicated rather than
	 * imported: that constant is module-private and this module stays
	 * import-free of the recovery feature). This is raster geometry, not an
	 * invented degree constant: it is converted to a degree-domain floor via
	 * the course's own measured tee-to-badge distances below. */
	readonly rasterTolerancePx: number;
}

export interface CompassSigmaDerivation {
	readonly sigmaDeg: number;
	readonly floorDeg: number | 'UNKNOWN';
	readonly quantileFraction: number;
	readonly quantileValueDeg: number | 'UNKNOWN';
	/** Every eligible (padded) tee, regardless of pose quality -- used only
	 * for the raster-floor's representative distance (a scale fact, not a
	 * confidence fact). */
	readonly totalEligibleTees: number;
	/** Eligible tees whose pose quality was degraded (see
	 * CompassPoseQuality) and were therefore left OUT of the quantile
	 * sample below, per the owner's mid-build amendment: one bad pose must
	 * not pollute the course sigma. */
	readonly excludedForPoseQuality: number;
	/** totalEligibleTees - excludedForPoseQuality: the actual quantile
	 * sample size. */
	readonly sampleSize: number;
	readonly minimumSampleSize: number;
	readonly representativeDistancePx: number | 'UNKNOWN';
	/** true when the quantile could not be trusted and sigma fell back to
	 * the raster floor alone -- printed loudly, never silently. */
	readonly isFallback: boolean;
	readonly provenance: string;
}

function percentile(sortedAscending: readonly number[], fraction: number): number {
	if (sortedAscending.length === 1) return sortedAscending[0];
	const rank = fraction * (sortedAscending.length - 1);
	const low = Math.floor(rank);
	const high = Math.ceil(rank);
	if (low === high) return sortedAscending[low];
	const t = rank - low;
	return sortedAscending[low] * (1 - t) + sortedAscending[high] * t;
}

function median(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	return percentile(sorted, 0.5);
}

/** Each eligible tee's single best (smallest angular error) candidate badge
 * -- the per-tee "how well could this course's compass possibly read"
 * sample the sigma quantile is drawn from. */
function bestPerTee(geometry: CompassGeometry): readonly CompassGeometryRow[] {
	const best = new Map<string, CompassGeometryRow>();
	for (const row of geometry.rows) {
		const current = best.get(row.teeId);
		if (!current || row.angularErrorDeg < current.angularErrorDeg) best.set(row.teeId, row);
	}
	return geometry.eligibleTeeIds.flatMap((teeId) => {
		const row = best.get(teeId);
		return row ? [row] : [];
	});
}

function rasterFloorDeg(representativeDistancePx: number, rasterTolerancePx: number): number {
	// Guard against a degenerate near-zero course distance blowing the floor
	// up past a right angle; the tolerance itself is the geometric lower
	// bound on "distance" this conversion can honestly reason about.
	const distance = Math.max(representativeDistancePx, rasterTolerancePx);
	return (Math.atan2(rasterTolerancePx, distance) * 180) / Math.PI;
}

/**
 * sigma = max(P<quantileFraction>(each NON-DEGRADED eligible tee's
 * best-badge angular error), raster-quantization floor). The raster floor
 * itself is a scale fact (median best tee-badge distance) and is computed
 * from ALL eligible tees regardless of pose quality; only the QUANTILE
 * sample excludes tees whose pose quality is degraded (`degradedTeeIds`,
 * owner's mid-build amendment: "one bad pose must not pollute the course
 * sigma"). Below `minimumSampleSize` non-degraded tees, the quantile is not
 * computed at all (UNKNOWN) and sigma falls back to the floor alone, loudly
 * labeled `isFallback: true` -- per the owner's brief, "print sigma UNKNOWN
 * and fall back loudly -- never silently."
 */
export function deriveCompassSigma(
	geometry: CompassGeometry,
	knobs: CompassSigmaKnobs,
	degradedTeeIds: ReadonlySet<string> = new Set()
): CompassSigmaDerivation {
	const allBestRows = bestPerTee(geometry);
	const totalEligibleTees = allBestRows.length;
	if (totalEligibleTees === 0) {
		return {
			sigmaDeg: NaN,
			floorDeg: 'UNKNOWN',
			quantileFraction: knobs.quantileFraction,
			quantileValueDeg: 'UNKNOWN',
			totalEligibleTees: 0,
			excludedForPoseQuality: 0,
			sampleSize: 0,
			minimumSampleSize: knobs.minimumSampleSize,
			representativeDistancePx: 'UNKNOWN',
			isFallback: true,
			provenance:
				'sigma UNKNOWN: zero eligible (padded) visible tees on this course -- no angular-error ' +
				'sample exists to derive a course sigma from; no tee-badge scoring can run.'
		};
	}
	// The floor is raster/scale geometry, not a confidence judgment: every
	// eligible tee (degraded pose or not) contributes its own scale to it.
	const representativeDistancePx = median(allBestRows.map((row) => row.distancePx));
	const floorDeg = rasterFloorDeg(representativeDistancePx, knobs.rasterTolerancePx);

	const qualityRows = allBestRows.filter((row) => !degradedTeeIds.has(row.teeId));
	const sampleSize = qualityRows.length;
	const excludedForPoseQuality = totalEligibleTees - sampleSize;
	const exclusionNote =
		excludedForPoseQuality > 0
			? ` (${excludedForPoseQuality} of ${totalEligibleTees} eligible tee(s) excluded for degraded ` +
				'pose quality -- see POSE QUALITY below)'
			: '';
	if (sampleSize < knobs.minimumSampleSize) {
		return {
			sigmaDeg: floorDeg,
			floorDeg,
			quantileFraction: knobs.quantileFraction,
			quantileValueDeg: 'UNKNOWN',
			totalEligibleTees,
			excludedForPoseQuality,
			sampleSize,
			minimumSampleSize: knobs.minimumSampleSize,
			representativeDistancePx,
			isFallback: true,
			provenance:
				`sigma UNKNOWN: only ${sampleSize} non-degraded eligible tee(s) on this course${exclusionNote}, ` +
				`below minimumSampleSize=${knobs.minimumSampleSize} -- a robust upper quantile needs more ` +
				'points than this to mean anything. FALLING BACK LOUDLY to the raster-quantization floor: ' +
				`atan(rasterTolerancePx=${knobs.rasterTolerancePx}px / medianBestDistancePx=` +
				`${representativeDistancePx.toFixed(1)}px) = ${floorDeg.toFixed(3)} deg.`
		};
	}
	const angularErrorsAscending = qualityRows.map((row) => row.angularErrorDeg).sort((a, b) => a - b);
	const quantileValueDeg = percentile(angularErrorsAscending, knobs.quantileFraction);
	const sigmaDeg = Math.max(quantileValueDeg, floorDeg);
	return {
		sigmaDeg,
		floorDeg,
		quantileFraction: knobs.quantileFraction,
		quantileValueDeg,
		totalEligibleTees,
		excludedForPoseQuality,
		sampleSize,
		minimumSampleSize: knobs.minimumSampleSize,
		representativeDistancePx,
		isFallback: false,
		provenance:
			`sigma = max(P${Math.round(knobs.quantileFraction * 100)}(bestAngularErrorDeg over ${sampleSize} ` +
			`non-degraded eligible tees${exclusionNote}) = ${quantileValueDeg.toFixed(3)} deg, rasterFloorDeg = ` +
			`${floorDeg.toFixed(3)} deg [atan(${knobs.rasterTolerancePx}px raster tolerance / ` +
			`${representativeDistancePx.toFixed(1)}px median best tee-badge distance, over all ` +
			`${totalEligibleTees} eligible tees)]) = ${sigmaDeg.toFixed(3)} deg.`
	};
}

// ---------------------------------------------------------------------------
// Pose quality: raw ingredients only, no invented formula. Owner amendment
// (mid-build): a tee whose pose came from a weak fit can read "randomly a
// few to a dozen degrees off" even though real compass precision is 1-3
// degrees for a well-fitted pose -- measure the pose itself rather than
// assume every accepted pad is equally trustworthy.

export interface CompassPoseQualityKnobs {
	/** Reuses g3.teeFamily's own intactness-tolerance convention
	 * (majorRatioToleranceFactor/fillRatioToleranceFactor, both 1.25 there):
	 * a pad whose fill sits more than this factor BELOW the course's own
	 * median fill is a weak/partial fit. Not a new magic constant -- the
	 * same ratio-tolerance idiom already accepted in this codebase, applied
	 * to a course-measured median instead of an imported number. */
	readonly fillToleranceFactor: number;
	/** A pad whose area sits more than this factor away from the course's
	 * own median area, in EITHER direction (S8 uniformity: every pad in one
	 * photo shares one size class, so any deviation is suspect), is a
	 * weak/degraded fit. */
	readonly areaToleranceFactor: number;
}

export interface CompassPoseQuality {
	readonly teeId: string;
	/** = pad.area: teeFamily promotes the pad from an exact bright-mask
	 * component, so its area IS that component's support-pixel count. */
	readonly supportPx: number;
	readonly fill: number;
	readonly majorPx: number;
	readonly minorPx: number;
	readonly courseMedianSupportPx: number;
	readonly courseMedianFill: number;
	readonly courseMedianMajorPx: number;
	readonly courseMedianMinorPx: number;
	readonly degraded: boolean;
	readonly degradedReason: string | null;
}

/** Course-derived, per eligible (padded) tee -- prints the raw ingredients
 * (support pixels, fill, major/minor vs the course's own median) rather
 * than a synthesized quality score. */
export function computeCompassPoseQuality(
	tees: readonly CompassTee[],
	knobs: CompassPoseQualityKnobs
): readonly CompassPoseQuality[] {
	const padded = tees.filter(
		(tee): tee is CompassTee & { pad: CompassPad } =>
			Boolean(tee.pad) && finite(tee.pad!.area) && finite(tee.pad!.fill)
	);
	const courseMedianSupportPx = median(padded.map((tee) => tee.pad.area));
	const courseMedianFill = median(padded.map((tee) => tee.pad.fill));
	const courseMedianMajorPx = median(padded.map((tee) => tee.pad.majorPx));
	const courseMedianMinorPx = median(padded.map((tee) => tee.pad.minorPx));
	return padded.map((tee) => {
		const pad = tee.pad;
		const reasons: string[] = [];
		if (courseMedianFill > 0) {
			const floor = courseMedianFill / knobs.fillToleranceFactor;
			if (pad.fill < floor) {
				reasons.push(
					`fill ${pad.fill.toFixed(3)} < courseMedianFill ${courseMedianFill.toFixed(3)} / ` +
						`fillToleranceFactor ${knobs.fillToleranceFactor} = ${floor.toFixed(3)}`
				);
			}
		}
		if (courseMedianSupportPx > 0) {
			const logRatio = Math.log(pad.area / courseMedianSupportPx);
			const logTolerance = Math.log(knobs.areaToleranceFactor);
			if (Math.abs(logRatio) > logTolerance) {
				reasons.push(
					`|log(area ${pad.area} / courseMedianArea ${courseMedianSupportPx.toFixed(1)})| = ` +
						`${Math.abs(logRatio).toFixed(3)} > log(areaToleranceFactor ` +
						`${knobs.areaToleranceFactor}) = ${logTolerance.toFixed(3)}`
				);
			}
		}
		return {
			teeId: tee.detId,
			supportPx: pad.area,
			fill: pad.fill,
			majorPx: pad.majorPx,
			minorPx: pad.minorPx,
			courseMedianSupportPx,
			courseMedianFill,
			courseMedianMajorPx,
			courseMedianMinorPx,
			degraded: reasons.length > 0,
			degradedReason: reasons.length > 0 ? reasons.join('; ') : null
		};
	});
}

// ---------------------------------------------------------------------------
// Scoring: a pure monotone function of angularErrorDeg alone. Distance never
// enters the weight.

export interface CompassScoredRow extends CompassGeometryRow {
	readonly weight: number;
}

export function scoreCompassGeometry(
	geometry: CompassGeometry,
	sigmaDeg: number
): readonly CompassScoredRow[] {
	if (!(sigmaDeg > 0)) {
		throw new Error('teeBadgeCompass: sigmaDeg must be a positive finite number to score candidates.');
	}
	return geometry.rows.map((row) => ({
		...row,
		weight: Math.exp(-((row.angularErrorDeg / sigmaDeg) ** 2))
	}));
}

// ---------------------------------------------------------------------------
// Matching: one-to-one maximum-weight tees x badges. Distance only breaks an
// EXACT weight tie (footgun law: never a cap or filter).

/** Perturbation applied only to resolve a bit-exact weight tie in favor of
 * the closer badge. Chosen so that even the largest plausible raster
 * distance (~1e4 px) times this epsilon (~1e-5) sits many orders of
 * magnitude below the smallest real weight difference two distinguishable
 * angularErrorDeg values can produce at any sigma this module will ever be
 * given (sigma is degrees, never sub-hundredth-of-a-degree) -- so it can
 * never override a real ranking, only break a genuine tie. */
const TIE_BREAK_EPSILON = 1e-9;

function tieBreakWeight(weight: number, distancePx: number): number {
	return weight - distancePx * TIE_BREAK_EPSILON;
}

/**
 * Deterministic Hungarian maximization over a dense weight matrix. Adapted
 * (duplicated, not imported) from g4.teeBadgeLockMath.ts's own
 * `hungarianMaximum`: that function is pure NxN weighted-bipartite-matching
 * math with zero routing/basket/path coupling, so reusing the ALGORITHM is
 * safe per the owner's brief -- duplicated here rather than imported so
 * this module stays free of teeBadgeLock's TeeBadgePath-shaped candidate
 * type surface and neither feature can accidentally couple to the other's
 * internals. The matrix is padded with zero dummy slots only when the two
 * real dimensions differ; no dummy identifier can escape in the result.
 */
function hungarianMaximum(weights: readonly (readonly number[])[]): readonly [number, number][] {
	const rows = weights.length;
	const cols = rows ? weights[0].length : 0;
	const size = Math.max(rows, cols);
	if (size === 0) return [];
	const cost = Array.from({ length: size + 1 }, (_, i) =>
		Array.from({ length: size + 1 }, (_, j) =>
			i === 0 || j === 0 ? 0 : -(weights[i - 1]?.[j - 1] ?? 0)
		)
	);
	const u = new Array<number>(size + 1).fill(0);
	const v = new Array<number>(size + 1).fill(0);
	const p = new Array<number>(size + 1).fill(0);
	const way = new Array<number>(size + 1).fill(0);
	for (let i = 1; i <= size; i++) {
		p[0] = i;
		let j0 = 0;
		const minv = new Array<number>(size + 1).fill(Infinity);
		const used = new Array<boolean>(size + 1).fill(false);
		do {
			used[j0] = true;
			const i0 = p[j0];
			let delta = Infinity;
			let j1 = 0;
			for (let j = 1; j <= size; j++) {
				if (used[j]) continue;
				const current = cost[i0][j] - u[i0] - v[j];
				if (current < minv[j]) {
					minv[j] = current;
					way[j] = j0;
				}
				if (minv[j] < delta || (Object.is(minv[j], delta) && j < j1)) {
					delta = minv[j];
					j1 = j;
				}
			}
			for (let j = 0; j <= size; j++) {
				if (used[j]) {
					u[p[j]] += delta;
					v[j] -= delta;
				} else minv[j] -= delta;
			}
			j0 = j1;
		} while (p[j0] !== 0);
		do {
			const j1 = way[j0];
			p[j0] = p[j1];
			j0 = j1;
		} while (j0 !== 0);
	}
	const pairs: [number, number][] = [];
	for (let j = 1; j <= size; j++) {
		const row = p[j];
		if (row > 0 && row <= rows && j <= cols) pairs.push([row - 1, j - 1]);
	}
	return pairs;
}

/**
 * 'locked-weak-pose' (owner mid-build amendment): a pair that would
 * otherwise be 'locked' but whose WINNING tee's own pose quality is
 * degraded (see CompassPoseQuality) -- the pairing still stands as the best
 * available answer, but the confidence claim is explicitly downgraded so a
 * human reading the receipt does not mistake a weak fit for a tight one.
 * 'ambiguous' pairs are never further downgraded by pose quality: they are
 * already the "not confident" bucket for a different reason (a close
 * runner-up), and pose quality does not change that.
 * 'abstained-contested' (wave-peeling toposort resolver, see
 * resolveClaimsByWavePeeling below): a tee that never became a forced
 * "naked single" against any badge -- it and every badge it still competes
 * for are named as one contested cluster and the resolver explicitly
 * abstains rather than guess. Distinct from 'ambiguous' (the max-weight
 * matcher's own runner-up-gap verdict): the two verdicts belong to
 * different resolution strategies and are never produced by the same call.
 */
export type CompassVerdict = 'locked' | 'locked-weak-pose' | 'ambiguous' | 'abstained-contested';

export interface CompassRunnerUp {
	readonly badgeId: string;
	readonly angularErrorDeg: number;
	readonly distancePx: number;
	readonly weight: number;
	/** runner-up's angularErrorDeg minus the locked pair's angularErrorDeg.
	 * Can be negative when the global matching did not hand this tee its own
	 * best-fitting badge (a rarer, even-more-ambiguous case) -- a negative
	 * gap is always < resolutionBoundDeg and therefore always verdict
	 * 'ambiguous', which is the correct, honest outcome. */
	readonly gapDeg: number;
}

export interface CompassLock extends CompassGeometryRow {
	readonly weight: number;
	/** null only when this tee had exactly one candidate badge total (n=1
	 * hole course) -- there is nothing to be ambiguous against. */
	readonly runnerUp: CompassRunnerUp | null;
	readonly verdict: CompassVerdict;
	/** Tee center walked `distancePx` along `aimRad` -- NOT the badge's own
	 * coordinates. This is the literal compass reading: when angularErrorDeg
	 * is nonzero the endpoint visibly misses the badge by that amount,
	 * rather than silently snapping onto it. */
	readonly axisEndpointPx: readonly [number, number];
	/** Wave-peeling only (resolveClaimsByWavePeeling): the pass number this
	 * lock was resolved in -- 1 means it was a naked single from the start,
	 * needing no other lock to force it. Absent (undefined) for locks
	 * produced by the max-weight matcher (matchTeeBadgeCompass). */
	readonly waveNumber?: number;
	/** Wave-peeling only: badgeIds of earlier-wave locks whose removal from
	 * the candidate graph is what forced this lock into a naked single.
	 * Empty for a wave-1 lock. Absent for the max-weight matcher's locks. */
	readonly forcedBy?: readonly string[];
	/** Wave-peeling only, present when verdict is 'abstained-contested': the
	 * full badgeId set of the contested cluster this tee belongs to. Absent
	 * otherwise. */
	readonly clusterBadgeIds?: readonly string[];
	/** Wave-peeling only, present when verdict is 'abstained-contested': the
	 * index of the contested cluster this tee belongs to (stable within one
	 * run, not across runs). Absent otherwise. */
	readonly clusterIndex?: number;
}

export interface CompassUnmatchedBadge {
	readonly badgeId: string;
	/** 'no-tee-left': the matching gave this badge no tee at all (structural
	 * cardinality shortfall -- occlusion reduced eligible tees below badge
	 * count). 'all-candidates-ambiguous': the matching DID assign a tee, but
	 * that pairing's own gap fell under the resolution bound, so it does not
	 * count as a confident claim on this badge. */
	readonly reason: 'no-tee-left' | 'all-candidates-ambiguous';
}

export interface CompassMatchResult {
	/** One row per tee that received ANY raw assignment, whether its verdict
	 * is 'locked' or 'ambiguous'. A tee absent from both this array and
	 * `unusedTeeIds` never happened in the six Dev6 courses (eligible tees
	 * never outnumber badges there) but is not assumed impossible; every
	 * eligible tee id supplied to this function ends up in exactly one of
	 * `locks` or `unusedTeeIds`. */
	readonly locks: readonly CompassLock[];
	readonly unmatchedBadges: readonly CompassUnmatchedBadge[];
	readonly unusedTeeIds: readonly string[];
}

export interface MatchTeeBadgeCompassOptions {
	/** Every eligible (padded) tee id, in canonical order. */
	readonly teeIds: readonly string[];
	/** Every badge id, in canonical order. */
	readonly badgeIds: readonly string[];
	/** A matched pair's runner-up gap strictly below this bound downgrades
	 * the pair from 'locked' to 'ambiguous'. Must be finite and >= 0. */
	readonly resolutionBoundDeg: number;
	/** Tee ids whose own pose quality is degraded (CompassPoseQuality).
	 * Their weight is computed EXACTLY like every other tee's (weight stays
	 * a pure function of angularErrorDeg alone) -- this set only downgrades
	 * a winning 'locked' verdict to 'locked-weak-pose' after the fact; it
	 * never removes a tee from the matching or changes its weight. */
	readonly degradedTeeIds?: ReadonlySet<string>;
}

/**
 * One-to-one maximum-weight matching, tees x badges. There is intentionally
 * no score threshold: distance is never a cap or filter (the owner's
 * footgun law), only a last-resort exact-tie-break inside the weights
 * themselves. Ambiguity is evaluated per matched pair AFTER the global
 * optimum is found, from that tee's own local ranking of every badge (not
 * only the one the global solver happened to hand it).
 */
export function matchTeeBadgeCompass(
	scoredRows: readonly CompassScoredRow[],
	options: MatchTeeBadgeCompassOptions
): CompassMatchResult {
	const { teeIds, badgeIds, resolutionBoundDeg, degradedTeeIds } = options;
	if (!(resolutionBoundDeg >= 0)) {
		throw new Error('teeBadgeCompass: resolutionBoundDeg must be a finite number >= 0.');
	}

	const byPair = new Map<string, CompassScoredRow>();
	for (const row of scoredRows) {
		if (!finite(row.weight)) throw new Error('teeBadgeCompass: candidate weights must be finite.');
		byPair.set(`${row.teeId} ${row.badgeId}`, row);
	}

	// Tee-major matrix: rows = tees, cols = badges -- mirrors S2's framing
	// (the tee is the compass; the matching optimizes total compass
	// confidence, one badge per tee and one tee per badge).
	const sparseWeights = teeIds.map((teeId) =>
		badgeIds.map((badgeId) => byPair.get(`${teeId} ${badgeId}`))
	);
	const maxAbsWeight = scoredRows.reduce((max, row) => Math.max(max, Math.abs(row.weight)), 0);
	const matrixSize = Math.max(teeIds.length, badgeIds.length);
	// Missing testimony is not a zero-score candidate (every real tee x badge
	// pair should exist in a full cross product; this only guards a caller
	// passing an id absent from scoredRows). Penalize it enough that the
	// solver maximizes real-edge cardinality before total weight.
	const missingEdgeWeight = -(2 * maxAbsWeight * matrixSize + 1);
	const denseWeights = sparseWeights.map((row) =>
		row.map((candidate) =>
			candidate ? tieBreakWeight(candidate.weight, candidate.distancePx) : missingEdgeWeight
		)
	);
	const assignments = hungarianMaximum(denseWeights);

	const rawAssignment = new Map<string, string>(); // teeId -> badgeId
	for (const [rowIndex, colIndex] of assignments) {
		const teeId = teeIds[rowIndex];
		const badgeId = badgeIds[colIndex];
		if (byPair.has(`${teeId} ${badgeId}`)) rawAssignment.set(teeId, badgeId);
	}

	const locks: CompassLock[] = [];
	for (const [teeId, badgeId] of rawAssignment) {
		const matched = byPair.get(`${teeId} ${badgeId}`)!;
		const others = badgeIds
			.filter((id) => id !== badgeId)
			.map((id) => byPair.get(`${teeId} ${id}`))
			.filter((row): row is CompassScoredRow => row !== undefined)
			.sort((a, b) => b.weight - a.weight || a.distancePx - b.distancePx);
		const runnerUpRow = others[0];
		const runnerUp: CompassRunnerUp | null = runnerUpRow
			? {
					badgeId: runnerUpRow.badgeId,
					angularErrorDeg: runnerUpRow.angularErrorDeg,
					distancePx: runnerUpRow.distancePx,
					weight: runnerUpRow.weight,
					gapDeg: runnerUpRow.angularErrorDeg - matched.angularErrorDeg
				}
			: null;
		const wouldLock = runnerUp === null || !(runnerUp.gapDeg < resolutionBoundDeg);
		const verdict: CompassVerdict = !wouldLock
			? 'ambiguous'
			: degradedTeeIds?.has(teeId)
				? 'locked-weak-pose'
				: 'locked';
		locks.push({
			...matched,
			runnerUp,
			verdict,
			axisEndpointPx: [
				matched.teeXPx + matched.distancePx * Math.cos(matched.aimRad),
				matched.teeYPx + matched.distancePx * Math.sin(matched.aimRad)
			]
		});
	}

	// 'locked-weak-pose' still counts as a definite claim on its badge -- the
	// pose-quality flag says "scrutinize this", not "this badge has no tee".
	const confidentBadgeIds = new Set(
		locks
			.filter((lock) => lock.verdict === 'locked' || lock.verdict === 'locked-weak-pose')
			.map((lock) => lock.badgeId)
	);
	const assignedBadgeIds = new Set(rawAssignment.values());
	const unmatchedBadges: CompassUnmatchedBadge[] = badgeIds
		.filter((badgeId) => !confidentBadgeIds.has(badgeId))
		.map((badgeId) => ({
			badgeId,
			reason: assignedBadgeIds.has(badgeId) ? 'all-candidates-ambiguous' : 'no-tee-left'
		}));

	const usedTeeIds = new Set(locks.map((lock) => lock.teeId));
	const unusedTeeIds = teeIds.filter((id) => !usedTeeIds.has(id));

	return { locks, unmatchedBadges, unusedTeeIds };
}

// ---------------------------------------------------------------------------
// Orchestration: the single call the feature module makes.

export interface TeeBadgeCompassResult {
	readonly geometry: CompassGeometry;
	readonly poseQuality: readonly CompassPoseQuality[];
	readonly sigma: CompassSigmaDerivation;
	/** Reused directly as sigma's raster floor -- a gap smaller than our own
	 * measurement's raster-quantization noise floor is not a real
	 * distinction, so this avoids inventing a second constant. */
	readonly resolutionBoundDeg: number;
	readonly locks: readonly CompassLock[];
	readonly unmatchedBadges: readonly CompassUnmatchedBadge[];
	readonly unusedTeeIds: readonly string[];
	readonly noPadTeeIds: readonly string[];
}

export interface TeeBadgeCompassKnobs extends CompassSigmaKnobs, CompassPoseQualityKnobs {}

export function runTeeBadgeCompass(
	tees: readonly CompassTee[],
	badges: readonly CompassBadge[],
	knobs: TeeBadgeCompassKnobs
): TeeBadgeCompassResult {
	const geometry = buildCompassGeometry(tees, badges);
	const poseQuality = computeCompassPoseQuality(tees, knobs);
	const degradedTeeIds = new Set(
		poseQuality.filter((quality) => quality.degraded).map((quality) => quality.teeId)
	);
	const sigma = deriveCompassSigma(geometry, knobs, degradedTeeIds);
	const resolutionBoundDeg = typeof sigma.floorDeg === 'number' ? sigma.floorDeg : 0;
	if (geometry.eligibleTeeIds.length === 0 || geometry.badgeIds.length === 0) {
		return {
			geometry,
			poseQuality,
			sigma,
			resolutionBoundDeg,
			locks: [],
			unmatchedBadges: geometry.badgeIds.map((badgeId) => ({
				badgeId,
				reason: 'no-tee-left' as const
			})),
			unusedTeeIds: [...geometry.eligibleTeeIds],
			noPadTeeIds: geometry.noPadTeeIds
		};
	}
	const scored = scoreCompassGeometry(geometry, sigma.sigmaDeg);
	const match = matchTeeBadgeCompass(scored, {
		teeIds: geometry.eligibleTeeIds,
		badgeIds: geometry.badgeIds,
		resolutionBoundDeg,
		degradedTeeIds
	});
	return {
		geometry,
		poseQuality,
		sigma,
		resolutionBoundDeg,
		locks: match.locks,
		unmatchedBadges: match.unmatchedBadges,
		unusedTeeIds: match.unusedTeeIds,
		noPadTeeIds: geometry.noPadTeeIds
	};
}

// ---------------------------------------------------------------------------
// Hole-label enrichment. Owner rule: map through BadgeEvidence.label, print
// UNREAD, never guess. This is pure presentation enrichment over the result
// above -- it never changes a lock, a verdict, or a match.

export function exactPositiveHole(label: string | null | undefined): number | undefined {
	if (typeof label !== 'string' || !/^[1-9]\d*$/.test(label)) return undefined;
	const value = Number(label);
	return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function labelText(label: string | null | undefined): string {
	return typeof label === 'string' && label.length > 0 ? label : 'UNREAD';
}

export interface CompassLockHoleLabeled extends CompassLock {
	readonly hole?: number;
	readonly badgeLabel: string;
	readonly runnerUpHole?: number;
	readonly runnerUpBadgeLabel?: string;
}

export interface CompassUnmatchedBadgeHoleLabeled extends CompassUnmatchedBadge {
	readonly hole?: number;
	readonly badgeLabel: string;
}

export interface TeeBadgeCompassEvidence extends TeeBadgeCompassResult {
	readonly coordinateFrame: 'canonical-raster';
	readonly basketEvidenceRead: false;
	readonly assignmentRead: false;
	readonly locksHoleLabeled: readonly CompassLockHoleLabeled[];
	readonly unmatchedBadgesHoleLabeled: readonly CompassUnmatchedBadgeHoleLabeled[];
}

export function buildTeeBadgeCompassEvidence(
	result: TeeBadgeCompassResult,
	badges: readonly CompassBadge[]
): TeeBadgeCompassEvidence {
	const badgeById = new Map(badges.map((badge) => [badge.detId, badge]));
	const locksHoleLabeled: CompassLockHoleLabeled[] = result.locks.map((lock) => {
		const badge = badgeById.get(lock.badgeId);
		const runnerUpBadge = lock.runnerUp ? badgeById.get(lock.runnerUp.badgeId) : undefined;
		return {
			...lock,
			hole: exactPositiveHole(badge?.label),
			badgeLabel: labelText(badge?.label),
			...(lock.runnerUp
				? {
						runnerUpHole: exactPositiveHole(runnerUpBadge?.label),
						runnerUpBadgeLabel: labelText(runnerUpBadge?.label)
					}
				: {})
		};
	});
	const unmatchedBadgesHoleLabeled: CompassUnmatchedBadgeHoleLabeled[] = result.unmatchedBadges.map(
		(entry) => {
			const badge = badgeById.get(entry.badgeId);
			return { ...entry, hole: exactPositiveHole(badge?.label), badgeLabel: labelText(badge?.label) };
		}
	);
	return {
		...result,
		coordinateFrame: 'canonical-raster',
		basketEvidenceRead: false,
		assignmentRead: false,
		locksHoleLabeled,
		unmatchedBadgesHoleLabeled
	};
}

// ---------------------------------------------------------------------------
// Wave-peeling toposort: pure claim resolution via iterated forced pairing.

export interface WavePeelLock {
	readonly teeId: string;
	readonly badgeId: string;
	readonly wave: number;
	/** badgeIds of earlier locks whose removal forced this one; empty for wave 1 */
	readonly forcedBy: readonly string[];
}

export interface ContestedCluster {
	readonly teeIds: readonly string[];
	readonly badgeIds: readonly string[];
	readonly pairs: readonly {
		readonly teeId: string;
		readonly badgeId: string;
		readonly angularErrorDeg: number;
	}[];
}

export interface WavePeelResult {
	readonly locks: readonly WavePeelLock[];
	readonly contestedClusters: readonly ContestedCluster[];
}

/**
 * Pure toposort wave-peeling claim resolver. Kahn-style: iteratively lock
 * every pair where the tee has exactly one edge OR the badge has exactly one
 * edge, removing locked tees/badges and their edges, until no forced pair
 * remains. Remaining connected components become contested clusters.
 *
 * Deterministic: iteration sorted by teeId/badgeId. Weak-pose tees are
 * assumed to be filtered by the caller (do not reach here).
 */
export function resolveClaimsByWavePeeling(
	edges: readonly { teeId: string; badgeId: string; angularErrorDeg: number }[]
): WavePeelResult {
	const locks: WavePeelLock[] = [];
	const edgesByKey = new Map<string, { teeId: string; badgeId: string; angularErrorDeg: number }>();
	const teeAdj = new Map<string, Set<string>>();
	const badgeAdj = new Map<string, Set<string>>();

	for (const edge of edges) {
		const key = `${edge.teeId} ${edge.badgeId}`;
		edgesByKey.set(key, edge);
		if (!teeAdj.has(edge.teeId)) teeAdj.set(edge.teeId, new Set());
		if (!badgeAdj.has(edge.badgeId)) badgeAdj.set(edge.badgeId, new Set());
		teeAdj.get(edge.teeId)!.add(edge.badgeId);
		badgeAdj.get(edge.badgeId)!.add(edge.teeId);
	}

	const originalTeeNeighbors = new Map<string, Set<string>>();
	const originalBadgeNeighbors = new Map<string, Set<string>>();
	for (const edge of edges) {
		if (!originalTeeNeighbors.has(edge.teeId)) originalTeeNeighbors.set(edge.teeId, new Set());
		if (!originalBadgeNeighbors.has(edge.badgeId)) originalBadgeNeighbors.set(edge.badgeId, new Set());
		originalTeeNeighbors.get(edge.teeId)!.add(edge.badgeId);
		originalBadgeNeighbors.get(edge.badgeId)!.add(edge.teeId);
	}

	const locksByBadgeId = new Map<string, WavePeelLock>();
	const locksByTeeId = new Map<string, WavePeelLock>();

	let wave = 0;
	let forcedAny = true;

	while (forcedAny) {
		forcedAny = false;
		wave++;

		// Find all pairs where tee's edge set = {badge} and no other tee has the same badge as sole option
		const pairsToProcess: Array<{ teeId: string; badgeId: string; angularErrorDeg: number }> = [];
		const badgeToSoleTees = new Map<string, string[]>(); // badge -> list of tees with only this badge

		for (const [teeId, badgeIds] of teeAdj) {
			if (badgeIds.size === 1) {
				const badgeId = [...badgeIds][0]!;
				if (!badgeToSoleTees.has(badgeId)) badgeToSoleTees.set(badgeId, []);
				badgeToSoleTees.get(badgeId)!.push(teeId);
			}
		}

		// Only lock if exactly one tee has this badge as sole option
		for (const [badgeId, teeIds] of badgeToSoleTees) {
			if (teeIds.length === 1) {
				const teeId = teeIds[0]!;
				pairsToProcess.push(edgesByKey.get(`${teeId} ${badgeId}`)!);
			}
		}

		if (pairsToProcess.length === 0) break;

		forcedAny = true;
		pairsToProcess.sort((a, b) => a.teeId.localeCompare(b.teeId) || a.badgeId.localeCompare(b.badgeId));

		for (const pair of pairsToProcess) {
			const teeBadges = teeAdj.get(pair.teeId);
			const badgeTees = badgeAdj.get(pair.badgeId);
			if (!teeBadges?.has(pair.badgeId) || !badgeTees?.has(pair.teeId)) continue;

			const forcedBySet = new Set<string>();
			const teeOriginalBadges = originalTeeNeighbors.get(pair.teeId) || new Set();
			for (const badgeId of teeOriginalBadges) {
				if (badgeId !== pair.badgeId) {
					const locked = locksByBadgeId.get(badgeId);
					if (locked && locked.wave < wave) forcedBySet.add(badgeId);
				}
			}

			const badgeOriginalTees = originalBadgeNeighbors.get(pair.badgeId) || new Set();
			for (const teeId of badgeOriginalTees) {
				if (teeId !== pair.teeId) {
					const locked = locksByTeeId.get(teeId);
					if (locked && locked.wave < wave) forcedBySet.add(locked.badgeId);
				}
			}

			const lock: WavePeelLock = {
				teeId: pair.teeId,
				badgeId: pair.badgeId,
				wave,
				forcedBy: [...forcedBySet].sort()
			};

			locks.push(lock);
			locksByBadgeId.set(pair.badgeId, lock);
			locksByTeeId.set(pair.teeId, lock);

			for (const badgeId of [...teeAdj.get(pair.teeId)!]) {
				edgesByKey.delete(`${pair.teeId} ${badgeId}`);
				teeAdj.get(pair.teeId)!.delete(badgeId);
				badgeAdj.get(badgeId)!.delete(pair.teeId);
			}

			for (const teeId of [...badgeAdj.get(pair.badgeId)!]) {
				edgesByKey.delete(`${teeId} ${pair.badgeId}`);
				teeAdj.get(teeId)!.delete(pair.badgeId);
				badgeAdj.get(pair.badgeId)!.delete(teeId);
			}

			if (teeAdj.get(pair.teeId)!.size === 0) teeAdj.delete(pair.teeId);
			if (badgeAdj.get(pair.badgeId)!.size === 0) badgeAdj.delete(pair.badgeId);
		}
	}

	const remainingTeeIds = new Set(teeAdj.keys());
	const visitedTees = new Set<string>();
	const visitedBadges = new Set<string>();
	const contestedClusters: ContestedCluster[] = [];

	for (const teeId of [...remainingTeeIds].sort()) {
		if (visitedTees.has(teeId)) continue;

		const componentTeeIds = new Set<string>();
		const componentBadgeIds = new Set<string>();
		const queue: { type: 'tee' | 'badge'; id: string }[] = [{ type: 'tee', id: teeId }];

		while (queue.length > 0) {
			const current = queue.shift()!;

			if (current.type === 'tee') {
				if (visitedTees.has(current.id)) continue;
				visitedTees.add(current.id);
				componentTeeIds.add(current.id);

				const neighbors = teeAdj.get(current.id) || new Set();
				for (const badgeId of neighbors) {
					if (!visitedBadges.has(badgeId)) queue.push({ type: 'badge', id: badgeId });
				}
			} else {
				if (visitedBadges.has(current.id)) continue;
				visitedBadges.add(current.id);
				componentBadgeIds.add(current.id);

				const neighbors = badgeAdj.get(current.id) || new Set();
				for (const teeId of neighbors) {
					if (!visitedTees.has(teeId)) queue.push({ type: 'tee', id: teeId });
				}
			}
		}

		const pairs: Array<{
			teeId: string;
			badgeId: string;
			angularErrorDeg: number;
		}> = [];

		for (const edge of edges) {
			if (componentTeeIds.has(edge.teeId) && componentBadgeIds.has(edge.badgeId)) {
				pairs.push(edge);
			}
		}

		if (pairs.length > 0) {
			contestedClusters.push({
				teeIds: [...componentTeeIds].sort(),
				badgeIds: [...componentBadgeIds].sort(),
				pairs: pairs.sort((a, b) => a.teeId.localeCompare(b.teeId) || a.badgeId.localeCompare(b.badgeId))
			});
		}
	}

	locks.sort((a, b) => a.wave - b.wave || a.teeId.localeCompare(b.teeId));

	return {
		locks,
		contestedClusters: contestedClusters.sort((a, b) => a.teeIds[0]?.localeCompare(b.teeIds[0] || '') || 0)
	};
}
