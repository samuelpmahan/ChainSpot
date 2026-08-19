export interface ViewportCropResult {
	readonly bytes: Buffer;
	readonly viewport: {
		readonly detectedTop: number;
		readonly detectedBottom: number;
		readonly appliedTop: number;
		readonly appliedBottom: number;
	};
}

export interface ProductionAutoViewportParameters {
	readonly strategy: 'production-auto';
	readonly topAdjustmentPx: number;
	readonly bottomAdjustmentPx: number;
}

export interface ExplicitInsetsViewportParameters {
	readonly strategy: 'explicit-insets';
	readonly topInsetPx: number;
	readonly bottomInsetPx: number;
}

export type ViewportCropParameters =
	| ProductionAutoViewportParameters
	| ExplicitInsetsViewportParameters;
