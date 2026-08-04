/**
 * ChainSpot pane scene composition (P0-005, P0-006).
 *
 * Establishes exactly the active Phase 0 scene responsibilities per pane:
 * - `rasterLayer`: the decoded original rendered at the plain view transform;
 * - `controlPointLayer`: image-space control-point markers (P0-007+);
 * - `interactionLayer`: reserved for pointer interaction content (P0-007+).
 *
 * No future registration-preview or extracted-overlay layers are created. Konva nodes
 * exist only here and never enter durable project state; the raster image is the
 * transient decoded browser image registered by the domain asset registry.
 *
 * View transform boundary (P0-006): a single plain `ViewTransformState` is the
 * authoritative transient view state for the pane. `applyTransform` is the only place
 * that view state reaches Konva and it applies the identical transform to every
 * image-space view group: the raster group and the control-point group (exposed as
 * `controlPointGroup` for P0-007 markers, which stay anchored in image space under
 * the same transform). The interaction layer is screen-space and is not transformed.
 *
 * Rendering never resets navigation: `setImage` only swaps the raster content, and
 * stage dimensions change only through `setStageSize`.
 */
import Konva from 'konva';
import type { ScreenSpacePoint, ViewTransformState } from './coords';
import type { PointSide } from './domain/editor';

export interface MarkerSceneData {
	readonly id: string;
	readonly pairId: string | null;
	readonly side: PointSide;
	readonly ordinal: number;
	readonly xPx: number;
	readonly yPx: number;
	readonly kind: 'pending' | 'complete';
	readonly selected: boolean;
	/** False only for complete pairs whose durable enabled flag is false. */
	readonly enabled: boolean;
}

/** Screen-constant marker sizes in CSS pixels (net of the 1/zoom visual scale). */
export const MARKER_HIT_RADIUS = 18;
export const MARKER_SYMBOL_RADIUS = 10;
export const MARKER_ANCHOR_RADIUS = 2.5;
export const MARKER_SELECTED_RING_RADIUS = 14;
export const MARKER_ORDINAL_FONT_SIZE = 12;

export interface MarkerVisualSpec {
	readonly hitRadius: number;
	readonly symbolRadius: number;
	readonly symbolFill: string;
	readonly symbolStroke: string;
	readonly symbolStrokeWidth: number;
	readonly symbolDashed: boolean;
	readonly symbolOpacity: number;
	/** Exact-coordinate anchor dot: smaller than the symbol and visually distinct. */
	readonly anchorRadius: number;
	readonly anchorFill: string;
	readonly anchorStroke: string;
	readonly anchorStrokeWidth: number;
	readonly selectedRingRadius: number;
	readonly selectedRingStroke: string;
	readonly selectedRingStrokeWidth: number;
	readonly ordinalFontSize: number;
	readonly ordinalFill: string;
	readonly ordinalStroke: string;
	readonly ordinalStrokeWidth: number;
}

/**
 * Pure deterministic visual spec for a marker (P0-007/P0-012). All sizes are
 * screen-constant CSS pixels; the rendered group carries a `1/zoom` scale so the
 * exact coordinate stays at `(xPx, yPx)` while the visual size never changes with
 * the view. Distinctions:
 * - pending: amber, dashed outline;
 * - complete enabled: blue;
 * - complete disabled: slate, dashed outline, reduced opacity;
 * - selected: extra yellow ring + yellow anchor ring.
 */
export function markerVisualSpec(marker: MarkerSceneData): MarkerVisualSpec {
	const disabled = marker.kind === 'complete' && !marker.enabled;
	const symbolFill = marker.kind === 'pending' ? '#b45309' : disabled ? '#64748b' : '#075985';
	const symbolDashed = marker.kind === 'pending' || disabled;
	return {
		hitRadius: MARKER_HIT_RADIUS,
		symbolRadius: MARKER_SYMBOL_RADIUS,
		symbolFill,
		symbolStroke: '#ffffff',
		symbolStrokeWidth: 2,
		symbolDashed,
		symbolOpacity: disabled ? 0.75 : 1,
		anchorRadius: MARKER_ANCHOR_RADIUS,
		anchorFill: '#ffffff',
		anchorStroke: marker.selected ? '#facc15' : '#111827',
		anchorStrokeWidth: marker.selected ? 2 : 1.5,
		selectedRingRadius: MARKER_SELECTED_RING_RADIUS,
		selectedRingStroke: '#facc15',
		selectedRingStrokeWidth: 3,
		ordinalFontSize: MARKER_ORDINAL_FONT_SIZE,
		ordinalFill: '#ffffff',
		ordinalStroke: 'rgba(15, 23, 42, 0.85)',
		ordinalStrokeWidth: 1.5
	};
}

