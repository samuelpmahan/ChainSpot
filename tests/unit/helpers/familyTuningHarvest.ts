// Phase-1 measure-first harvest for the cleanBasketFamily knob-tuning
// investigation (CHSPT-82). Pure functions over an already-produced
// ThreeFactorRun's trace — never re-runs the engine, never mutates
// anything. See tests/unit/familyTuning.test.ts for how this is invoked.
//
// Source of the per-decision testimony: cleanBasketFamilyUnit's
// ctx.overlay('cleanBasketFamily', { type: 'box', ... }) calls
// (src/lib/detectors/threeFactor/features/g2.cleanBasketFamily.ts) already
// emit exactly the values this investigation needs (spriteScore, areaRatio,
// whiteCoverage, darkShell, darkCoherence) tagged accepted/rejected with a
// reason — that's the ABFeature contract's "no silent drops" debuggability
// rule, harvested here rather than re-derived.
//
// Basket tip reconstruction: the overlay's bbox is [sprite.x, sprite.y +
// viewport.topPx, templateWidth, templateHeight] (original-image px, see
// the unit's ctx.overlay call). endpoints.ts's sprite matcher defines
// tipX = x + templateWidth/2 and tipY = y + templateHeight + tipOffset
// (both already in the sprite's own coordinate frame; only Y gets the
// viewport shift downstream, matching measure.ts's basket tip formula).
// So: tipXPx = bbox[0] + templateWidth/2, tipYPx = bbox[1] + templateHeight
// + tipOffset. tipOffset is read from the run's resolved 'sprite' feature
// knobs, not hardcoded, so this stays correct if that knob ever changes.

import type { ThreeFactorRun } from '@chainspot/alg/detectors/threeFactor';
import type { Point } from './sweepRender';

export interface HarvestedDecision {
	readonly course: string;
	readonly accepted: boolean;
	readonly reason: string;
	readonly stage: 'no-component' | 'bad-bbox' | 'metrics';
	readonly spriteScore: number;
	readonly areaRatio: number;
	readonly whiteCoverage: number;
	readonly darkShell: number;
	readonly darkCoherence: number;
	readonly tipXPx: number;
	readonly tipYPx: number;
	readonly isTrue: boolean;
	readonly matchDistPx: number;
	readonly matchedHoleNumber: number | null;
}

function dist(a: Point, b: Point): number {
	return Math.hypot(a.xPx - b.xPx, a.yPx - b.yPx);
}

/**
 * Harvests every cleanBasketFamily decision from `run.trace` and cross-tags
 * each against `truth` (TRUE = within `tolerancePx` of some hole's basket).
 * Throws if the run has no trace or the unit didn't fire — a silent empty
 * array would look like "no decisions" instead of "wrong input".
 */
export function harvestCleanBasketTestimony(
	course: string,
	run: ThreeFactorRun,
	truth: readonly { readonly number: number; readonly basket: Point }[],
	templateWidth: number,
	templateHeight: number,
	tipOffset: number,
	tolerancePx: number
): HarvestedDecision[] {
	const unit = run.trace?.units.find((u) => u.id === 'cleanBasketFamily');
	if (!unit) {
		throw new Error(`familyTuningHarvest: no cleanBasketFamily unit trace for ${course} — was family-on.json used?`);
	}
	if (unit.drawables.length === 0) {
		throw new Error(`familyTuningHarvest: cleanBasketFamily emitted zero decisions for ${course}`);
	}
	return unit.drawables
		.filter((d): d is Extract<typeof d, { type: 'box' }> => d.type === 'box')
		.map((d) => {
			const values = d.values ?? {};
			const tipXPx = d.bbox[0] + templateWidth / 2;
			const tipYPx = d.bbox[1] + templateHeight + tipOffset;
			let best = Infinity;
			let bestHole: number | null = null;
			for (const hole of truth) {
				const dd = dist({ xPx: tipXPx, yPx: tipYPx }, hole.basket);
				if (dd < best) {
					best = dd;
					bestHole = hole.number;
				}
			}
			const reason = d.reason ?? '';
			const stage: HarvestedDecision['stage'] = reason.startsWith('no isolated bright component')
				? 'no-component'
				: reason.includes('bbox')
					? 'bad-bbox'
					: 'metrics';
			return {
				course,
				accepted: d.verdict === 'accepted',
				reason,
				stage,
				spriteScore: values.spriteScore ?? NaN,
				areaRatio: values.areaRatio ?? NaN,
				whiteCoverage: values.whiteCoverage ?? NaN,
				darkShell: values.darkShell ?? NaN,
				darkCoherence: values.darkCoherence ?? NaN,
				tipXPx,
				tipYPx,
				isTrue: best <= tolerancePx,
				matchDistPx: best,
				matchedHoleNumber: bestHole
			};
		});
}

export interface Quartiles {
	readonly n: number;
	readonly min: number;
	readonly q1: number;
	readonly median: number;
	readonly q3: number;
	readonly max: number;
}

function percentile(sorted: readonly number[], p: number): number {
	if (sorted.length === 0) return NaN;
	const idx = (sorted.length - 1) * p;
	const lo = Math.floor(idx);
	const hi = Math.ceil(idx);
	if (lo === hi) return sorted[lo];
	return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export function quartiles(values: readonly number[]): Quartiles {
	const finite = values.filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b);
	return {
		n: finite.length,
		min: percentile(finite, 0),
		q1: percentile(finite, 0.25),
		median: percentile(finite, 0.5),
		q3: percentile(finite, 0.75),
		max: percentile(finite, 1)
	};
}
