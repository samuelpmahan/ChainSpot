// @vitest-environment jsdom

/**
 * CHSPT-65 — completion-panel continuation to Create Graphics, isolated from
 * the pointer-placement machinery.
 *
 * These tests deliberately do NOT drive map clicks: the pre-existing pointer
 * helpers in `annotateCourseSidebar.test.ts` are currently red (the browser
 * flow accepts a placement with click + Tab while those helpers assume a
 * click advances), and a regression that can only run on top of a broken
 * path proves nothing. Instead the editor is injected with fully-placed
 * holes (the same seeding a reopened draft uses — `holes` initializes from
 * `editor.state.holes`, unconfirmed), and confirmation goes through the two
 * plain DOM buttons the sidebar already exposes: the hole box and Approve.
 * What is asserted is exactly what CHSPT-65 changed:
 *
 *   confirmed course → completion panel → Continue to Create Graphics →
 *   pending AnnotatedRound published → navigation to /create-graphics
 *
 * at both 18/18 and 9/9, plus the guard that a 9-hole completion cannot
 * contradict confirmed work on holes 10+.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';

const { mockGoto } = vi.hoisted(() => ({ mockGoto: vi.fn() }));
vi.mock('$app/navigation', () => ({ goto: mockGoto }));

import AnnotationWorkspace from '../../src/lib/components/AnnotationWorkspace.svelte';
import { ProjectEditor } from '../../src/lib/domain/editor';
import { createImageAsset, createProjectState } from '../../src/lib/domain/project';
import type { AnnotatedHole } from '../../src/lib/domain/project';
import type { DecodeImageFile } from '../../src/lib/imageIntake';
import {
	consumePendingAnnotatedRound,
	consumePendingCourseBadges,
	getPendingAnnotatedRound
} from '../../src/lib/session';

const NOW = () => new Date('2026-08-17T00:00:00.000Z');

function decodeOf(widthPx: number, heightPx: number): DecodeImageFile {
	return async () => ({ image: document.createElement('img'), widthPx, heightPx });
}

/** Fully-placed hole `number`, coordinates spread inside a 400x400 image. */
function placedHole(number: number): AnnotatedHole {
	const col = (number - 1) % 6;
	const row = Math.floor((number - 1) / 6);
	return {
		id: `hole-${number}`,
		number,
		tee: { xPx: 20 + col * 60, yPx: 20 + row * 90 },
		basket: { xPx: 20 + col * 60, yPx: 50 + row * 90 },
		shots: [],
		corridorBends: [],
		corridorWidthPx: 20
	};
}

/** Editor pre-seeded with a source image and `holeCount` fully-placed (unconfirmed) holes. */
function makeEditor(holeCount: number): ProjectEditor {
	const base = createProjectState({ createId: () => 'project-1', now: NOW });
	const source = createImageAsset({
		id: 'source-1',
		role: 'source-overview',
		fileName: 'course.png',
		mimeType: 'image/png',
		widthPx: 400,
		heightPx: 400
	});
	const holes = Array.from({ length: holeCount }, (_, index) => placedHole(index + 1));
	return new ProjectEditor({
		state: { ...base, images: [source], holes },
		assets: new Map([
			['source-1', { bytes: new Uint8Array([1, 2, 3, 4]), decoded: document.createElement('img') }]
		]),
		now: NOW
	});
}

interface Mounted {
	component: ReturnType<typeof mount>;
	host: HTMLDivElement;
}

function mountWorkspace(editor: ProjectEditor): Mounted {
	const host = document.createElement('div');
	document.body.appendChild(host);
	const component = mount(AnnotationWorkspace, {
		target: host,
		props: { mode: 'map', sessionKey: 'annotate-course', editor, decode: decodeOf(400, 400) }
	});
	return { component, host };
}

