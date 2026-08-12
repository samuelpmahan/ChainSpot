import { describe, expect, test } from 'vitest';
import {
	TILE_SLOTS,
	ZERO_CROP,
	cropSize,
	expectedNeighbors,
	initialPlacements,
	overlapArea,
	readiness,
	sessionDimensions,
	tileRect,
	translatedOrigin,
	unionBounds
} from '../../src/lib/stitch/geometry';
import type { CropInsets, TilePlacement, TileSlot } from '../../src/lib/stitch/geometry';
import { TileDecodeCoordinator, guardedDecode } from '../../src/lib/stitch/tileIntake';
import { ViewportController, fitViewportTransform } from '../../src/lib/viewport.svelte';
import type { ViewportFitTarget } from '../../src/lib/viewport.svelte';

function tilesOf(
	dims: Partial<Record<TileSlot, { widthPx: number; heightPx: number }>>
): Partial<Record<TileSlot, { widthPx: number; heightPx: number }>> {
	return { ...dims };
}

function placementsOf(
	positions: Partial<Record<TileSlot, { xPx: number; yPx: number }>>,
	visible: boolean = true
): Record<TileSlot, TilePlacement> {
	// `initialPlacements(100, 80)` with the default '2x2' layout always populates
	// all four 2x2 slots, so this cast is safe: only the widened `TileSlot` type
	// (which also covers the 1x2/2x1 slots this 2x2-only test never touches)
	// makes it necessary.
	const base = initialPlacements(100, 80) as Record<TileSlot, TilePlacement>;
	for (const slot of TILE_SLOTS) {
		const position = positions[slot];
		if (position) base[slot] = { ...base[slot], xPx: position.xPx, yPx: position.yPx, visible };
	}
	return base;
}

