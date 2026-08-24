export type PointTuple = readonly [number, number];
export type BoxTuple = readonly [number, number, number, number];
export type ScopePinStyle = 'ring-dot' | 'crosshair' | 'diamond';

export interface ScopeViewOptions {
	/** Canonical source span for the regional Context crop. */
	readonly contextSpanPx: number;
	readonly contextOutputPx: number;
	/** Extra canonical pixels added to the active request's total width/height for Local. */
	readonly localExtraWidthPx: number;
	readonly localExtraHeightPx: number;
	readonly localOutputPx: number;
	readonly forensicWidePx: number;
	readonly forensicMidPx: number;
	readonly forensicTightPx: number;
	readonly forensicOutputPx: number;
	readonly grid: boolean;
}

export interface ScopeRequest {
	readonly name?: string;
	readonly point?: PointTuple;
	readonly box?: BoxTuple;
	readonly mark?: PointTuple;
	readonly dots?: readonly PointTuple[];
	readonly path?: readonly PointTuple[];
	readonly hole?: number;
	readonly template?: string;
	readonly color?: number;
	readonly pointLabels?: readonly number[];
	readonly view?: Partial<ScopeViewOptions>;
	/** Internal presentation hint: preserve forensic target but suppress rich context/local claim overlay. */
	readonly richOverlay?: boolean;
}

export interface ScopeManifestCase {
	readonly name: string;
	readonly image: string;
	readonly annotation?: string;
	readonly scopes: readonly ScopeRequest[];
}

export interface ScopeManifest {
	readonly version?: number;
	readonly image?: string;
	readonly annotation?: string;
	readonly scopes?: readonly ScopeRequest[];
	readonly cases?: readonly ScopeManifestCase[];
}

export interface RasterImage {
	readonly width: number;
	readonly height: number;
	readonly data: Uint8Array | Uint8ClampedArray;
	readonly imageId?: string;
}

export interface Rect {
	readonly x: number;
	readonly y: number;
	readonly w: number;
	readonly h: number;
}

export interface ScopePinOverlay {
	readonly name: string;
	readonly point: PointTuple;
	readonly kind: 'temp' | 'kept';
	readonly style: ScopePinStyle;
	readonly ttlRemaining?: number;
}

export interface ScopeResolvedRequest {
	readonly name: string;
	readonly kind: 'point' | 'box' | 'mark' | 'dots' | 'path' | 'hole';
	/** Tight active-object bounds in canonical raster coordinates. */
	readonly focus: Rect;
	readonly points: readonly PointTuple[];
	readonly pointLabels?: readonly number[];
	readonly template: string;
	readonly color: number;
	readonly hole?: number;
	readonly view?: Partial<ScopeViewOptions>;
	readonly richOverlay?: boolean;
}

export interface ScopePanelMeta {
	readonly name: 'context' | 'local' | 'forensic-wide' | 'forensic-mid' | 'forensic-tight';
	readonly label: string;
	readonly source: Rect;
	readonly outputPx: number;
	readonly resampling: 'bilinear' | 'nearest';
	readonly nearestNeighbor: boolean;
	readonly grid: boolean;
}

export interface ScopeCanonicalMeta {
	readonly imageId: string;
	readonly widthPx: number;
	readonly heightPx: number;
	readonly stripChrome: {
		readonly source: string;
		readonly insets: { readonly top: number; readonly right: number; readonly bottom: number; readonly left: number } | null;
	};
	readonly autoStitch: {
		readonly sourceCount: number;
		readonly hadFallback: boolean;
	};
}

export interface ScopeRenderMeta {
	readonly schemaVersion: 1;
	readonly mode: 'BLIND' | 'TRUTH_AVAILABLE';
	readonly image: string;
	readonly annotation?: string;
	readonly canonical: ScopeCanonicalMeta;
	readonly request: ScopeResolvedRequest;
	readonly view: ScopeViewOptions;
	readonly pins?: readonly ScopePinOverlay[];
	readonly panels: readonly ScopePanelMeta[];
	readonly output: string;
}
