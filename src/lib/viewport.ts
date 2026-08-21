export interface ViewportMarker {
	readonly xPx: number;
	readonly yPx: number;
	readonly color: string;
	/** short text inside the chip, e.g. a hole number, "B", "T" */
	readonly label: string;
	readonly title?: string;
	/** 'above' floats the chip above the point so the glyph stays readable */
	readonly anchor?: 'center' | 'above';
}

export interface ViewportLayer {
	readonly objectUrl: string;
	readonly x: number;
	readonly y: number;
	readonly widthPx: number;
	readonly heightPx: number;
	readonly borderColor: string;
	readonly opacity: number;
}