describe('stitch geometry (P05-002)', () => {
	test('contract: crop validation, initial placement, readiness, union translation, and decode race protection', async () => {
		// --- Shared crop: valid insets produce the cropped size ---
		const valid = cropSize({ topPx: 10, rightPx: 20, bottomPx: 30, leftPx: 40 }, 1000, 800);
		expect(valid).toEqual({ ok: true, widthPx: 940, heightPx: 760 });

		// --- Individual inset rejection, with the offending field identified ---
		const negative = cropSize({ ...ZERO_CROP, topPx: -1 }, 100, 100);
		if (negative.ok) throw new Error('expected rejection');
		expect(negative.invalidFields).toEqual(['topPx']);

		const fractional = cropSize({ ...ZERO_CROP, rightPx: 1.5 }, 100, 100);
		if (fractional.ok) throw new Error('expected rejection');
		expect(fractional.invalidFields).toEqual(['rightPx']);

		const nonFinite = cropSize({ ...ZERO_CROP, bottomPx: Number.NaN }, 100, 100);
		if (nonFinite.ok) throw new Error('expected rejection');
		expect(nonFinite.invalidFields).toEqual(['bottomPx']);

		// --- Pair rejection flags both horizontal / both vertical fields ---
		const horizontal = cropSize({ ...ZERO_CROP, leftPx: 600, rightPx: 500 }, 1000, 800);
		if (horizontal.ok) throw new Error('expected rejection');
		expect(horizontal.invalidFields).toEqual(['leftPx', 'rightPx']);

		const vertical = cropSize({ ...ZERO_CROP, topPx: 500, bottomPx: 400 }, 1000, 800);
		if (vertical.ok) throw new Error('expected rejection');
		expect(vertical.invalidFields).toEqual(['topPx', 'bottomPx']);

		// --- Initial placement: documented 25% offsets, always integers ---
		// The default '2x2' layout always populates all four slots.
		const initial = initialPlacements(1000, 800) as Record<TileSlot, TilePlacement>;
		expect(initial['upper-left']).toEqual({ xPx: 0, yPx: 0, visible: true });
		expect(initial['upper-right'].xPx).toBe(750);
		expect(initial['upper-right'].yPx).toBe(0);
		expect(initial['lower-left'].xPx).toBe(0);
		expect(initial['lower-left'].yPx).toBe(600);
		expect(initial['lower-right']).toEqual({ xPx: 750, yPx: 600, visible: true });

		// Rounding case: 0.75 products that are fractional must be rounded, not kept.
		const rounded = initialPlacements(1002, 802) as Record<TileSlot, TilePlacement>;
		expect(rounded['upper-right'].xPx).toBe(752);
		expect(rounded['lower-left'].yPx).toBe(602);

		// --- Expected neighbors per slot ---
		expect(expectedNeighbors('upper-left')).toEqual(['upper-right', 'lower-left']);
		expect(expectedNeighbors('upper-right')).toEqual(['upper-left', 'lower-right']);
		expect(expectedNeighbors('lower-left')).toEqual(['upper-left', 'lower-right']);
		expect(expectedNeighbors('lower-right')).toEqual(['upper-right', 'lower-left']);

		// --- Overlap area ---
		const rectA = tileRect({ xPx: 0, yPx: 0, visible: true }, 100, 80);
		const rectB = tileRect({ xPx: 75, yPx: 0, visible: true }, 100, 80);
		expect(overlapArea(rectA, rectB)).toBe(2000);
		const rectC = tileRect({ xPx: 500, yPx: 500, visible: true }, 100, 80);
		expect(overlapArea(rectA, rectC)).toBe(0);

		// --- Readiness: all valid ---
		const allTiles = tilesOf({
			'upper-left': { widthPx: 100, heightPx: 80 },
			'upper-right': { widthPx: 100, heightPx: 80 },
			'lower-left': { widthPx: 100, heightPx: 80 },
			'lower-right': { widthPx: 100, heightPx: 80 }
		});
		const required = sessionDimensions(allTiles);
		expect(required).toEqual({ widthPx: 100, heightPx: 80 });
		expect(readiness(allTiles, ZERO_CROP, initialPlacements(100, 80), required).ready).toBe(true);

		// --- Missing tile ---
		const missingRight = tilesOf(allTiles);
		delete missingRight['upper-right'];
		expect(readiness(missingRight, ZERO_CROP, initialPlacements(100, 80), required).missing).toEqual([
			'upper-right'
		]);

		// --- Dimension mismatch against the established requirement ---
		const mismatched = { ...allTiles, 'upper-right': { widthPx: 101, heightPx: 80 } };
		expect(readiness(mismatched, ZERO_CROP, initialPlacements(100, 80), required).dimensionMismatch).toEqual([
			'upper-right'
		]);

		// --- Invalid crop ---
		const invalidCrop: CropInsets = { ...ZERO_CROP, leftPx: 60, rightPx: 60 };
		expect(readiness(allTiles, invalidCrop, initialPlacements(100, 80), required).invalidCrop).toBe(true);

		// --- A connected manually adjusted arrangement stays ready ---
		const connected = placementsOf({
			'upper-right': { xPx: 40, yPx: 0 },
			'lower-left': { xPx: 0, yPx: 40 },
			'lower-right': { xPx: 40, yPx: 40 }
		});
		expect(readiness(allTiles, ZERO_CROP, connected, required).ready).toBe(true);

		// --- Visibility never affects readiness ---
		const hidden = placementsOf(
			{
				'upper-right': { xPx: 40, yPx: 0 },
				'lower-left': { xPx: 0, yPx: 40 },
				'lower-right': { xPx: 40, yPx: 40 }
			},
			false
		);
		expect(readiness(allTiles, ZERO_CROP, hidden, required).ready).toBe(true);

		// --- Two detached but internally overlapping clusters are NOT ready ---
		// Left cluster: UL overlaps LL. Right cluster: UR overlaps LR. No edge
		// connects the clusters, so upper-left cannot reach the right cluster.
		const clusters = placementsOf({
			'upper-right': { xPx: 500, yPx: 0 },
			'lower-left': { xPx: 0, yPx: 40 },
			'lower-right': { xPx: 500, yPx: 40 }
		});
		const clustersReport = readiness(allTiles, ZERO_CROP, clusters, required);
		expect(clustersReport.ready).toBe(false);
		expect(clustersReport.disconnected).toEqual(['upper-right', 'lower-right']);

		// --- Fully detached tiles report disconnected ---
		const drifted = placementsOf({
			'upper-right': { xPx: 500, yPx: 0 },
			'lower-left': { xPx: 0, yPx: 500 },
			'lower-right': { xPx: 500, yPx: 500 }
		});
		const driftedReport = readiness(allTiles, ZERO_CROP, drifted, required);
		expect(driftedReport.ready).toBe(false);
		expect(driftedReport.disconnected).toEqual(['upper-right', 'lower-left', 'lower-right']);

		// --- Session dimensions: first valid tile in slot order establishes them ---
		expect(sessionDimensions({})).toBeNull();
		expect(sessionDimensions({ 'lower-left': { widthPx: 20, heightPx: 21 } })).toEqual({
			widthPx: 20,
			heightPx: 21
		});
		expect(
			sessionDimensions({ 'upper-left': { widthPx: 10, heightPx: 11 }, 'lower-left': { widthPx: 20, heightPx: 21 } })
		).toEqual({ widthPx: 10, heightPx: 11 });

		// --- Union bounds and translation to origin ---
		const union = unionBounds([
			tileRect({ xPx: 0, yPx: 0, visible: true }, 100, 80),
			tileRect({ xPx: 75, yPx: 0, visible: true }, 100, 80),
			tileRect({ xPx: 0, yPx: 60, visible: true }, 100, 80),
			tileRect({ xPx: 75, yPx: 60, visible: true }, 100, 80)
		]);
		expect(union).toEqual({ xPx: 0, yPx: 0, widthPx: 175, heightPx: 140 });
		expect(translatedOrigin(union!)).toEqual({ dxPx: 0, dyPx: 0 });

		const negativeUnion = unionBounds([
			tileRect({ xPx: -10, yPx: -5, visible: true }, 100, 80),
			tileRect({ xPx: -35, yPx: -5, visible: true }, 100, 80)
		]);
		expect(negativeUnion).toEqual({ xPx: -35, yPx: -5, widthPx: 125, heightPx: 80 });
		expect(translatedOrigin(negativeUnion!)).toEqual({ dxPx: 35, dyPx: 5 });
		expect(unionBounds([])).toBeNull();

		// --- Stale decode protection: the guarded intake path (deterministic seam) ---
		const coordinator = new TileDecodeCoordinator();
		const slot = 'upper-right';
		const file = new File([], 'tile.png', { type: 'image/png' });
		const decodedOf = (widthPx: number, heightPx: number) => ({
			image: {} as HTMLImageElement,
			widthPx,
			heightPx
		});

		// File A begins decoding; file B is selected for the same slot afterward.
		// B completes first and may publish; A later completes and must not
		// replace B or publish any result.
		let resolveA!: (value: { image: HTMLImageElement; widthPx: number; heightPx: number }) => void;
		const gateA = new Promise<{ image: HTMLImageElement; widthPx: number; heightPx: number }>(
			(resolve) => (resolveA = resolve)
		);
		let resolveB!: (value: { image: HTMLImageElement; widthPx: number; heightPx: number }) => void;
		const gateB = new Promise<{ image: HTMLImageElement; widthPx: number; heightPx: number }>(
			(resolve) => (resolveB = resolve)
		);
		const generationA = coordinator.begin(slot);
		const generationB = coordinator.begin(slot);
		const attemptA = guardedDecode(coordinator, slot, generationA, file, () => gateA);
		const attemptB = guardedDecode(coordinator, slot, generationB, file, () => gateB);
		resolveB(decodedOf(10, 10));
		expect(await attemptB).toEqual({ ok: true, decoded: decodedOf(10, 10) });
		resolveA(decodedOf(20, 20));
		expect(await attemptA).toEqual({ ok: false, stale: true });

		// A stale FAILURE must not publish an error over the newest tile.
		let rejectC!: (error: Error) => void;
		const gateC = new Promise<{ image: HTMLImageElement; widthPx: number; heightPx: number }>(
			(_resolve, reject) => (rejectC = reject)
		);
		let resolveD!: (value: { image: HTMLImageElement; widthPx: number; heightPx: number }) => void;
		const gateD = new Promise<{ image: HTMLImageElement; widthPx: number; heightPx: number }>(
			(resolve) => (resolveD = resolve)
		);
		const attemptC = guardedDecode(coordinator, slot, coordinator.begin(slot), file, () => gateC);
		const attemptD = guardedDecode(coordinator, slot, coordinator.begin(slot), file, () => gateD);
		rejectC(new Error('late failure'));
		expect(await attemptC).toEqual({ ok: false, stale: true });
		resolveD(decodedOf(30, 30));
		expect(await attemptD).toEqual({ ok: true, decoded: decodedOf(30, 30) });

		// An UNSUPPORTED newer selection still invalidates the older decode: the
		// page begins a generation before MIME validation, so the unsupported
		// selection's error may publish while the older decode becomes stale.
		const generationBeforeUnsupported = coordinator.begin(slot);
		const generationUnsupported = coordinator.begin(slot);
		expect(coordinator.isCurrent(slot, generationUnsupported)).toBe(true);
		let resolveLate!: (value: { image: HTMLImageElement; widthPx: number; heightPx: number }) => void;
		const gateLate = new Promise<{ image: HTMLImageElement; widthPx: number; heightPx: number }>(
			(resolve) => (resolveLate = resolve)
		);
		const attemptLate = guardedDecode(
			coordinator,
			slot,
			generationBeforeUnsupported,
			file,
			() => gateLate
		);
		resolveLate(decodedOf(60, 60));
		expect(await attemptLate).toEqual({ ok: false, stale: true });

		// Removing the slot invalidates its in-flight decode: a later success
		// must not publish. Other slots remain independent and decode concurrently.
		let resolveE!: (value: { image: HTMLImageElement; widthPx: number; heightPx: number }) => void;
		const gateE = new Promise<{ image: HTMLImageElement; widthPx: number; heightPx: number }>(
			(resolve) => (resolveE = resolve)
		);
		const attemptE = guardedDecode(coordinator, slot, coordinator.begin(slot), file, () => gateE);
		coordinator.invalidate(slot);
		resolveE(decodedOf(40, 40));
		expect(await attemptE).toEqual({ ok: false, stale: true });

		let resolveOther!: (value: { image: HTMLImageElement; widthPx: number; heightPx: number }) => void;
		const gateOther = new Promise<{ image: HTMLImageElement; widthPx: number; heightPx: number }>(
			(resolve) => (resolveOther = resolve)
		);
		const attemptOther = guardedDecode(
			coordinator,
			'lower-left',
			coordinator.begin('lower-left'),
			file,
			() => gateOther
		);
		resolveOther(decodedOf(50, 50));
		expect(await attemptOther).toEqual({ ok: true, decoded: decodedOf(50, 50) });

		// Session reset invalidates every in-flight decode (generations retained
		// from begin(), never assumed).
		const handedOut = new Map<TileSlot, number>();
		for (const candidate of TILE_SLOTS) {
			handedOut.set(candidate, coordinator.begin(candidate));
		}
		coordinator.invalidateAll(TILE_SLOTS);
		for (const [candidate, generation] of handedOut) {
			expect(coordinator.isCurrent(candidate, generation)).toBe(false);
		}
		const fresh = coordinator.begin('upper-left');
		expect(coordinator.isCurrent('upper-left', fresh)).toBe(true);

		// --- Shared viewport: a fitted translated (nonzero-origin) tile union
		// stays fitted across resize, and clearing the target resets the view ---
		const viewport = new ViewportController();
		const translatedTarget: ViewportFitTarget = { xPx: -40, yPx: 30, widthPx: 100, heightPx: 60 };
		viewport.setFitTarget(translatedTarget);
		viewport.setSize({ width: 400, height: 300 });
		viewport.fit();
		const fittedBefore = viewport.view;
		viewport.setSize({ width: 200, height: 150 });
		const expectedFitted = fitViewportTransform(translatedTarget, 200, 150);
		// The narrower viewport adopts the new fit instead of keeping the old zoom.
		expect(viewport.view.zoom).toBeLessThan(fittedBefore.zoom);
		expect(viewport.view).toEqual(expectedFitted);
		// A custom view that exactly equals the ORIGIN-ZERO default fit for the
		// pane (zoom 3, pan (0, 10) for 300x200 over a 100x60 target) must still
		// be preserved as a custom view: the translated fit for the {-40, 30}
		// target is {3, 120, -80}, so this view is genuinely custom and the
		// resize must anchor the pane-center content point, not reset to fit.
		viewport.setSize({ width: 300, height: 200 });
		viewport.view = { zoom: 3, panX: 0, panY: 10 };
		viewport.setSize({ width: 320, height: 180 });
		// Anchor under the old center (150, 100) -> image (50, 30); new pan =
		// (320/2 - 50*3, 180/2 - 30*3) = (10, 0), zoom retained at 3.
		expect(viewport.view).toEqual({ zoom: 3, panX: 10, panY: 0 });
		// Clearing the target resets both fit and view so a fresh session starts
		// from identity rather than stale pan/zoom.
		viewport.setFitTarget(null);
		expect(viewport.view).toEqual({ zoom: 1, panX: 0, panY: 0 });
	});
});