async function flush(): Promise<void> {
	for (let i = 0; i < 12; i += 1) {
		await tick();
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

function click(host: HTMLElement, testId: string): void {
	const button = host.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
	if (!button) throw new Error(`missing ${testId}`);
	button.click();
}

/** Confirms holes `1..count` through the sidebar's own DOM buttons: select the hole box, press Approve. No pointer events involved. */
async function approveHoles(host: HTMLElement, count: number): Promise<void> {
	for (let number = 1; number <= count; number += 1) {
		click(host, `sidebar-hole-${number}`);
		await flush();
		click(host, 'approve-hole-button');
		await flush();
	}
}

let mounted: Mounted | null = null;

afterEach(() => {
	if (mounted) {
		unmount(mounted.component);
		mounted.host.remove();
		mounted = null;
	}
	consumePendingAnnotatedRound();
	consumePendingCourseBadges();
	mockGoto.mockClear();
});

describe('CHSPT-65 completion handoff — 18/18', () => {
	it('offers Continue to Create Graphics alongside the unchanged Save/Map Round actions, and drives handleDone', async () => {
		mounted = mountWorkspace(makeEditor(18));
		const { host } = mounted;
		await flush();

		// All 18 seeded holes sit in "needs review" — no completion panel yet.
		expect(host.querySelector('[data-testid="course-complete-panel"]')).toBeNull();

		await approveHoles(host, 18);

		// The guided bends phase still gates completion, exactly as before.
		expect(host.querySelector('[data-testid="bend-phase-panel"]')).not.toBeNull();
		click(host, 'finish-bends');
		await flush();

		const panel = host.querySelector('[data-testid="course-complete-panel"]');
		expect(panel).not.toBeNull();
		expect(panel?.textContent).toContain('All 18 holes');

		// Pre-existing actions unchanged: save present, map-round present and
		// still gated on saving first.
		expect(host.querySelector('[data-testid="save-course-to-memory"]')).not.toBeNull();
		const mapRound = host.querySelector<HTMLButtonElement>('[data-testid="map-round-from-course"]');
		expect(mapRound).not.toBeNull();
		expect(mapRound?.disabled).toBe(true);

		// The new continuation is offered ungated (handleDone does its own
		// best-effort Course Memory save).
		const cont = host.querySelector<HTMLButtonElement>('[data-testid="continue-to-create-graphics"]');
		expect(cont).not.toBeNull();
		expect(cont?.disabled).toBe(false);
		expect(getPendingAnnotatedRound()).toBeNull();

		cont?.click();
		await flush();

		const pending = getPendingAnnotatedRound();
		expect(pending).not.toBeNull();
		expect(pending?.holes).toHaveLength(18);
		expect(pending?.sourceImage.fileName).toBe('course.png');
		expect(mockGoto).toHaveBeenCalledTimes(1);
		expect(mockGoto).toHaveBeenCalledWith('/create-graphics');
	});
});

describe('CHSPT-65 completion handoff — 9/9', () => {
	it('a 9-hole course completes at 9/9 and continues to Create Graphics — 18/18 is not the only completion state', async () => {
		mounted = mountWorkspace(makeEditor(9));
		const { host } = mounted;
		await flush();

		click(host, 'course-length-9');
		await flush();

		// The grid scopes to 1-9; hole 10 has no box at all.
		expect(host.querySelector('[data-testid="sidebar-hole-9"]')).not.toBeNull();
		expect(host.querySelector('[data-testid="sidebar-hole-10"]')).toBeNull();

		await approveHoles(host, 9);

		expect(host.querySelector('[data-testid="bend-phase-panel"]')).not.toBeNull();
		click(host, 'finish-bends');
		await flush();

		const panel = host.querySelector('[data-testid="course-complete-panel"]');
		expect(panel).not.toBeNull();
		expect(panel?.textContent).toContain('All 9 holes');

		click(host, 'continue-to-create-graphics');
		await flush();

		const pending = getPendingAnnotatedRound();
		expect(pending).not.toBeNull();
		expect(pending?.holes).toHaveLength(9);
		expect(mockGoto).toHaveBeenCalledWith('/create-graphics');
	});
});

describe('bends progress tracker (owner report: 3rd Tab / Approve must accept a zero-bend hole)', () => {
	it('a hole approved with zero bend edits shows as bends-accepted in the guided bends panel', async () => {
		mounted = mountWorkspace(makeEditor(9));
		const { host } = mounted;
		await flush();

		click(host, 'course-length-9');
		await flush();

		// Every hole approved through the same one gesture (Tab on BENDS / the
		// Approve button both call approveHolePieces) -- none has a placed or
		// moved bend, matching the owner's "unless you placed/moved one" report.
		await approveHoles(host, 9);

		expect(host.querySelector('[data-testid="bend-phase-panel"]')).not.toBeNull();
		const indicator = host.querySelector('[data-testid="bend-phase-hole-1"] .tb span');
		expect(indicator).not.toBeNull();
		expect(indicator?.className).toContain('confirmed');
	});
});

describe('CHSPT-65 course-length contradiction guard', () => {
	it('blocks selecting 9 holes once holes beyond 9 have confirmed placements', async () => {
		mounted = mountWorkspace(makeEditor(18));
		const { host } = mounted;
		await flush();

		// Unconfirmed holes 10-18 (CV-proposal-like state) do NOT block the choice.
		expect(
			host.querySelector<HTMLButtonElement>('[data-testid="course-length-9"]')?.disabled
		).toBe(false);

		// Confirm one hole beyond 9: the 9-hole choice must now be blocked, so a
		// contradictory "All 9 holes" completion can never render while
		// confirmed work exists above 9 (handleDone exports ALL holes).
		click(host, 'sidebar-hole-10');
		await flush();
		click(host, 'approve-hole-button');
		await flush();

		expect(
			host.querySelector<HTMLButtonElement>('[data-testid="course-length-9"]')?.disabled
		).toBe(true);
	});
});