export interface MarkerHitResult {
	readonly pairId: string | null;
	readonly side: PointSide;
	readonly kind: 'pending' | 'complete';
}

/**
 * Net scale applied to each marker group so its visual size stays screen-constant
 * in CSS pixels at every supported zoom level. The group sits inside the
 * zoom-scaled control-point group, so `1/zoom` cancels the group zoom exactly.
 */
export function markerVisualScale(zoom: number): { x: number; y: number } {
	if (!Number.isFinite(zoom) || zoom <= 0) {
		throw new Error(`markerVisualScale: zoom must be a positive finite number, got ${zoom}`);
	}
	return { x: 1 / zoom, y: 1 / zoom };
}

export interface PaneScene {
	readonly rasterLayer: Konva.Layer;
	readonly controlPointLayer: Konva.Layer;
	readonly interactionLayer: Konva.Layer;
	/**
	 * Image-space view group inside `controlPointLayer`; P0-007 adds marker scene
	 * objects here so they share the pane view transform.
	 */
	readonly controlPointGroup: Konva.Group;
	/** Swaps the raster content without touching the view transform. */
	setImage(image: HTMLImageElement, widthPx: number, heightPx: number): void;
	/** Applies the authoritative plain view transform to all image-space view groups. */
	applyTransform(transform: ViewTransformState): void;
	/** Replaces the transient marker scene objects from plain image-space marker data. */
	setMarkers(markers: readonly MarkerSceneData[]): void;
	/**
	 * Transient marker-overlay visibility. Rendering-only: hiding never changes marker
	 * scene objects, hit tests, or any durable project data, so creation, selection,
	 * and correction keep working while the overlay is hidden.
	 */
	setMarkersVisible(visible: boolean): void;
	setStageSize(width: number, height: number): void;
	/**
	 * True when the stage has a shape at `pointer` belonging to the control-point
	 * layer. P0-006 panning refuses these targets so P0-007 marker drags keep a
	 * separable event path; empty in Phase 0, so it always returns false.
	 */
	markerHitAt(pointer: ScreenSpacePoint): MarkerHitResult | null;
	clearImage(): void;
	destroy(): void;
}

/** True only where a real 2D canvas context is available (Chromium); false in jsdom. */
export function canvas2dAvailable(): boolean {
	try {
		const canvas = document.createElement('canvas');
		return typeof canvas.getContext === 'function' && canvas.getContext('2d') !== null;
	} catch {
		return false;
	}
}

