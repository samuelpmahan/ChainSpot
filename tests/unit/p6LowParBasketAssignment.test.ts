import { describe, expect, it } from 'vitest';
import { forwardGateForBasket } from '../../src/lib/autoAnnotation/p6LowParBasketAssignment';
import type { RawMaskBasket } from '../../src/lib/autoAnnotation/rawObjectMask';

/**
 * `rawObjectMask.ts` gives a basket two different Y references: `yPx`
 * (bbox bottom / `maxY`) and `centerYPx` (bbox center) -- ~33px apart on the
 * fixed 42x66 sprite (half-height). The gate must score the same point the
 * caller's LowPar ranking score used (bbox center), not `basket.xPx/yPx`.
 */
describe('forwardGateForBasket', () => {
	const tee = { xPx: 0, yPx: 0 };
	const badge = { xPx: 100, yPx: 0 };
	// Mirrors what rawObjectMask.ts actually produces: xPx/centerXPx share the
	// bbox-center X, but yPx is the bbox BOTTOM (centerYPx + sprite half-height).
	const basket: RawMaskBasket = {
		xPx: 105,
		yPx: 33,
		centerXPx: 105,
		centerYPx: 0,
		widthPx: 42,
		heightPx: 66,
		areaPx: 1746,
		fill: 0.63
	};

	it('scored at bbox-center (the fixed call site) passes: the candidate sits dead ahead', () => {
		const result = forwardGateForBasket(tee, badge, { xPx: basket.centerXPx, yPx: basket.centerYPx });
		expect(result.forwardAngleDeg).toBeCloseTo(0, 5);
		expect(result.passedForwardGate).toBe(true);
	});

	it('the SAME candidate scored at bbox-bottom (the old call site) fails the 80deg gate', () => {
		const result = forwardGateForBasket(tee, badge, { xPx: basket.xPx, yPx: basket.yPx });
		expect(result.forwardAngleDeg).toBeGreaterThan(80);
		expect(result.passedForwardGate).toBe(false);
	});
});
