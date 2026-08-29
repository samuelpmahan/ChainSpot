/**
 * G4 teeBorderCornerFit: an opt-in recovery candidate for tees buried under
 * basket glyphs, anchored to the wall remnant that pokes out past the glyph's
 * black border.
 *
 * Owner directives (2026-08-29): "Make recovery search for ANY white
 * component connected to the baskets black border for tee recovery
 * candidates." / "the crumbs arent part of it. that 21 px CORNER should
 * work. MANUALLY MAKE IT RUN THROUGH AND CHECK." The manual run is receipted
 * in g4.teeBorderCornerFitMath.ts's header: Heritage T6 recovered to 1.0px
 * from its truth annotation from the 21px corner alone.
 *
 * Reads exactly one board slot (`measurement`) -- baskets, badges, visible
 * tees, and both masks all live there -- and runs BEFORE assignment and
 * teeRecovery in its on.json, so nothing downstream is read. Emits
 * TeeBadgeClaims (per the 2026-08-29 gate-reorg contract: G4 output is a
 * unique claim or a NAMED abstention) on its own board slot; it does not
 * inject tees into the baseline recovery path. Composition with the rail
 * lane happens in staging, by config, never by editing a shared file.
 *
 * File layout mirrors g4.teeBadgeCompass.ts exactly (feature + Math +
 * Receipt modules, registry entry, gate-sets ownership, default-OFF
 * deviation).
 */

import type { ABFeatureOperation } from '../../../exec/feature-set';
import type { OperationArtifact } from '../../../exec/gateway';
import type { ExecBoard } from '../../../exec/board';
import { extractComponents } from '../components';
import { resolveVisibleTeeBadgeRays } from './g3.teeRecovery';
import type { ThreeFactorMeasurement } from '../types';
import type { ABFeature, EngineUnit, EvidenceBoard, FeatureContext } from './types';
import {
	runBorderCornerFit,
	type BorderCornerAbstention,
	type BorderCornerClaim,
	type BorderCornerFitResult,
	type BorderExcludedCandidate,
	type BorderFitBadge,
	type BorderFitBasket,
	type BorderFitKnobs,
	type BorderFitMasks,
	type BorderFitVisiblePad
} from './g4.teeBorderCornerFitMath';
import { TEE_BORDER_CORNER_FIT_RENDER } from './g4.teeBorderCornerFitReceipt';

const DEG = 180 / Math.PI;

