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
	readonly m1: M1WorkbenchLibrary | null;
}

export interface M1WorkbenchComponent {
	readonly id: string;
	readonly polarity: 'bright' | 'dark';
	readonly label: number;
	readonly bbox: readonly [number, number, number, number];
	readonly area: number;
	readonly pixels: readonly number[];
	readonly producedBy: string;
	readonly consumers: readonly {
		readonly objectId: string;
		readonly objectKind: 'badge' | 'basket';
		readonly role: string;
	}[];
}

export interface M1WorkbenchRelationship {
	readonly id: string;
	readonly objectId: string;
	readonly containerComponentId: string;
	readonly memberComponentId: string;
	readonly predicate: string;
	readonly selection: string;
	readonly margins?: readonly [number, number, number, number];
}

export interface M1WorkbenchObject {
	readonly id: string;
	readonly kind: 'badge' | 'basket';
	readonly assemblyStatus: 'assembled' | 'failed';
	readonly componentUses: readonly { readonly componentId: string; readonly role: string }[];
	readonly relationshipIds: readonly string[];
	readonly accounting:
		| {
				readonly status: 'known';
				readonly availablePixels: readonly number[];
				readonly explainedPixels: readonly number[];
				readonly unexplainedPixels: readonly number[];
		  }
		| { readonly status: 'unknown'; readonly reason: string };
}

export interface M1WorkbenchLibrary {
	readonly artifact: { readonly id: string; readonly sha256: string };
	readonly raster: { readonly width: number; readonly height: number; readonly topPx: number };
	readonly components: readonly M1WorkbenchComponent[];
	readonly relationships: readonly M1WorkbenchRelationship[];
	readonly objects: readonly M1WorkbenchObject[];
}
