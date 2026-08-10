/**
 * Guided-demo unit coverage.
 *
 * The demo's value is entirely in its honesty, so these tests guard the two
 * claims that would be embarrassing to break in front of a prospective
 * customer: that every armed input is a real supported image handed to a real
 * intake path, and that arming never silently discards work the visitor already
 * produced.
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
import {
	clearPendingStitchCaptures,
	getPendingStitchCaptures,
	takePendingStitchCaptures
} from '../../src/lib/demo/stageInbox';
import { DemoTour } from '../../src/lib/demo/tour.svelte';
import { consumePendingHandoff, getPendingHandoff, setPendingHandoff } from '../../src/lib/stitch/handoff';
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
		const assets = [...DEMO_DATASET.captures, DEMO_DATASET.overview];
		expect(assets.length).toBe(5);
		for (const asset of assets) {
			expect(SUPPORTED_MIME_TYPES).toContain(asset.mimeType);
			expect(asset.path.startsWith('/resources/demo/')).toBe(true);
			expect(demoAssetUrl(asset)).toBe(asset.path);
		}
	});

	it('supplies exactly the four captures Smart Import requires, with no grid position in their names', () => {
		expect(DEMO_DATASET.captures).toHaveLength(4);
		const names = DEMO_DATASET.captures.map((capture) => capture.fileName);
		expect(new Set(names).size).toBe(4);
		for (const name of names) {
			expect(name).not.toMatch(/upper|lower|left|right|top|bottom|\b(tl|tr|bl|br)\b/i);
		}
	});

	it('routes every step to a real product route', () => {
		expect(DEMO_STEP_COUNT).toBeGreaterThan(0);
		for (const step of DEMO_STEPS) {
			expect(['stitch-map', 'annotate-round', 'create-graphics']).toContain(step.route);
			expect(demoStepUrl(step)).toBe(`/${step.route}`);
			expect(step.actions.length).toBeGreaterThan(0);
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

	it('publishes the sample source through the product handoff store', async () => {
		const result = await armDemoStep(stepById('annotate'), okFetch());

		expect(result.ok).toBe(true);
		const handoff = getPendingHandoff();
		expect(handoff?.targetRole).toBe('source-overview');
		expect(handoff?.fileName).toBe(DEMO_DATASET.overview.fileName);
	});

	it("never overwrites a handoff the visitor's own stitch already placed", async () => {
		setPendingHandoff({
			blob: new Blob([new Uint8Array([1])], { type: 'image/png' }),
			fileName: 'my-own-stitch.png',
			targetRole: 'source-overview'
		});
		const spy = vi.fn();

		const result = await armDemoStep(stepById('annotate'), spy as unknown as typeof fetch);

		expect(result.ok).toBe(true);
		expect(spy).not.toHaveBeenCalled();
		expect(getPendingHandoff()?.fileName).toBe('my-own-stitch.png');
	});

	it('is a no-op for steps that run on the visitor’s own input', async () => {
		const spy = vi.fn();
		const step = stepById('basemap');

		expect(stepHasArming(step)).toBe(false);
		const result = await armDemoStep(step, spy as unknown as typeof fetch);

		expect(result.ok).toBe(true);
		expect(spy).not.toHaveBeenCalled();
		expect(getPendingStitchCaptures()).toBeNull();
		expect(getPendingHandoff()).toBeNull();
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
});