function finite(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function positiveIntegerKnob(name: string): (value: unknown) => string | null {
	return (value: unknown) =>
		typeof value === 'number' && Number.isInteger(value) && value >= 1
			? null
			: `${name} must be a positive integer`;
}

function nonNegativeIntegerKnob(name: string): (value: unknown) => string | null {
	return (value: unknown) =>
		typeof value === 'number' && Number.isInteger(value) && value >= 0
			? null
			: `${name} must be a non-negative integer`;
}

function positiveNumberKnob(name: string): (value: unknown) => string | null {
	return (value: unknown) =>
		typeof value === 'number' && Number.isFinite(value) && value > 0
			? null
			: `${name} must be a positive number`;
}

/** Default-OFF G4 deviation. Every threshold is course-derived or a raster
 * quantization allowance -- never a course-distance literal (footgun law). */
export const teeBorderCornerFitFeature = {
	id: 'teeBorderCornerFit',
	gate: 'G4',
	kind: 'deviation',
	defaultEnabled: false,
	resolveOnlyWhenConfigured: true,
	note:
		'border-adjacency tee recovery: any unowned white component glued to a basket\'s black ' +
		'border anchors an axis-aligned corner/wall fit of the COURSE-MEASURED pad. The basket ' +
		'glyph\'s white fill is the named occluder and never pad evidence. Zero angular freedom, ' +
		'one integer slide; a placement with any bare outline pixel is never accepted, and every ' +
		'non-claim is a NAMED abstention. Orientation ties are broken by badge aim (S2: the tee ' +
		'is the compass), restricted to badges NO visible tee can serve -- computed tee-locally ' +
		'via resolveVisibleTeeBadgeRays, the same measurement-only eligibility contract ' +
		'teeRecovery states. Reads only `measurement`; runs before assignment/teeRecovery.',
	render: TEE_BORDER_CORNER_FIT_RENDER,
	knobs: {
		minimumPadSampleSize: {
			default: 3,
			note:
				'below this many visible pads, the course pad size is not trusted at all -- the whole ' +
				'feature abstains loudly (course-pad-dims-unknown), never guesses a size.',
			validate: positiveIntegerKnob('minimumPadSampleSize')
		},
		borderMarginPx: {
			default: 2,
			note:
				'dark-ink adjacency margin around a basket\'s semantic bbox, in source pixels -- a raster ' +
				'allowance bounding where "the basket\'s black border" is looked for, never a course distance.',
			validate: nonNegativeIntegerKnob('borderMarginPx')
		},
		haloPx: {
			default: 1,
			note:
				'anti-alias halo: a pixel within this chebyshev distance of basket ink/fill classifies as ' +
				'a soft transition instead of a bare contradiction -- the same raster-quantization ' +
				'allowance class as rasterTolerancePx elsewhere.',
			validate: nonNegativeIntegerKnob('haloPx')
		},
		candidateAreaCapFactor: {
			default: 1.25,
			note:
				'candidate area cap relative to THIS course\'s own pad area (long*short medians) -- the ' +
				'familiar 1.25 tolerance-factor convention; a component bigger than a whole pad cannot ' +
				'be a pad remnant.',
			validate: positiveNumberKnob('candidateAreaCapFactor')
		},
		evidenceFloorFactor: {
			default: 0.5,
			note:
				'minimum remnant evidence relative to one short wall run (wallPx*shortPx, both ' +
				'course-derived): below it an anti-alias speck could claim a fully-occluded placement ' +
				'with near-zero evidence. Excluded remnants are listed by name, never dropped.',
			validate: positiveNumberKnob('evidenceFloorFactor')
		},
		axisOrthogonalToleranceDeg: {
			default: 10,
			note:
				'PCA of a tiny border remnant is quantization-coarse; within this many degrees of an ' +
				'image axis the remnant is treated as axis-aligned. A statistical parameter on ' +
				'small-component PCA stability, not physics -- non-orthogonal remnants are loudly ' +
				'abstained (rotated rails are a sibling lane), never guessed at.',
			validate: positiveNumberKnob('axisOrthogonalToleranceDeg')
		}
	}
} satisfies ABFeature;

function knobsFrom(ctx: FeatureContext): BorderFitKnobs {
	const state = ctx.resolve(teeBorderCornerFitFeature).knobs as Record<string, unknown>;
	const {
		minimumPadSampleSize,
		borderMarginPx,
		haloPx,
		candidateAreaCapFactor,
		evidenceFloorFactor,
		axisOrthogonalToleranceDeg
	} = state;
	if (
		!finite(minimumPadSampleSize) ||
		!finite(borderMarginPx) ||
		!finite(haloPx) ||
		!finite(candidateAreaCapFactor) ||
		!finite(evidenceFloorFactor) ||
		!finite(axisOrthogonalToleranceDeg)
	) {
		throw new Error('teeBorderCornerFit: resolved knobs must all be finite numbers.');
	}
	return {
		minimumPadSampleSize,
		borderMarginPx,
		haloPx,
		candidateAreaCapFactor,
		evidenceFloorFactor,
		axisOrthogonalToleranceDeg
	};
}

export interface TeeBorderCornerFitEvidence {
	readonly enabled: boolean;
	readonly padDims: BorderCornerFitResult['padDims'];
	readonly basketsScanned: number;
	readonly candidatesConsidered: number;
	/** Claims in ORIGINAL-image coordinates (viewport top re-applied). */
	readonly claims: readonly BorderCornerClaim[];
	readonly abstentions: readonly BorderCornerAbstention[];
	readonly excluded: readonly BorderExcludedCandidate[];
	readonly glyphFillLabels: readonly (readonly [string, number | null])[];
	readonly aimEligibility: BorderCornerFitResult['aimEligibility'];
	readonly coordinateFrame: 'original-image';
	readonly provenance: string;
}

function emptyEvidence(): TeeBorderCornerFitEvidence {
	return {
		enabled: false,
		padDims: {
			longPx: NaN,
			shortPx: NaN,
			wallPx: NaN,
			sampleSize: 0,
			minimumPadSampleSize: NaN,
			isFallback: true,
			provenance: 'teeBorderCornerFit feature is OFF; nothing was computed.'
		},
		basketsScanned: 0,
		candidatesConsidered: 0,
		claims: [],
		abstentions: [],
		excluded: [],
		glyphFillLabels: [],
		aimEligibility: { badgesOnBoard: 0, coveredBadgeIds: [], eligibleBadgeIds: [] },
		coordinateFrame: 'original-image',
		provenance: 'teeBorderCornerFit feature is OFF; nothing was computed.'
	};
}

function toOriginalFrame(result: BorderCornerFitResult, topPx: number): BorderCornerFitResult {
	return {
		...result,
		claims: result.claims.map((claim) => ({
			...claim,
			teeYPx: claim.teeYPx + topPx,
			componentBbox: [
				claim.componentBbox[0],
				claim.componentBbox[1] + topPx,
				claim.componentBbox[2],
				claim.componentBbox[3]
			] as const,
			placement: {
				...claim.placement,
				y0: claim.placement.y0 + topPx,
				centerYPx: claim.placement.centerYPx + topPx
			}
		}))
	};
}

function emitDrawables(ctx: FeatureContext, evidence: TeeBorderCornerFitEvidence): void {
	const dims = evidence.padDims;
	const dimValues: Record<string, number> = {
		sampleSize: dims.sampleSize,
		minimumPadSampleSize: dims.minimumPadSampleSize
	};
	if (Number.isFinite(dims.longPx)) dimValues.longPx = dims.longPx;
	if (Number.isFinite(dims.shortPx)) dimValues.shortPx = dims.shortPx;
	if (Number.isFinite(dims.wallPx)) dimValues.wallPx = dims.wallPx;
	ctx.overlay('teeBorderCornerFit', {
		type: 'point',
		xPx: 0,
		yPx: 0,
		verdict: 'info',
		ref: 'teeBorderCornerFit:pad-dims',
		reason: dims.provenance,
		values: dimValues,
		metadata: { role: 'pad-dims', isFallback: String(dims.isFallback) }
	});

	ctx.overlay('teeBorderCornerFit', {
		type: 'point',
		xPx: 0,
		yPx: 0,
		verdict: 'info',
		ref: 'teeBorderCornerFit:aim-eligibility',
		reason:
			`claims may aim only at badges unserved by possible visible-tee testimony ` +
			`(resolveVisibleTeeBadgeRays, measurement-only): eligible ` +
			`[${evidence.aimEligibility.eligibleBadgeIds.join(', ') || 'none'}]; covered ` +
			`[${evidence.aimEligibility.coveredBadgeIds.join(', ') || 'none'}]`,
		values: {
			badgesOnBoard: evidence.aimEligibility.badgesOnBoard,
			coveredBadges: evidence.aimEligibility.coveredBadgeIds.length,
			eligibleBadges: evidence.aimEligibility.eligibleBadgeIds.length
		},
		metadata: { role: 'aim-eligibility' }
	});

	for (const claim of evidence.claims) {
		const { placement } = claim;
		const x0 = placement.x0;
		const y0 = placement.y0;
		const x1 = placement.x0 + placement.w - 1;
		const y1 = placement.y0 + placement.h - 1;
		ctx.overlay('teeBorderCornerFit', {
			type: 'polyline',
			path: [
				[x0, y0],
				[x1, y0],
				[x1, y1],
				[x0, y1],
				[x0, y0]
			],
			verdict: 'accepted',
			visualRole: 'tee-badge-path',
			ref: `teeBorderCornerFit:claim:${claim.componentLabel}`,
			reason:
				`pad anchored to border remnant ${claim.componentLabel} ` +
				`(${claim.componentArea}px, anchor basket(s) ${claim.anchorBasketIds.join('+')}); ` +
				`outline ${placement.evidencePx} evidence + ${placement.occludedPx} basket-occluded + ` +
				`${placement.transitionPx} transition + ${placement.barePx} bare of ${placement.outlinePx}; ` +
				`aims at ${claim.aimBadgeId} (label ${claim.aimBadgeLabel ?? 'UNREAD'}) ` +
				`err ${claim.aimErrorDeg.toFixed(2)}deg` +
				(claim.aimResolved
					? ''
					: `; AIM UNRESOLVED: runner-up ${claim.aimRunnerUpBadgeId} gap ` +
						`${claim.aimRunnerUpGapDeg?.toFixed(2)}deg under the axis-quantization bound ` +
						`${claim.aimResolutionBoundDeg.toFixed(2)}deg (atan(1px/padLong)) -- the tee stands, ` +
						'the badge identity does not'),
			values: {
				componentArea: claim.componentArea,
				padX0: placement.x0,
				padY0: placement.y0,
				padW: placement.w,
				padH: placement.h,
				teeXPx: claim.teeXPx,
				teeYPx: claim.teeYPx,
				axisDeg: claim.angleRad * DEG,
				aimErrorDeg: claim.aimErrorDeg,
				aimResolutionBoundDeg: claim.aimResolutionBoundDeg,
				...(claim.aimRunnerUpGapDeg !== null ? { aimRunnerUpGapDeg: claim.aimRunnerUpGapDeg } : {}),
				evidencePx: placement.evidencePx,
				occludedPx: placement.occludedPx,
				transitionPx: placement.transitionPx,
				barePx: placement.barePx,
				outlinePx: placement.outlinePx,
				remnantOnOutlinePx: placement.candidateOnOutlinePx,
				remnantWallAdjacentPx: placement.candidateWallAdjacentPx
			},
			metadata: {
				role: 'border-claim',
				componentLabel: String(claim.componentLabel),
				anchorBasketIds: claim.anchorBasketIds.join('+'),
				aimBadgeId: claim.aimBadgeId,
				aimBadgeLabel: claim.aimBadgeLabel ?? 'UNREAD',
				aimResolved: String(claim.aimResolved),
				aimRunnerUpBadgeId: claim.aimRunnerUpBadgeId ?? 'none'
			}
		});
	}

	for (const [index, abstention] of evidence.abstentions.entries()) {
		ctx.overlay('teeBorderCornerFit', {
			type: 'point',
			xPx: 0,
			yPx: 0,
			verdict: 'rejected',
			visualRole: 'tee-badge-abstention',
			ref: `teeBorderCornerFit:abstain:${abstention.componentLabel ?? 'course'}:${index}`,
			reason: abstention.detail,
			metadata: {
				role: 'border-abstention',
				componentLabel: abstention.componentLabel === null ? 'n/a' : String(abstention.componentLabel),
				anchorBasketIds: abstention.anchorBasketIds.join('+') || 'n/a',
				why: abstention.reason
			}
		});
	}

	for (const excluded of evidence.excluded) {
		ctx.overlay('teeBorderCornerFit', {
			type: 'point',
			xPx: 0,
			yPx: 0,
			verdict: 'rejected',
			visualRole: 'tee-rejection',
			ref: `teeBorderCornerFit:excluded:${excluded.componentLabel}`,
			reason: excluded.detail,
			metadata: {
				role: 'border-excluded',
				componentLabel: String(excluded.componentLabel),
				anchorBasketIds: excluded.anchorBasketIds.join('+'),
				why: excluded.reason
			}
		});
	}
}

function executeTeeBorderCornerFit(
	board: ExecBoard,
	ctx: FeatureContext,
	measurement: ThreeFactorMeasurement
): void {
	const stop = ctx.span('teeBorderCornerFit');
	const state = ctx.resolve(teeBorderCornerFitFeature);

	let evidence: TeeBorderCornerFitEvidence;
	if (!state.enabled) {
		evidence = emptyEvidence();
	} else {
		const knobs = knobsFrom(ctx);
		const topPx = measurement.viewport.topPx;
		const extracted = extractComponents(measurement.brightMask);
		const masks: BorderFitMasks = {
			width: measurement.brightMask.width,
			height: measurement.brightMask.height,
			bright: measurement.brightMask.data,
			dark: measurement.darkMask.data,
			brightLabels: extracted.labels
		};
		const components = extracted.components;
		const baskets: BorderFitBasket[] = measurement.baskets.map((basket) => ({
			detId: basket.detId,
			bboxLocal: [basket.bbox[0], basket.bbox[1] - topPx, basket.bbox[2], basket.bbox[3]] as const,
			whiteBboxLocal: [
				basket.whiteBbox[0],
				basket.whiteBbox[1] - topPx,
				basket.whiteBbox[2],
				basket.whiteBbox[3]
			] as const,
			centerXLocalPx: basket.centerXPx,
			centerYLocalPx: basket.centerYPx - topPx
		}));
		const badges: BorderFitBadge[] = measurement.badges.map((badge) => ({
			detId: badge.detId,
			label: badge.label,
			cxLocalPx: badge.cxPx,
			cyLocalPx: badge.cyPx - topPx
		}));
		const visiblePads: BorderFitVisiblePad[] = measurement.tees
			.filter((tee) => tee.tier !== 'recovered' && tee.pad !== undefined)
			.map((tee) => ({
				teeId: tee.detId,
				componentLabel: tee.pad!.componentLabel,
				majorPx: tee.pad!.majorPx,
				minorPx: tee.pad!.minorPx,
				areaPx: tee.pad!.area
			}));
		// The same measurement-only eligibility contract teeRecovery states:
		// only a badge absent from POSSIBLE visible-tee testimony is eligible
		// for a recovery claim to aim at.
		const visibleRays = resolveVisibleTeeBadgeRays(measurement.tees, measurement.badges);
		const localResult = runBorderCornerFit(
			masks,
			components,
			baskets,
			badges,
			visiblePads,
			knobs,
			visibleRays.coveredBadgeIds
		);
		const result = toOriginalFrame(localResult, topPx);
		evidence = {
			enabled: true,
			padDims: result.padDims,
			basketsScanned: result.basketsScanned,
			candidatesConsidered: result.candidatesConsidered,
			claims: result.claims,
			abstentions: result.abstentions,
			excluded: result.excluded,
			glyphFillLabels: result.glyphFillLabels,
			aimEligibility: result.aimEligibility,
			coordinateFrame: 'original-image',
			provenance:
				`pad dims: ${result.padDims.provenance} | discovery: unowned bright components ` +
				`8-adjacent to basket ink within borderMarginPx=${knobs.borderMarginPx} of a basket bbox; ` +
				'basket glyph white fills excluded by component label | aim eligibility: ' +
				`${result.aimEligibility.eligibleBadgeIds.length} of ${result.aimEligibility.badgesOnBoard} ` +
				'badges unserved by possible visible-tee testimony (resolveVisibleTeeBadgeRays, measurement-only).'
		};
	}

	if (state.enabled) emitDrawables(ctx, evidence);

	ctx.measure('teeBorderCornerFit', 'basketsScanned', evidence.basketsScanned);
	ctx.measure('teeBorderCornerFit', 'candidatesConsidered', evidence.candidatesConsidered);
	ctx.measure('teeBorderCornerFit', 'claims', evidence.claims.length);
	ctx.measure('teeBorderCornerFit', 'abstentions', evidence.abstentions.length);
	ctx.measure('teeBorderCornerFit', 'excluded', evidence.excluded.length);
	board.set('teeBorderCornerFit', evidence);
	stop();
}

function measurementTable(board: ExecBoard): readonly OperationArtifact[] {
	const evidence = board.get<TeeBorderCornerFitEvidence>('teeBorderCornerFit');
	return [
		{
			kind: 'measurementTable',
			id: 'teeBorderCornerFit.evidence',
			bytes: new TextEncoder().encode(JSON.stringify(evidence))
		}
	];
}

/** Legacy engine descriptor used by the chronology seam / schema generation.
 * Production ABFeature sets use teeBorderCornerFitOperation below. */
export const teeBorderCornerFitUnit: EngineUnit = {
	id: 'teeBorderCornerFit',
	gate: 'G4',
	consumes: ['measurement'],
	produces: ['teeBorderCornerFit'],
	note:
		'border-adjacency corner-fit tee recovery candidate; production custody is owned by ' +
		'teeBorderCornerFitOperation',
	run(board: EvidenceBoard, ctx: FeatureContext) {
		const measurement = board.get<ThreeFactorMeasurement>('measurement');
		executeTeeBorderCornerFit(board as unknown as ExecBoard, ctx, measurement);
	}
};

/** Semantic-set operation. Reads only `measurement`, including while OFF, so
 * the gateway receipt can prove OFF custody rather than hiding a missing
 * dependency. Writes only `teeBorderCornerFit`. */
export const teeBorderCornerFitOperation: ABFeatureOperation = {
	spec: {
		id: 'teeBorderCornerFit',
		kind: 'decide',
		gate: 'G4',
		unit: 'teeBorderCornerFit',
		consumes: ['measurement'],
		produces: ['teeBorderCornerFit'],
		features: ['teeBorderCornerFit'],
		note:
			'border-adjacency corner fit: unowned white components glued to basket ink anchor the ' +
			'course-median pad with zero angular freedom; glyph white fill is the named occluder, ' +
			'contradictions forbid acceptance, non-claims are named abstentions'
	},
	run(board, ctx) {
		const measurement = board.get<ThreeFactorMeasurement>('measurement');
		executeTeeBorderCornerFit(board, ctx, measurement);
	},
	extractArtifacts: measurementTable
};
