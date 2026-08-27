/**
 * Small, truth-independent occlusion vocabulary used by G3 recovery.
 *
 * The detector deliberately distinguishes OPAQUE from ALPHA.  A flattened
 * alpha edge is not evidence that an expected tee border is hidden, so the
 * recovery scorer may only use OPAQUE samples as an occlusion excuse.
 */

export type OcclusionKind = 'OPAQUE' | 'ALPHA' | 'UNKNOWN';

export interface OpaqueDetector {
	/** Coordinates are always original-image pixels. */
	kindAt(xPx: number, yPx: number): OcclusionKind;
}

/** Reserved sibling provider: ALPHA is legal vocabulary but tee recovery
 * deliberately does not use it as an excuse for missing paint. */
export interface AlphaDetector {
	kindAt(xPx: number, yPx: number): Extract<OcclusionKind, 'ALPHA' | 'UNKNOWN'>;
}

/**
 * Run-scoped composition seam. Producers register their known footprints;
 * consumers query one stable handler for the duration of that run. OPAQUE
 * wins over ALPHA, so an actual opaque sprite/badge is never weakened by a
 * later antialiasing provider. This is infrastructure, not a feature stage.
 */
export class OcclusionDetector implements OpaqueDetector {
	private readonly opaqueProviders: OpaqueDetector[] = [];
	private readonly alphaProviders: AlphaDetector[] = [];

	registerOpaque(provider: OpaqueDetector): void {
		this.opaqueProviders.push(provider);
	}

	registerAlpha(provider: AlphaDetector): void {
		this.alphaProviders.push(provider);
	}

	kindAt(xPx: number, yPx: number): OcclusionKind {
		if (this.opaqueProviders.some((provider) => provider.kindAt(xPx, yPx) === 'OPAQUE')) return 'OPAQUE';
		if (this.alphaProviders.some((provider) => provider.kindAt(xPx, yPx) === 'ALPHA')) return 'ALPHA';
		return 'UNKNOWN';
	}
}

export interface OpaqueBox {
	readonly x0: number;
	readonly y0: number;
	readonly x1: number;
	readonly y1: number;
}

/** A deterministic detector useful for the basket/badge footprint seam. */
export class BoxOpaqueDetector implements OpaqueDetector {
	readonly boxes: readonly OpaqueBox[];

	constructor(boxes: readonly OpaqueBox[]) {
		this.boxes = boxes.slice();
	}

	kindAt(xPx: number, yPx: number): OcclusionKind {
		if (!Number.isFinite(xPx) || !Number.isFinite(yPx)) return 'UNKNOWN';
		return this.boxes.some((box) => xPx >= box.x0 && xPx <= box.x1 && yPx >= box.y0 && yPx <= box.y1)
			? 'OPAQUE'
			: 'UNKNOWN';
	}
}

export function opaqueDetectorFromBoxes(boxes: readonly OpaqueBox[]): OpaqueDetector {
	return new BoxOpaqueDetector(boxes);
}
