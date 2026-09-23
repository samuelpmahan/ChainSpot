export interface RecoveredObject {
	readonly hole: number;
	readonly xPx: number;
	readonly yPx: number;
	readonly source: string;
}

export type RecoveredBadge = RecoveredObject;
export interface RecoveredBasket {
	readonly bbox: readonly [number, number, number, number];
	readonly score: number;
	readonly trustedFraction: number;
	readonly source: 'masked-course-template';
}
export type RecoveredTee = RecoveredObject;

export const S4PxC = {
	recoveredBadges: { address: 'px.badges.recovered' },
	recoveredBaskets: { address: 'px.baskets.recovered' },
	recoveredTees: { address: 'px.tees.recovered' },
	badges: { address: 'px.badges.complete' },
	baskets: { address: 'px.baskets.complete' },
	tees: { address: 'px.tees.complete' }
} as const;

export const S4Fn = {
	recoverBadges: { address: 'fn.Badge.recoverOccluded' },
	recoverBaskets: { address: 'fn.Basket.recoverOccluded' },
	recoverTees: { address: 'fn.Tee.recoverOccluded' },
	completeBadges: { address: 'fn.Badge.complete' },
	completeBaskets: { address: 'fn.Basket.complete' },
	completeTees: { address: 'fn.Tee.complete' }
} as const;
