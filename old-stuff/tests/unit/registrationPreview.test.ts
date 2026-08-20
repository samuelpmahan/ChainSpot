// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import Page from '../../src/routes/create-graphics/+page.svelte';
import { ProjectEditor } from '../../src/lib/domain/editor';
import {
	createControlPointPair,
	createImageAsset,
	createProjectState
} from '../../src/lib/domain/project';
import type { AnnotatedHole } from '../../src/lib/domain/project';
import type { DecodeImageFile } from '../../src/lib/imageIntake';
import type { GhostCourseHole, MarkerHitResult } from '../../src/lib/scene';
import { estimateAffine } from '../../src/lib/alignment/affine';
import { estimateSimilarity } from '../../src/lib/alignment/similarity';
import type { AlignmentPairInput } from '../../src/lib/alignment/types';
import { planHoleGraphic } from '../../src/lib/holeGraphics';

/**
 * Browser-free coverage for the live registration preview (P1-006): the
 * target/NAIP pane's ghost-course overlay derived from `alignmentResult` +
 * the confirmed holes. `holeGraphics.test.ts` and `alignment.test.ts` already
 * cover the underlying projection and estimation math; what's new here is the
 * route-level wiring — that the target pane (and only the target pane) gets
 * handed exactly the live-recomputed geometry as correspondences change.
 */

const NOW = () => new Date('2026-08-16T00:00:00.000Z');

const sceneMock = vi.hoisted(() => ({
	rasterLayer: {},
	ghostCourseLayer: {},
	controlPointLayer: {},
	interactionLayer: {},
	controlPointGroup: {},
	setImage: vi.fn(),
	applyTransform: vi.fn(),
	setMarkers: vi.fn(),
	setMarkersVisible: vi.fn(),
	setGhostCourse: vi.fn(),
	setGhostCourseVisible: vi.fn(),
	setStageSize: vi.fn(),
	markerHitAt: vi.fn(() => null as MarkerHitResult | null),
	clearImage: vi.fn(),
	destroy: vi.fn()
}));

vi.mock('../../src/lib/scene', () => ({
	canvas2dAvailable: () => true,
	createPaneScene: () => sceneMock
}));

function decodeOf(widthPx: number, heightPx: number): DecodeImageFile {
	return async () => ({ image: document.createElement('img'), widthPx, heightPx });
}

const HOLE: AnnotatedHole = {
	id: 'hole-1',
	number: 1,
	tee: { xPx: 5, yPx: 5 },
	basket: { xPx: 90, yPx: 40 },
	shots: [],
	corridorBends: [{ xPx: 45, yPx: 20 }],
	corridorWidthPx: 20
};

interface RawPair {
	source: { xPx: number; yPx: number };
	target: { xPx: number; yPx: number };
	enabled?: boolean;
}

function makeEditor(pairs: RawPair[] = [], holes: readonly AnnotatedHole[] = [HOLE]): ProjectEditor {
	const base = createProjectState({ createId: () => 'project-1', now: NOW });
	const source = createImageAsset({
		id: 'source-1',
		role: 'source-overview',
		fileName: 'source.png',
		mimeType: 'image/png',
		widthPx: 200,
		heightPx: 100
	});
	const target = createImageAsset({
		id: 'target-1',
		role: 'target-basemap',
		fileName: 'target.png',
		mimeType: 'image/png',
		widthPx: 400,
		heightPx: 300
	});
	const controlPointPairs = pairs.map((pair, index) =>
		createControlPointPair({
			id: `pair-${index + 1}`,
			ordinal: index + 1,
			sourceImage: source,
			targetImage: target,
			sourceCoordinates: pair.source,
			targetCoordinates: pair.target,
			label: null,
			enabled: pair.enabled ?? true,
			now: NOW
		})
	);
	return new ProjectEditor({
		state: { ...base, images: [source, target], controlPointPairs, holes: [...holes] },
		assets: new Map([
			['source-1', { bytes: new Uint8Array([1]), decoded: document.createElement('img') }],
			['target-1', { bytes: new Uint8Array([2]), decoded: document.createElement('img') }]
		]),
		now: NOW
	});
}

