/**
 * ChainSpot pane scene composition (P0-005, P0-006).
 *
 * Establishes the active scene responsibilities per pane:
 * - `rasterLayer`: the decoded original rendered at the plain view transform;
 * - `ghostCourseLayer`: a non-interactive live preview of the transformed
 *   course geometry (P1-006, live registration preview), sitting above the
 *   raster but below the control points so correspondence markers stay on
 *   top and clearly clickable;
 * - `controlPointLayer`: image-space control-point markers (P0-007+);
 * - `interactionLayer`: reserved for pointer interaction content (P0-007+).
 *
 * Konva nodes exist only here and never enter durable project state; the raster
 * image is the transient decoded browser image registered by the domain asset
 * registry, and ghost-course geometry is purely derived from the current
 * alignment transform — never written back into any domain state.
 *
 * View transform boundary (P0-006): a single plain `ViewTransformState` is the
 * authoritative transient view state for the pane. `applyTransform` is the only place
 * that view state reaches Konva and it applies the identical transform to every
 * image-space view group: the raster group, the ghost-course group, and the
 * control-point group (exposed as `controlPointGroup` for P0-007 markers), all of
 * which stay anchored in image space under the same transform. The interaction
 * layer is screen-space and is not transformed.
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

/** A target-image-space point, structurally identical to `holeGraphics.ts`'s `TargetPoint`. */
export interface GhostPoint {
	readonly xPx: number;
	readonly yPx: number;
}

/**
 * One hole's already-transformed geometry for the live registration-preview
 * overlay (P1-006). Deliberately narrow and structurally compatible with
 * `holeGraphics.ts`'s `HoleGraphicPlan` (callers pass a `HoleGraphicPlan[]`
 * straight through) rather than importing that richer, export-focused type —
 * this module only ever draws points, it never crops or frames.
 */
export interface GhostCourseHole {
	readonly holeId: string;
	readonly number: number;
	readonly tee: GhostPoint | null;
	readonly basket: GhostPoint | null;
	readonly bends: readonly GhostPoint[];
	/** Closed polygon; null when the hole has no complete tee-to-basket band to derive. */
	readonly corridorBand: readonly GhostPoint[] | null;
	/** [tee, ...bends, basket] with absent endpoints filtered out. */
	readonly centerline: readonly GhostPoint[];
}

/** Non-interactive proof points for the played-round -> clean-target chain. */
export interface RegistrationProofPoint {
	readonly id: string;
	readonly xPx: number;
	readonly yPx: number;
}

/**
 * Ghost-course visual constants. Deliberately translucent and desaturated
 * relative to `markerVisualSpec`'s correspondence-marker palette (opaque
 * blue/amber/slate) so the two overlays stay visually distinct at a glance:
 * this is a background reference, not an interactive control.
 */
