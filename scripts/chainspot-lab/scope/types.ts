export type PointTuple = readonly [number, number];
export type BoxTuple = readonly [number, number, number, number];

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
	readonly ttlRemaining?: number;
}

export interface ScopeResolvedRequest {
	readonly name: string;
	readonly kind: 'point' | 'box' | 'mark' | 'dots' | 'path' | 'hole';
	readonly focus: Rect;
	readonly points: readonly PointTuple[];
	readonly pointLabels?: readonly number[];
	readonly template: string;
	readonly color: number;
	readonly hole?: number;
}

export interface ScopePanelMeta {
	readonly name: 'context' | 'local' | 'forensic-wide' | 'forensic-mid' | 'forensic-tight';
	readonly source: Rect;
	readonly outputPx: number;
	readonly nearestNeighbor: true;
}

export interface ScopeRenderMeta {
	readonly schemaVersion: 1;
	readonly mode: 'BLIND' | 'TRUTH_AVAILABLE';
	readonly image: string;
	readonly annotation?: string;
	readonly request: ScopeResolvedRequest;
	readonly pins?: readonly ScopePinOverlay[];
	readonly panels: readonly ScopePanelMeta[];
	readonly output: string;
}
