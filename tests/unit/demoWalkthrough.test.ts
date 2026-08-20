// @vitest-environment jsdom

/**
 * Guided-demo unit coverage.
 *
 * The demo's value is entirely in its honesty, so these tests guard the
 * claims that would be embarrassing to break in front of a prospective
 * customer: that every armed input is a real supported image handed to a real
 * intake path, that arming never silently discards work the visitor already
 * produced, and that the one step whose whole point is "your in-session work
 * is gone, but the course isn't" actually resumes on the right step across
 * what stands in for a reload here (real navigation is outside jsdom's reach
 * — see the reload-specific tests below for exactly what is and isn't
 * covered).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { armDemoStep, stepHasArming } from '../../src/lib/demo/arming';
import { DemoAssetError, fetchDemoFile } from '../../src/lib/demo/assets';
import {
	DEMO_DATASET,
	DEMO_STEPS,
	DEMO_STEP_COUNT,
	demoAssetUrl,
	demoStepUrl
} from '../../src/lib/demo/catalog';
import type { DemoStep } from '../../src/lib/demo/catalog';
import { DemoTour } from '../../src/lib/demo/tour.svelte';
import {
	clearPendingStitchCaptures,
	consumePendingHandoff,
	getPendingHandoff,
	getPendingStitchCaptures,
	setPendingHandoff,
	subscribePendingHandoff,
	subscribePendingStitchCaptures,
	takePendingStitchCaptures
} from '../../src/lib/session';
import { SUPPORTED_MIME_TYPES } from '../../src/lib/imageIntake';

function stepById(id: string): DemoStep {
	const step = DEMO_STEPS.find((candidate) => candidate.id === id);
	if (!step) throw new Error(`No demo step "${id}"`);
	return step;
}

/** A fetch stub that serves every catalogued asset as non-empty PNG-ish bytes. */
function okFetch(): typeof fetch {
	return (async (input: RequestInfo | URL) =>
		new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), {
			status: 200,
			headers: { 'content-type': 'application/octet-stream' }
		})) as unknown as typeof fetch;
}

