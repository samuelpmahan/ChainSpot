/**
 * Semantic-pose-assisted OpenCV verification (CHSPT-78).
 *
 * A semantic pose is a SEARCH HINT, never stitch truth.  The hint buys one
 * cheap, full-resolution local `matchTemplate` pass by reusing
 * `cvMatch.ts`'s proven `matchTranslationNear`.  If that local evidence does
 * not clear the caller's score bar, the caller's existing global pair search
 * runs unchanged.  Keeping the fallback as an injected callback is
 * deliberate: `poseGraph.ts` owns the robust unordered-pair search (both
 * directions x both orientations), and this module must not clone it.
 *
 * CHSPT-75/76 can eventually provide real seeds.  Until then the contract is
 * intentionally fixture/injection friendly so this work is independently
 * testable.
 */
import { matchTranslationNear } from './cvMatch';
import type { TranslationMatch } from './cvMatch';
import type { AnalysisRaster, PairOrientation } from './analysis';

export const DEFAULT_SEMANTIC_VERIFY_RADIUS_PX = 48;
export const DEFAULT_SEMANTIC_VERIFY_MIN_SCORE = 0.85;

export interface SemanticPoseSeed {
	/** `bIndex` is predicted relative to `aIndex`, matching cvMatch's a/b convention. */
	readonly aIndex: number;
	readonly bIndex: number;
	readonly orientation: PairOrientation;
	readonly dxPx: number;
	readonly dyPx: number;
	/** Optional upstream confidence for diagnostics only; it never overrides CV evidence. */
	readonly confidence?: number;
	/** Optional upstream identifier so diagnostics can be joined to semantic-provider traces. */
	readonly seedId?: string;
}

export type SemanticVerificationPath = 'semantic-local' | 'opencv-global-fallback';

export interface SemanticVerificationTiming {
	readonly localVerifyMs: number;
	readonly fallbackMs: number;
	readonly totalMs: number;
}

export type SemanticVerificationResult<TFallback> =
	| {
			readonly path: 'semantic-local';
			readonly seed: SemanticPoseSeed;
			readonly match: TranslationMatch;
			readonly timing: SemanticVerificationTiming;
	  }
	| {
			readonly path: 'opencv-global-fallback';
			readonly seed: SemanticPoseSeed;
			/** Weak local evidence is retained for observability, never silently discarded. */
			readonly localMatch: TranslationMatch;
			readonly fallback: TFallback;
			readonly timing: SemanticVerificationTiming;
	  };

export type SemanticNearMatcher = (
	a: AnalysisRaster,
	b: AnalysisRaster,
	orientation: PairOrientation,
	startDxPx: number,
	startDyPx: number,
	radiusPx: number
) => Promise<TranslationMatch>;

export interface SemanticVerificationOptions {
	readonly radiusPx?: number;
	readonly minScore?: number;
	readonly matchNear?: SemanticNearMatcher;
	readonly now?: () => number;
}

function assertSeedIndexes(rasters: readonly AnalysisRaster[], seed: SemanticPoseSeed): void {
	if (!Number.isInteger(seed.aIndex) || !Number.isInteger(seed.bIndex)) {
		throw new Error('verifySemanticPoseSeed: seed indexes must be integers');
	}
	if (seed.aIndex === seed.bIndex) {
		throw new Error('verifySemanticPoseSeed: a semantic pair must name two different rasters');
	}
	if (seed.aIndex < 0 || seed.bIndex < 0 || seed.aIndex >= rasters.length || seed.bIndex >= rasters.length) {
		throw new Error(
			`verifySemanticPoseSeed: pair ${seed.aIndex}:${seed.bIndex} is outside a ${rasters.length}-raster batch`
		);
	}
}

/**
 * Verifies one directed semantic pose locally, then invokes `globalFallback`
 * only when the local NCC evidence is weak.  `globalFallback` should be the
 * pre-existing robust pair search owned by the caller (for `poseGraph.ts`,
 * the unordered pair's both-directions/both-orientations coarse search).
 */
export async function verifySemanticPoseSeed<TFallback>(
	rasters: readonly AnalysisRaster[],
	seed: SemanticPoseSeed,
	globalFallback: () => Promise<TFallback>,
	options: SemanticVerificationOptions = {}
): Promise<SemanticVerificationResult<TFallback>> {
	assertSeedIndexes(rasters, seed);
	const radiusPx = options.radiusPx ?? DEFAULT_SEMANTIC_VERIFY_RADIUS_PX;
	const minScore = options.minScore ?? DEFAULT_SEMANTIC_VERIFY_MIN_SCORE;
	const near = options.matchNear ?? matchTranslationNear;
	const now = options.now ?? (() => performance.now());
	if (!Number.isFinite(radiusPx) || radiusPx <= 0) {
		throw new Error(`verifySemanticPoseSeed: radiusPx must be > 0, got ${radiusPx}`);
	}
	if (!Number.isFinite(minScore) || minScore < -1 || minScore > 1) {
		throw new Error(`verifySemanticPoseSeed: minScore must be in [-1, 1], got ${minScore}`);
	}

	const startedAt = now();
	const localStartedAt = startedAt;
	const localMatch = await near(
		rasters[seed.aIndex],
		rasters[seed.bIndex],
		seed.orientation,
		seed.dxPx,
		seed.dyPx,
		radiusPx
	);
	const localFinishedAt = now();
	if (localMatch.score >= minScore) {
		return {
			path: 'semantic-local',
			seed,
			match: localMatch,
			timing: {
				localVerifyMs: localFinishedAt - localStartedAt,
				fallbackMs: 0,
				totalMs: localFinishedAt - startedAt
			}
		};
	}

	const fallbackStartedAt = now();
	const fallback = await globalFallback();
	const finishedAt = now();
	return {
		path: 'opencv-global-fallback',
		seed,
		localMatch,
		fallback,
		timing: {
			localVerifyMs: localFinishedAt - localStartedAt,
			fallbackMs: finishedAt - fallbackStartedAt,
			totalMs: finishedAt - startedAt
		}
	};
}
