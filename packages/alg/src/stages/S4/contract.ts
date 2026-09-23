export interface RecoveredTee {
	readonly hole: number;
	readonly xPx: number;
	readonly yPx: number;
	readonly source: string;
}

export const S4PxC = {
	/** Recovery-only testimony: objects S4 added to the visible inventory. */
	recoveredTees: { address: 'px.tees.recovered' },
	/** Canonical post-recovery tee inventory consumed by later stages. */
	tees: { address: 'px.tees.complete' }
} as const;

export const S4Fn = {
	recoverTees: { address: 'fn.Tee.recoverOccluded' },
	completeTees: { address: 'fn.Tee.complete' }
} as const;