beforeEach(() => {
	clearPendingStitchCaptures();
	consumePendingHandoff();
	sessionStorage.clear();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('demo catalog', () => {
	it('declares only supported image types and base-path-relative asset URLs', () => {
		const assets = [...DEMO_DATASET.captures, DEMO_DATASET.roundOverview];
		expect(assets.length).toBe(3);
		for (const asset of assets) {
			expect(SUPPORTED_MIME_TYPES).toContain(asset.mimeType);
			expect(asset.path.startsWith('/resources/demo/')).toBe(true);
			expect(demoAssetUrl(asset)).toBe(asset.path);
		}
	});

	it('supplies the captures Stitch Map needs (>= 2, no grid position in their names)', () => {
		// Smart Import/Stitch Map require N >= 2 captures, not exactly 4 -- that
		// was dashs-track's own capture count, not a system invariant (see
		// autoCrop.ts's module doc: "N (N >= 2) screenshots"). The REC (the
		// current DEMO_DATASET, since 7a31f0f) ships 2.
		expect(DEMO_DATASET.captures.length).toBeGreaterThanOrEqual(2);
		const names = DEMO_DATASET.captures.map((capture) => capture.fileName);
		expect(new Set(names).size).toBe(names.length);
		for (const name of names) {
			expect(name).not.toMatch(/upper|lower|left|right|top|bottom|\b(tl|tr|bl|br)\b/i);
		}
	});

	it('routes every step to a real product route', () => {
		expect(DEMO_STEP_COUNT).toBeGreaterThan(0);
		for (const step of DEMO_STEPS) {
			expect(['stitch-map', 'annotate-course', 'map-round', 'create-graphics']).toContain(step.route);
			expect(demoStepUrl(step)).toBe(`/${step.route}`);
			expect(step.actions.length).toBeGreaterThan(0);
		}
	});

	it('tells the whole build-once, reuse-for-a-round story in six steps', () => {
		expect(DEMO_STEP_COUNT).toBe(6);
		expect(DEMO_STEPS.map((step) => step.id)).toEqual([
			'stitch',
			'annotate-course',
			'basemap-and-export',
			'reload',
			'map-round',
			'export-round'
		]);
	});

	it('visits Annotate Course once for course geometry and Map Round once for a played round, each armed appropriately', () => {
		// The pre-split script visited a single shared /annotate-round route
		// twice; the split gives each activity its own route, visited once.
		expect(DEMO_STEPS.filter((step) => step.route === 'annotate-course')).toHaveLength(1);
		expect(DEMO_STEPS.filter((step) => step.route === 'map-round')).toHaveLength(1);

		const mapStep = stepById('annotate-course');
		expect(mapStep.route).toBe('annotate-course');
		expect(mapStep.arming).toEqual({ kind: 'none' });

		const roundStep = stepById('map-round');
		expect(roundStep.route).toBe('map-round');
		expect(roundStep.arming).toEqual({ kind: 'annotate-source' });
	});

	it('visits Create Graphics twice — once before the reload, once after', () => {
		const createGraphicsSteps = DEMO_STEPS.filter((step) => step.route === 'create-graphics');
		expect(createGraphicsSteps.map((step) => step.id)).toEqual([
			'basemap-and-export',
			'reload',
			'export-round'
		]);
	});

	it('marks exactly one step as a reload step, positioned between the two halves of the script', () => {
		const reloadSteps = DEMO_STEPS.filter((step) => step.kind === 'reload');
		expect(reloadSteps).toHaveLength(1);
		const reloadIndex = DEMO_STEPS.findIndex((step) => step.kind === 'reload');
		expect(reloadIndex).toBeGreaterThan(0);
		expect(reloadIndex).toBeLessThan(DEMO_STEP_COUNT - 1);
		// Its successor is the step that actually needs a fresh session to prove
		// anything — the played-round annotation.
		expect(DEMO_STEPS[reloadIndex + 1].id).toBe('map-round');
		// Every other step defaults to ordinary (undefined/'default') navigation.
		for (const step of DEMO_STEPS) {
			if (step.kind === 'reload') continue;
			expect(step.kind === undefined || step.kind === 'default').toBe(true);
		}
	});
});

describe('fetchDemoFile', () => {
	it('produces a File carrying the catalogued name and type, not the response header', async () => {
		const file = await fetchDemoFile(DEMO_DATASET.captures[0], okFetch());

		expect(file.name).toBe(DEMO_DATASET.captures[0].fileName);
		expect(file.type).toBe('image/png');
		expect(file.size).toBeGreaterThan(0);
	});

	it('reports a named, typed error for an HTTP failure and for an empty body', async () => {
		const notFound = (async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
		await expect(fetchDemoFile(DEMO_DATASET.captures[0], notFound)).rejects.toMatchObject({
			name: 'DemoAssetError',
			kind: 'http-error',
			fileName: DEMO_DATASET.captures[0].fileName
		});

		const empty = (async () =>
			new Response(new Uint8Array([]), { status: 200 })) as unknown as typeof fetch;
		await expect(fetchDemoFile(DEMO_DATASET.captures[0], empty)).rejects.toBeInstanceOf(
			DemoAssetError
		);
	});
});

describe('armDemoStep', () => {
	it('fills the Stitch Map inbox with all four captures in catalog order', async () => {
		const step = stepById('stitch');
		expect(stepHasArming(step)).toBe(true);

		const result = await armDemoStep(step, okFetch());

		expect(result.ok).toBe(true);
		const captures = takePendingStitchCaptures();
		expect(captures?.map((file) => file.name)).toEqual(
			DEMO_DATASET.captures.map((capture) => capture.fileName)
		);
		expect(takePendingStitchCaptures()).toBeNull();
	});

	it('leaves the inbox empty when one capture fails to load, rather than half-filling it', async () => {
		let calls = 0;
		const flaky = (async () => {
			calls += 1;
			return calls === 2
				? new Response(null, { status: 500 })
				: new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
		}) as unknown as typeof fetch;

		const result = await armDemoStep(stepById('stitch'), flaky);

		expect(result.ok).toBe(false);
		expect(getPendingStitchCaptures()).toBeNull();
	});

	it('is a no-op for the Annotate Course step: it relies on the product\'s own "Use as UDisc source" handoff, not demo arming', async () => {
		const spy = vi.fn();
		const step = stepById('annotate-course');

		expect(stepHasArming(step)).toBe(false);
		const result = await armDemoStep(step, spy as unknown as typeof fetch);

		expect(result.ok).toBe(true);
		expect(spy).not.toHaveBeenCalled();
		expect(getPendingHandoff()).toBeNull();
	});

	it('publishes the played-round capture through the product handoff store for the Map Round annotate step', async () => {
		const result = await armDemoStep(stepById('map-round'), okFetch());

		expect(result.ok).toBe(true);
		const handoff = getPendingHandoff();
		expect(handoff?.targetRole).toBe('source-overview');
		expect(handoff?.destination).toBe('map-round');
		expect(handoff?.fileName).toBe(DEMO_DATASET.roundOverview.fileName);
	});

	// Both roles, because the handoff store is a single shared slot: a waiting
	// `target-basemap` export is destroyed by publishing a `source-overview`
	// sample just as surely as a same-role one would be. Guarding only the role
	// this step happens to use left the visitor's "Use as clean basemap" stitch
	// silently discarded.
	it.each([
		['source-overview', 'annotate-course'],
		['target-basemap', 'create-graphics']
	] as const)(
		"never overwrites a pending %s handoff the visitor's own work placed",
		async (targetRole, destination) => {
			setPendingHandoff({
				blob: new Blob([new Uint8Array([1])], { type: 'image/png' }),
				fileName: 'my-own-stitch.png',
				targetRole,
				destination
			});
			const spy = vi.fn();

			const result = await armDemoStep(stepById('map-round'), spy as unknown as typeof fetch);

			expect(result.ok).toBe(true);
			expect(spy).not.toHaveBeenCalled();
			expect(getPendingHandoff()?.fileName).toBe('my-own-stitch.png');
			expect(getPendingHandoff()?.targetRole).toBe(targetRole);
		}
	);

	it('notifies a mounted destination when a handoff is published', async () => {
		const seen: string[] = [];
		const unsubscribe = subscribePendingHandoff(() => {
			seen.push(getPendingHandoff()?.fileName ?? '');
		});

		await armDemoStep(stepById('map-round'), okFetch());
		unsubscribe();
		const afterUnsubscribe = seen.length;
		setPendingHandoff({
			blob: new Blob([new Uint8Array([1])], { type: 'image/png' }),
			fileName: 'later.png',
			targetRole: 'source-overview',
			destination: 'map-round'
		});

		expect(seen).toEqual([DEMO_DATASET.roundOverview.fileName]);
		expect(seen.length).toBe(afterUnsubscribe);
	});

	it('notifies a mounted Stitch Map when captures are deposited', async () => {
		let notified = 0;
		const unsubscribe = subscribePendingStitchCaptures(() => {
			notified += 1;
		});

		await armDemoStep(stepById('stitch'), okFetch());
		expect(notified).toBe(1);

		unsubscribe();
		await armDemoStep(stepById('stitch'), okFetch());
		expect(notified).toBe(1);
	});

	it('is a no-op for steps that run on the visitor’s own input', async () => {
		const spy = vi.fn();
		const step = stepById('basemap-and-export');

		expect(stepHasArming(step)).toBe(false);
		const result = await armDemoStep(step, spy as unknown as typeof fetch);

		expect(result.ok).toBe(true);
		expect(spy).not.toHaveBeenCalled();
		expect(getPendingStitchCaptures()).toBeNull();
		expect(getPendingHandoff()).toBeNull();
	});

	it('is a no-op for the reload step — it has nothing to preload, only a navigation to perform', async () => {
		const spy = vi.fn();
		const step = stepById('reload');

		expect(stepHasArming(step)).toBe(false);
		const result = await armDemoStep(step, spy as unknown as typeof fetch);

		expect(result.ok).toBe(true);
		expect(spy).not.toHaveBeenCalled();
	});
});

describe('DemoTour', () => {
	it('clamps navigation to the script and survives a reload through sessionStorage', () => {
		const tour = new DemoTour();
		tour.start();
		expect(tour.active).toBe(true);
		expect(tour.stepNumber).toBe(1);
		expect(tour.isFirst).toBe(true);

		tour.previous();
		expect(tour.stepIndex).toBe(0);

		tour.goTo(DEMO_STEP_COUNT + 10);
		expect(tour.stepIndex).toBe(DEMO_STEP_COUNT - 1);
		expect(tour.isLast).toBe(true);

		const reloaded = new DemoTour();
		reloaded.restore();
		expect(reloaded.active).toBe(true);
		expect(reloaded.stepIndex).toBe(DEMO_STEP_COUNT - 1);
	});

	it('forgets a tour that was exited, and ignores a corrupt stored position', () => {
		const tour = new DemoTour();
		tour.start(2);
		tour.exit();

		const afterExit = new DemoTour();
		afterExit.restore();
		expect(afterExit.active).toBe(false);

		sessionStorage.setItem('chainspot.demo.tour', '{"active":true,"stepIndex":999}');
		const afterCorruption = new DemoTour();
		afterCorruption.restore();
		expect(afterCorruption.active).toBe(false);
		expect(afterCorruption.stepIndex).toBe(0);
	});

	/**
	 * `DemoTour` owns no navigation of its own — `DemoGuide`'s `reloadAndAdvance`
	 * is what actually calls `window.location.assign`, which is real browser
	 * navigation this suite cannot exercise in jsdom. What *is* testable here,
	 * and is exactly the mechanism the reload step depends on, is that advancing
	 * the cursor past the reload step persists to `sessionStorage` before any
	 * navigation would fire, so a brand new `DemoTour` instance — standing in for
	 * the page that comes back after a real reload — restores onto the reload
	 * step's successor rather than snapping back to the reload step itself.
	 */
	it('resumes on the reload step\'s successor, simulating what a real reload leaves behind', () => {
		const reloadIndex = DEMO_STEPS.findIndex((step) => step.kind === 'reload');
		expect(reloadIndex).toBeGreaterThanOrEqual(0);

		const tour = new DemoTour();
		tour.start(reloadIndex);
		expect(tour.step.kind).toBe('reload');

		// Mirrors DemoGuide.reloadAndAdvance: advance the cursor (persisting the
		// *next* step to sessionStorage), then — in the real component — reload.
		const next = tour.goTo(reloadIndex + 1);
		expect(next.id).toBe('map-round');
		expect(next.route).toBe('map-round');

		const afterReload = new DemoTour();
		afterReload.restore();
		expect(afterReload.active).toBe(true);
		expect(afterReload.stepIndex).toBe(reloadIndex + 1);
		expect(afterReload.step.id).toBe('map-round');
	});
});
