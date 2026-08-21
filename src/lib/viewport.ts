export interface ViewportMarker {
	readonly xPx: number;
	readonly yPx: number;
	readonly color: string;
	/** short text inside the chip, e.g. a hole number, "B", "T" */
	readonly label: string;
	readonly title?: string;
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