export function createPaneScene(container: HTMLDivElement): PaneScene {
	const stage = new Konva.Stage({
		container,
		width: container.clientWidth || 1,
		height: container.clientHeight || 1,
		pixelRatio: globalThis.devicePixelRatio || 1
	});

	const rasterLayer = new Konva.Layer({ name: 'rasterImageLayer' });
	const controlPointLayer = new Konva.Layer({ name: 'controlPointLayer' });
	const interactionLayer = new Konva.Layer({ name: 'interactionLayer' });
	stage.add(rasterLayer);
	stage.add(controlPointLayer);
	stage.add(interactionLayer);

	const rasterGroup = new Konva.Group({ name: 'rasterViewGroup' });
	rasterLayer.add(rasterGroup);
	const controlPointGroup = new Konva.Group({ name: 'controlPointViewGroup' });
	controlPointLayer.add(controlPointGroup);

	let imageNode: Konva.Image | null = null;
	let markerZoom = 1;

	function createMarker(marker: MarkerSceneData): Konva.Group {
		const spec = markerVisualSpec(marker);
		const group = new Konva.Group({
			id: marker.id,
			name: marker.kind === 'pending' ? 'pendingMarker' : 'completeMarker',
			pairId: marker.pairId,
			side: marker.side,
			kind: marker.kind,
			x: marker.xPx,
			y: marker.yPx,
			scale: markerVisualScale(markerZoom)
		});
		const hitTarget = new Konva.Circle({
			name: 'markerHitTarget',
			radius: spec.hitRadius,
			fill: 'rgba(0, 0, 0, 0.001)'
		});
		const symbol = new Konva.Circle({
			name: 'markerSymbol',
			radius: spec.symbolRadius,
			fill: spec.symbolFill,
			stroke: spec.symbolStroke,
			strokeWidth: spec.symbolStrokeWidth,
			dash: spec.symbolDashed ? [4, 3] : undefined,
			opacity: spec.symbolOpacity,
			listening: false
		});
		const anchor = new Konva.Circle({
			name: 'markerAnchor',
			radius: spec.anchorRadius,
			fill: spec.anchorFill,
			stroke: spec.anchorStroke,
			strokeWidth: spec.anchorStrokeWidth,
			listening: false
		});
		const number = new Konva.Text({
			name: 'markerOrdinal',
			text: String(marker.ordinal),
			fontFamily: 'system-ui, sans-serif',
			fontSize: spec.ordinalFontSize,
			fontStyle: 'bold',
			fill: spec.ordinalFill,
			stroke: spec.ordinalStroke,
			strokeWidth: spec.ordinalStrokeWidth,
			width: 20,
			height: 20,
			offsetX: 10,
			offsetY: 10,
			align: 'center',
			verticalAlign: 'middle',
			listening: false
		});
		group.add(hitTarget);
		if (marker.selected) {
			group.add(
				new Konva.Circle({
					name: 'selectedMarkerRing',
					radius: spec.selectedRingRadius,
					stroke: spec.selectedRingStroke,
					strokeWidth: spec.selectedRingStrokeWidth,
					listening: false
				})
			);
		}
		group.add(symbol, anchor, number);
		return group;
	}

	function ensureImageNode(): Konva.Image {
		if (!imageNode) {
			imageNode = new Konva.Image({ image: undefined as unknown as HTMLImageElement });
			rasterGroup.add(imageNode);
		}
		return imageNode;
	}

	return {
		rasterLayer,
		controlPointLayer,
		interactionLayer,
		controlPointGroup,

		setImage(image, widthPx, heightPx) {
			const node = ensureImageNode();
			node.image(image);
			node.width(widthPx);
			node.height(heightPx);
			rasterGroup.visible(true);
			rasterLayer.batchDraw();
		},

		applyTransform(transform) {
			markerZoom = transform.zoom;
			rasterGroup.position({ x: transform.panX, y: transform.panY });
			rasterGroup.scale({ x: transform.zoom, y: transform.zoom });
			controlPointGroup.position({ x: transform.panX, y: transform.panY });
			controlPointGroup.scale({ x: transform.zoom, y: transform.zoom });
			for (const marker of controlPointGroup.getChildren()) {
				marker.scale(markerVisualScale(markerZoom));
			}
			rasterLayer.batchDraw();
			controlPointLayer.batchDraw();
		},

		setMarkers(markers) {
			controlPointGroup.destroyChildren();
			for (const marker of markers) controlPointGroup.add(createMarker(marker));
			controlPointLayer.batchDraw();
		},

		setMarkersVisible(visible) {
			controlPointLayer.visible(visible);
			controlPointLayer.batchDraw();
		},

		setStageSize(width, height) {
			stage.width(width);
			stage.height(height);
			rasterLayer.batchDraw();
			controlPointLayer.batchDraw();
			interactionLayer.batchDraw();
		},

		markerHitAt(pointer) {
			const hit = stage.getIntersection({ x: pointer.x, y: pointer.y });
			if (!hit) return null;
			let node: Konva.Node | null = hit;
			while (node) {
				if (node.getParent() === controlPointGroup) {
					const pairId = node.getAttr('pairId');
					const side = node.getAttr('side');
					const kind = node.getAttr('kind');
					if (
						(side === 'source' || side === 'target') &&
						(kind === 'pending' || kind === 'complete') &&
						(pairId === null || typeof pairId === 'string')
					) {
						return { pairId, side, kind };
					}
				}
				node = node.getParent();
			}
			return null;
		},

		clearImage() {
			// Drop the decoded image reference so the browser can collect it once the
			// domain asset registry releases the asset; Konva draws nothing when the
			// image is undefined.
			imageNode?.image(undefined);
			rasterGroup.visible(false);
			controlPointGroup.destroyChildren();
			rasterLayer.batchDraw();
			controlPointLayer.batchDraw();
		},

		destroy() {
			stage.destroy();
		}
	};
}
