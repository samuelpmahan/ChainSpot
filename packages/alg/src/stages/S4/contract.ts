export interface RecoveredOccludedObject {
	readonly kind: 'tee' | 'basket' | 'badge';
	readonly hole: number;
	readonly xPx: number;
	readonly yPx: number;
	readonly source: string;
}

export const S4PxC = {
	objects: { address: 'px.occludedObjects.recovered' }
} as const;

export const S4Fn = {
	recoverTees: { address: 'fn.OccludedObject.recoverTees' }
} as const;