const GHOST_CORRIDOR_FILL = 'rgba(56, 189, 248, 0.14)';
const GHOST_CORRIDOR_STROKE = 'rgba(56, 189, 248, 0.55)';
const GHOST_CENTERLINE_STROKE = 'rgba(226, 232, 240, 0.55)';
const GHOST_TEE_FILL = 'rgba(74, 222, 128, 0.6)';
const GHOST_BASKET_FILL = 'rgba(248, 113, 113, 0.6)';
const GHOST_BEND_FILL = 'rgba(226, 232, 240, 0.55)';
const GHOST_LABEL_FILL = 'rgba(255, 255, 255, 0.75)';
const GHOST_TEE_BASKET_RADIUS = 7;
const GHOST_BEND_RADIUS = 4;

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
	readonly ghostCourseLayer: Konva.Layer;
	readonly controlPointLayer: Konva.Layer;
	readonly interactionLayer: Konva.Layer;
	/**
	 * Image-space view group inside `controlPointLayer`; P0-007 adds marker scene
	 * objects here so they share the pane view transform.
	 */
	readonly controlPointGroup: Konva.Group;
	/** Swaps the raster content without touching the view transform. */
	setImage(image: HTMLImageElement, widthPx: number, heightPx: number): void;
	/**
	 * Applies the authoritative plain view transform to all image-space view groups,
	 * composed with an optional manual rotation (CHSPT-44) about the current raster
	 * image's own center. `rotationDeg` defaults to 0 (no rotation, today's exact
	 * behavior); a caller with no rotated pose never needs to pass it. Rotating a group
	 * carries every one of its children — raster, ghost-course overlay, and
	 * correspondence markers alike — rigidly together, so overlay geometry never needs
	 * separate rotation math.
	 */
	applyTransform(transform: ViewTransformState, rotationDeg?: number): void;
	/** Replaces the transient marker scene objects from plain image-space marker data. */
	setMarkers(markers: readonly MarkerSceneData[]): void;
	/**
	 * Transient marker-overlay visibility. Rendering-only: hiding never changes marker
	 * scene objects, hit tests, or any durable project data, so creation, selection,
	 * and correction keep working while the overlay is hidden.
	 */
	setMarkersVisible(visible: boolean): void;
	/**
	 * Replaces the live registration-preview scene objects from already-
	 * target-space hole geometry (P1-006). Every node is non-listening — the
	 * overlay never participates in `markerHitAt` or pointer claiming, so it can
	 * never interfere with correspondence placement/editing regardless of
	 * visibility or z-order.
	 */
	setGhostCourse(holes: readonly GhostCourseHole[]): void;
	/** Transient ghost-course overlay visibility; rendering-only, same contract as `setMarkersVisible`. */
	setGhostCourseVisible(visible: boolean): void;
	/** Replaces the transient composed-registration proof points. */
	setRegistrationProofPoints(points: readonly RegistrationProofPoint[]): void;
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
	const ghostCourseLayer = new Konva.Layer({ name: 'ghostCourseLayer', listening: false });
	const controlPointLayer = new Konva.Layer({ name: 'controlPointLayer' });
	const interactionLayer = new Konva.Layer({ name: 'interactionLayer' });
	stage.add(rasterLayer);
	stage.add(ghostCourseLayer);
	stage.add(controlPointLayer);
	stage.add(interactionLayer);

	const rasterGroup = new Konva.Group({ name: 'rasterViewGroup' });
	rasterLayer.add(rasterGroup);
	const ghostCourseGroup = new Konva.Group({ name: 'ghostCourseViewGroup', listening: false });
	ghostCourseLayer.add(ghostCourseGroup);
	const registrationProofGroup = new Konva.Group({ name: 'registrationProofGroup', listening: false });
	ghostCourseLayer.add(registrationProofGroup);
	const controlPointGroup = new Konva.Group({ name: 'controlPointViewGroup' });
	controlPointLayer.add(controlPointGroup);

	let imageNode: Konva.Image | null = null;
	let markerZoom = 1;
	/**
	 * Current manual target-pose rotation (CHSPT-44), captured the same way `markerZoom`
	 * already is, so a marker/ghost-label node built AFTER a rotation is active (e.g.
	 * `setMarkers`/`setGhostCourse` destroy-and-rebuild in response to a new
	 * correspondence pair or an edited hole, independently of `applyTransform`) starts
	 * counter-rotated immediately instead of rendering tilted until the next unrelated
	 * `applyTransform` call happens to sweep through and fix it.
	 */
	let currentRotationDeg = 0;
	/** Current raster's own pixel dimensions, tracked so `applyTransform` can rotate every view group about its center without the caller re-supplying it every frame. */
	let imageDims: { widthPx: number; heightPx: number } | null = null;

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
			scale: markerVisualScale(markerZoom),
			rotation: -currentRotationDeg
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

	function pointsToFlat(points: readonly GhostPoint[]): number[] {
		const flat: number[] = [];
		for (const point of points) flat.push(point.xPx, point.yPx);
		return flat;
	}

	/**
	 * One hole's ghost geometry. Every node is `listening: false` and the parent
	 * layer is itself non-listening, so the overlay is unreachable from
	 * `stage.getIntersection` (the same mechanism `markerHitAt` relies on) at
	 * every layer of the stack — pointer-transparency holds regardless of paint
	 * order or visibility.
	 */
	function createGhostHole(hole: GhostCourseHole): Konva.Group {
		const group = new Konva.Group({ name: 'ghostHole', listening: false });

		if (hole.corridorBand && hole.corridorBand.length >= 3) {
			group.add(
				new Konva.Line({
					name: 'ghostCorridorBand',
					points: pointsToFlat(hole.corridorBand),
					closed: true,
					fill: GHOST_CORRIDOR_FILL,
					stroke: GHOST_CORRIDOR_STROKE,
					strokeWidth: 2,
					strokeScaleEnabled: false,
					listening: false
				})
			);
		}

		if (hole.centerline.length >= 2) {
			group.add(
				new Konva.Line({
					name: 'ghostCenterline',
					points: pointsToFlat(hole.centerline),
					stroke: GHOST_CENTERLINE_STROKE,
					strokeWidth: 1.5,
					dash: [8, 5],
					strokeScaleEnabled: false,
					listening: false
				})
			);
		}

		for (const bend of hole.bends) {
			group.add(
				new Konva.Circle({
					name: 'ghostBend',
					x: bend.xPx,
					y: bend.yPx,
					radius: GHOST_BEND_RADIUS,
					fill: GHOST_BEND_FILL,
					listening: false
				})
			);
		}

		if (hole.tee) {
			group.add(
				new Konva.Circle({
					name: 'ghostTee',
					x: hole.tee.xPx,
					y: hole.tee.yPx,
					radius: GHOST_TEE_BASKET_RADIUS,
					fill: GHOST_TEE_FILL,
					listening: false
				})
			);
		}

		if (hole.basket) {
			group.add(
				new Konva.Circle({
					name: 'ghostBasket',
					x: hole.basket.xPx,
					y: hole.basket.yPx,
					radius: GHOST_TEE_BASKET_RADIUS,
					fill: GHOST_BASKET_FILL,
					listening: false
				})
			);
		}

		const labelAnchor = hole.tee ?? hole.basket ?? hole.centerline[0] ?? null;
		if (labelAnchor) {
			group.add(
				new Konva.Text({
					name: 'ghostHoleNumber',
					text: String(hole.number),
					x: labelAnchor.xPx + GHOST_TEE_BASKET_RADIUS + 4,
					y: labelAnchor.yPx - GHOST_TEE_BASKET_RADIUS - 14,
					fontFamily: 'system-ui, sans-serif',
					fontSize: 14,
					fontStyle: 'bold',
					fill: GHOST_LABEL_FILL,
					listening: false,
					rotation: -currentRotationDeg
				})
			);
		}

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
		ghostCourseLayer,
		controlPointLayer,
		interactionLayer,
		controlPointGroup,

		setImage(image, widthPx, heightPx) {
			const node = ensureImageNode();
			node.image(image);
			node.width(widthPx);
			node.height(heightPx);
			imageDims = { widthPx, heightPx };
			rasterGroup.visible(true);
			rasterLayer.batchDraw();
		},

		applyTransform(transform, rotationDeg = 0) {
			markerZoom = transform.zoom;
			currentRotationDeg = rotationDeg;
			// Pivot at the raster's own center in image-space, then scale/pan exactly as
			// the unrotated case did — see the interface doc and `coords.ts`'s
			// `imageToScreenRotated` for the shared "rotate about center, then pan/zoom"
			// formula this mirrors. No raster yet (dims unknown) falls back to (0, 0),
			// same as an unrotated pivot at the group origin.
			const centerX = imageDims ? imageDims.widthPx / 2 : 0;
			const centerY = imageDims ? imageDims.heightPx / 2 : 0;
			const position = {
				x: transform.panX + transform.zoom * centerX,
				y: transform.panY + transform.zoom * centerY
			};
			for (const group of [rasterGroup, ghostCourseGroup, controlPointGroup, registrationProofGroup]) {
				group.offset({ x: centerX, y: centerY });
				group.position(position);
				group.scale({ x: transform.zoom, y: transform.zoom });
				group.rotation(rotationDeg);
			}
			for (const marker of controlPointGroup.getChildren()) {
				marker.scale(markerVisualScale(markerZoom));
				// Counter-rotate each marker's own symbol/ordinal so it stays upright while
				// its position still rotates rigidly with the parent group (CHSPT-44).
				marker.rotation(-rotationDeg);
			}
			for (const holeGroup of ghostCourseGroup.getChildren()) {
				// The hole-number label is the only ghost-course element whose readability
				// depends on orientation (basket/tee dots and the centerline path look and
				// behave identically rotated); counter-rotate it in place so it stays
				// upright, mirroring the marker-ordinal treatment above (CHSPT-44).
				if (!(holeGroup instanceof Konva.Group)) continue;
				const label = holeGroup.findOne('.ghostHoleNumber');
				if (label) label.rotation(-rotationDeg);
			}
			rasterLayer.batchDraw();
			ghostCourseLayer.batchDraw();
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

		setGhostCourse(holes) {
			ghostCourseGroup.destroyChildren();
			for (const hole of holes) ghostCourseGroup.add(createGhostHole(hole));
			ghostCourseLayer.batchDraw();
		},

		setGhostCourseVisible(visible) {
			ghostCourseLayer.visible(visible);
			ghostCourseLayer.batchDraw();
		},
		setRegistrationProofPoints(points) {
			registrationProofGroup.destroyChildren();
			for (const point of points) {
				registrationProofGroup.add(
					new Konva.Circle({
						name: 'registrationProofPoint',
						x: point.xPx,
						y: point.yPx,
						radius: 9,
						fill: 'rgba(192, 132, 252, 0.28)',
						stroke: '#d8b4fe',
						strokeWidth: 2,
						strokeScaleEnabled: false,
						listening: false
					})
				);
			}
			ghostCourseLayer.batchDraw();
		},

		setStageSize(width, height) {
			stage.width(width);
			stage.height(height);
			rasterLayer.batchDraw();
			ghostCourseLayer.batchDraw();
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
			ghostCourseGroup.destroyChildren();
			controlPointGroup.destroyChildren();
			rasterLayer.batchDraw();
			ghostCourseLayer.batchDraw();
			controlPointLayer.batchDraw();
		},

		destroy() {
			stage.destroy();
		}
	};
}
