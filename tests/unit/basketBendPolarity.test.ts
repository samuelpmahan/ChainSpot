/**
 * Deferred, not wired into the live pipeline -- see
 * docs/deferred-detection-experiments.md and this module's own doc comment
 * for why. These tests exist so the logic stays correct and ready to wire
 * in later, even while unused.
 */
import { describe, expect, it } from 'vitest';
import {
	BEND_TOWARD_NEXT_TEE_DISCOUNT,
	bendAwarePolarityPenaltyPx,
	isBendDiscountEligible,
	sideOfLine
} from '../../src/lib/autoAnnotation/basketBendPolarity';

const badge = { xPx: 100, yPx: 100 };
const tee = { xPx: 100, yPx: 0 }; // straight up from badge

describe('sideOfLine', () => {
	it('gives opposite signs for points on opposite sides of the badge->ref line', () => {
		const left = { xPx: 50, yPx: 150 };
		const right = { xPx: 150, yPx: 150 };
		expect(Math.sign(sideOfLine(badge, tee, left))).toBe(-Math.sign(sideOfLine(badge, tee, right)));
	});
});

describe('isBendDiscountEligible', () => {
	it('is eligible when nothing nearby fits the straight model', () => {
		const bentBasket = { xPx: 250, yPx: 150 }; // far from opposite-of-tee
		expect(isBendDiscountEligible(badge, tee, [bentBasket])).toBe(true);
	});

	it('is not eligible when a nearby candidate already fits straight well', () => {
		const straightBasket = { xPx: 100, yPx: 200 }; // dead opposite of tee across badge
		expect(isBendDiscountEligible(badge, tee, [straightBasket])).toBe(false);
	});

	it('is eligible with no nearby candidates supplied', () => {
		expect(isBendDiscountEligible(badge, tee, [])).toBe(true);
	});
});

describe('bendAwarePolarityPenaltyPx', () => {
	it('returns the plain penalty when no next tee is supplied', () => {
		const basket = { xPx: 250, yPx: 150 };
		expect(bendAwarePolarityPenaltyPx(badge, tee, basket, 80)).toBe(80);
	});

	it('discounts the penalty when the basket bends toward the next tee', () => {
		const nextTee = { xPx: 250, yPx: 50 }; // on the +x side of the badge->tee line
		const basketSameSide = { xPx: 250, yPx: 150 }; // also +x side
		expect(bendAwarePolarityPenaltyPx(badge, tee, basketSameSide, 80, nextTee)).toBeCloseTo(
			80 * BEND_TOWARD_NEXT_TEE_DISCOUNT
		);
	});

	it('does not discount when the basket bends away from the next tee', () => {
		const nextTee = { xPx: 250, yPx: 50 }; // +x side
		const basketOppositeSide = { xPx: -50, yPx: 150 }; // -x side
		expect(bendAwarePolarityPenaltyPx(badge, tee, basketOppositeSide, 80, nextTee)).toBe(80);
	});

	it('does not discount a basket that is exactly opposite the tee (straight hole, no side)', () => {
		const nextTee = { xPx: 250, yPx: 50 };
		const straightBasket = { xPx: 100, yPx: 200 };
		expect(bendAwarePolarityPenaltyPx(badge, tee, straightBasket, 80, nextTee)).toBe(80);
	});
});