interface Mounted {
	editor: ProjectEditor;
	component: ReturnType<typeof mount>;
	host: HTMLDivElement;
}

function mountPage(editor: ProjectEditor): Mounted {
	const host = document.createElement('div');
	document.body.appendChild(host);
	const component = mount(Page, { target: host, props: { editor, decode: decodeOf(200, 100) } });
	return { editor, component, host };
}

async function flush(): Promise<void> {
	for (let i = 0; i < 10; i += 1) {
		await tick();
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

function setGeometry(host: HTMLElement, role: 'source-overview' | 'target-basemap'): void {
	const scene = host.querySelector<HTMLElement>(`[data-testid="pane-scene-${role}"]`);
	if (!scene) throw new Error(`missing scene for ${role}`);
	Object.defineProperties(scene, {
		clientWidth: { configurable: true, value: 1 },
		clientHeight: { configurable: true, value: 1 },
		clientLeft: { configurable: true, value: 0 },
		clientTop: { configurable: true, value: 0 }
	});
	scene.getBoundingClientRect = () =>
		({ left: 0, top: 0, width: 1, height: 1, right: 1, bottom: 1 }) as DOMRect;
}

function ghostCourseCount(host: HTMLElement, role: 'source-overview' | 'target-basemap'): number {
	const pane = host.querySelector<HTMLElement>(`[data-testid="pane-${role}"]`);
	if (!pane) throw new Error(`missing pane for ${role}`);
	return Number(pane.dataset.ghostCourseCount);
}

/**
 * The most recent non-empty `setGhostCourse` call. Both panes share this one
 * mocked scene object (see the `vi.mock` above), but the source pane's own
 * `ghostCourse` prop always defaults to `[]` — it never receives hole
 * geometry — so any call with at least one hole is unambiguously the target
 * pane's.
 */
function latestGhostCourse(): readonly GhostCourseHole[] | null {
	const calls = sceneMock.setGhostCourse.mock.calls;
	for (let i = calls.length - 1; i >= 0; i -= 1) {
		const holes = calls[i][0] as readonly GhostCourseHole[];
		if (holes.length > 0) return holes;
	}
	return null;
}

function alignmentPairsFrom(pairs: RawPair[]): AlignmentPairInput[] {
	return pairs.map((pair, index) => ({
		id: `pair-${index + 1}`,
		enabled: pair.enabled ?? true,
		source: pair.source,
		target: pair.target
	}));
}

/** Same target-space projection the route uses, called directly for an independent expected value. */
function expectedGhostHoles(
	pairs: RawPair[],
	model: 'similarity' | 'affine',
	holes: readonly AnnotatedHole[] = [HOLE]
): GhostCourseHole[] {
	const alignmentPairs = alignmentPairsFrom(pairs);
	const result =
		model === 'affine' ? estimateAffine({ pairs: alignmentPairs }) : estimateSimilarity({ pairs: alignmentPairs });
	if (!('transform' in result)) throw new Error('expected a valid transform for this fixture');
	const plans = holes
		.map((hole) => planHoleGraphic(hole, result.transform, 400, 300))
		.filter((plan): plan is NonNullable<typeof plan> => plan !== null);
	return plans;
}

afterEach(() => {
	vi.clearAllMocks();
	document.body.replaceChildren();
});

// Two pairs exactly determine a similarity transform (pure 2x scale + translation).
const SIMILARITY_PAIRS: RawPair[] = [
	{ source: { xPx: 0, yPx: 0 }, target: { xPx: 100, yPx: 50 } },
	{ source: { xPx: 10, yPx: 0 }, target: { xPx: 120, yPx: 50 } }
];

// A third, non-collinear pair with a mild shear makes affine exactly determined too.
const AFFINE_PAIRS: RawPair[] = [
	...SIMILARITY_PAIRS,
	{ source: { xPx: 0, yPx: 10 }, target: { xPx: 105, yPx: 65 } }
];

describe('live registration preview: target-pane ghost course overlay', () => {
	it('renders no ghost overlay before alignment has enough evidence', async () => {
		const editor = makeEditor([]);
		const { component, host } = mountPage(editor);
		setGeometry(host, 'source-overview');
		setGeometry(host, 'target-basemap');
		await flush();

		expect(ghostCourseCount(host, 'target-basemap')).toBe(0);
		expect(ghostCourseCount(host, 'source-overview')).toBe(0);
		expect(latestGhostCourse()).toBeNull();

		unmount(component);
	});

	it('projects tee/basket/bends/corridor band onto the target pane for a valid similarity transform', async () => {
		const editor = makeEditor(SIMILARITY_PAIRS);
		const { component, host } = mountPage(editor);
		setGeometry(host, 'source-overview');
		setGeometry(host, 'target-basemap');
		await flush();

		const expected = expectedGhostHoles(SIMILARITY_PAIRS, 'similarity');
		expect(expected).toHaveLength(1);

		expect(ghostCourseCount(host, 'target-basemap')).toBe(1);
		expect(ghostCourseCount(host, 'source-overview')).toBe(0);

		const holes = latestGhostCourse();
		expect(holes).toEqual(expected);
		// Sanity-check the actual numbers against the known 2x-scale + translate transform.
		expect(holes![0].tee).toEqual({ xPx: 5 * 2 + 100, yPx: 5 * 2 + 50 });
		expect(holes![0].basket).toEqual({ xPx: 90 * 2 + 100, yPx: 40 * 2 + 50 });
		expect(holes![0].number).toBe(1);

		unmount(component);
	});

	it('projects the same geometry correctly for a valid affine transform', async () => {
		const editor = makeEditor(AFFINE_PAIRS);
		const { component, host } = mountPage(editor);
		setGeometry(host, 'source-overview');
		setGeometry(host, 'target-basemap');
		await flush();

		host.querySelector<HTMLInputElement>('[data-testid="alignment-model-affine"]')?.click();
		await flush();

		const expected = expectedGhostHoles(AFFINE_PAIRS, 'affine');
		expect(ghostCourseCount(host, 'target-basemap')).toBe(1);
		expect(latestGhostCourse()).toEqual(expected);

		unmount(component);
	});

	it('updates the whole overlay when a correspondence pair changes', async () => {
		const editor = makeEditor(SIMILARITY_PAIRS);
		const { component, host } = mountPage(editor);
		setGeometry(host, 'source-overview');
		setGeometry(host, 'target-basemap');
		await flush();

		const before = latestGhostCourse();
		expect(before).toEqual(expectedGhostHoles(SIMILARITY_PAIRS, 'similarity'));

		vi.clearAllMocks();

		// Move the second pair's target point through the real point-inspector edit
		// path (select side, edit x/y, apply) rather than mutating the editor
		// directly — the route only recomputes derived state in response to its
		// own handlers, exactly as a real correspondence edit would.
		const movedPairs: RawPair[] = [
			SIMILARITY_PAIRS[0],
			{ source: { xPx: 10, yPx: 0 }, target: { xPx: 140, yPx: 60 } }
		];
		const secondPairId = editor.state.controlPointPairs[1].id;
		host.querySelector<HTMLButtonElement>(`[data-testid="pair-target-${secondPairId}"]`)?.click();
		await flush();
		const xInput = host.querySelector<HTMLInputElement>('[data-testid="point-x"]');
		const yInput = host.querySelector<HTMLInputElement>('[data-testid="point-y"]');
		if (!xInput || !yInput) throw new Error('missing point inspector inputs');
		xInput.value = String(movedPairs[1].target.xPx);
		xInput.dispatchEvent(new Event('input', { bubbles: true }));
		yInput.value = String(movedPairs[1].target.yPx);
		yInput.dispatchEvent(new Event('input', { bubbles: true }));
		host.querySelector<HTMLButtonElement>('[data-testid="point-apply"]')?.click();
		await flush();

		const after = latestGhostCourse();
		expect(after).toEqual(expectedGhostHoles(movedPairs, 'similarity'));
		expect(after).not.toEqual(before);

		unmount(component);
	});

	it('removes the target-pane preview once disabling a pair drops below the minimum for similarity', async () => {
		const editor = makeEditor(SIMILARITY_PAIRS);
		const { component, host } = mountPage(editor);
		setGeometry(host, 'source-overview');
		setGeometry(host, 'target-basemap');
		await flush();
		expect(ghostCourseCount(host, 'target-basemap')).toBe(1);

		host.querySelector<HTMLInputElement>('[data-testid="pair-enabled-pair-2"]')?.click();
		await flush();

		expect(ghostCourseCount(host, 'target-basemap')).toBe(0);

		unmount(component);
	});

	it('removes the target-pane preview once deleting a pair drops below the minimum for similarity', async () => {
		const editor = makeEditor(SIMILARITY_PAIRS);
		const { component, host } = mountPage(editor);
		setGeometry(host, 'source-overview');
		setGeometry(host, 'target-basemap');
		await flush();
		expect(ghostCourseCount(host, 'target-basemap')).toBe(1);

		host.querySelector<HTMLButtonElement>('[data-testid="pair-delete-pair-2"]')?.click();
		await flush();

		expect(ghostCourseCount(host, 'target-basemap')).toBe(0);
		expect(host.querySelector('[data-testid="alignment-failure"]')).toBeTruthy();

		unmount(component);
	});

	it('recomputes from source geometry on model switch rather than transforming the previous preview', async () => {
		const editor = makeEditor(AFFINE_PAIRS);
		const { component, host } = mountPage(editor);
		setGeometry(host, 'source-overview');
		setGeometry(host, 'target-basemap');
		await flush();

		const similarityFirst = latestGhostCourse();
		expect(similarityFirst).toEqual(expectedGhostHoles(AFFINE_PAIRS, 'similarity'));

		host.querySelector<HTMLInputElement>('[data-testid="alignment-model-affine"]')?.click();
		await flush();
		const affine = latestGhostCourse();
		expect(affine).toEqual(expectedGhostHoles(AFFINE_PAIRS, 'affine'));
		expect(affine).not.toEqual(similarityFirst);

		host.querySelector<HTMLInputElement>('[data-testid="alignment-model-similarity"]')?.click();
		await flush();
		const similarityAgain = latestGhostCourse();
		// Switching back reproduces the ORIGINAL similarity projection exactly — if the
		// implementation had transformed the affine-space preview instead of
		// recomputing fresh from the untouched source geometry, this would drift.
		expect(similarityAgain).toEqual(similarityFirst);
		expect(similarityAgain).toEqual(expectedGhostHoles(AFFINE_PAIRS, 'similarity'));

		unmount(component);
	});

	it('hides the overlay via the dedicated toggle without touching correspondence markers or diagnostics', async () => {
		const editor = makeEditor(SIMILARITY_PAIRS);
		const { component, host } = mountPage(editor);
		setGeometry(host, 'source-overview');
		setGeometry(host, 'target-basemap');
		await flush();
		expect(ghostCourseCount(host, 'target-basemap')).toBe(1);

		const toggle = host.querySelector<HTMLButtonElement>('[data-testid="toggle-ghost-course"]');
		expect(toggle).toBeTruthy();
		expect(toggle?.getAttribute('aria-pressed')).toBe('true');

		toggle?.click();
		await flush();

		expect(toggle?.getAttribute('aria-pressed')).toBe('false');
		expect(ghostCourseCount(host, 'target-basemap')).toBe(0);
		// Markers and alignment diagnostics are unaffected by the ghost toggle.
		expect(host.querySelector('[data-testid="toggle-markers"]')?.getAttribute('aria-pressed')).toBe('true');
		expect(host.querySelector('[data-testid="alignment-summary"]')).toBeTruthy();

		unmount(component);
	});
});
