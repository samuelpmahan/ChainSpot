export interface BadgeSpecimen {
	readonly id: string;
	readonly title: string;
	readonly course: string;
	readonly detectorId: string;
	readonly holeLabel: string | null;
	readonly sourceSha256: string;
	readonly crop: {
		readonly x: number;
		readonly y: number;
		readonly width: number;
		readonly height: number;
	};
	readonly sourceRgba: readonly number[];
	readonly brightMask: readonly number[];
	readonly darkMask: readonly number[];
	readonly ownedMask: readonly number[];
	readonly aaMask: readonly number[];
	readonly residueBeforeMask: readonly number[];
	readonly residueAfterMask: readonly number[];
	readonly metrics: {
		readonly ownedBw: number;
		readonly aaAdded: number;
		readonly residueBefore: number;
		readonly residueAfter: number;
	};
	readonly provenance: readonly string[];
}

export interface BadgeSpecimenLibrary {
	readonly status: 'materialized' | 'unavailable';
	readonly note: string;
	readonly source: string;
	readonly specimens: readonly BadgeSpecimen[];
}
