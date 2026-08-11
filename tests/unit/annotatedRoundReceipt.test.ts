// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import Page from '../../src/routes/create-graphics/+page.svelte';
import { ProjectEditor } from '../../src/lib/domain/editor';
import { createProjectState } from '../../src/lib/domain/project';
import type { DecodeImageFile } from '../../src/lib/imageIntake';
import { intakeImageFile } from '../../src/lib/imageIntake';
import {
	consumePendingAnnotatedRound,
	getActiveAnnotatedRound,
	getPendingAnnotatedRound,
	setPendingAnnotatedRound,
	consumePendingCourseBadges,
	getPendingCourseBadges,
	setPendingCourseBadges,
	retainEditor,
	takeRetainedEditor
} from '../../src/lib/session';
import { createAnnotatedRound } from '../../src/lib/domain/annotatedRound';
import type { AnnotatedRound } from '../../src/lib/domain/annotatedRound';

const NOW = () => new Date('2026-08-06T00:00:00.000Z');

function decodeOf(widthPx: number, heightPx: number): DecodeImageFile {
	return async () => ({ image: document.createElement('img'), widthPx, heightPx });
}

function makeEmptyEditor(): ProjectEditor {
	const state = createProjectState({ createId: () => 'project-1', now: NOW });
	return new ProjectEditor({ state, now: NOW });
}

interface Mounted {
	component: ReturnType<typeof mount>;
	host: HTMLDivElement;
}

/**
 * Mounts WITHOUT an injected editor (`participatesInSession` stays true), so
 * the page reads/writes the real module-level session slots exactly like
 * production — the only way to exercise the receipt logic gated on
 * `participatesInSession`. Any pre-existing project state must be arranged
 * beforehand via `retainEditor('create-graphics', ...)`, not an injected prop.
 */
function mountPage(decode: DecodeImageFile): Mounted {
	const host = document.createElement('div');
	document.body.appendChild(host);
	const component = mount(Page, { target: host, props: { decode } });
	return { component, host };
}

async function flush(): Promise<void> {
	for (let i = 0; i < 16; i += 1) {
		await tick();
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

function annotatedRoundOf(fileName: string, widthPx: number, heightPx: number): AnnotatedRound {
	return createAnnotatedRound({
		sourceImage: {
			fileName,
			mimeType: 'image/png',
			widthPx,
			heightPx,
			blob: new Blob([new Uint8Array([9, 9, 9])], { type: 'image/png' })
		}
	});
}

function textOf(host: HTMLElement, testId: string): string | null {
	return host.querySelector(`[data-testid="${testId}"]`)?.textContent ?? null;
}

afterEach(() => {
	document.body.replaceChildren();
	consumePendingAnnotatedRound();
	consumePendingCourseBadges();
});

describe('Create Graphics receipt of a pending AnnotatedRound (soft boundary)', () => {
	it('auto-intakes into an empty editor and clears/activates the session slots, but shows a banner instead of silently replacing an already-loaded source image', async () => {
		// Case 1: no source image loaded yet -> silent auto-intake on mount.
		const firstRound = annotatedRoundOf('udisc-round.png', 300, 200);
		setPendingAnnotatedRound(firstRound);
		const empty = mountPage(decodeOf(300, 200));
		await flush();

		expect(getPendingAnnotatedRound()).toBeNull();
		expect(getActiveAnnotatedRound()).toBe(firstRound);
		expect(textOf(empty.host, 'pane-filename-source-overview')).toBe('udisc-round.png');
		expect(
			empty.host.querySelector('[data-testid="app-shell"]')?.getAttribute('data-annotated-round')
		).toBe('present');
		expect(empty.host.querySelector('[data-testid="annotated-round-banner"]')).toBeNull();

		unmount(empty.component);
		empty.host.remove();

		// Case 2: a source image is already loaded -> never silently replaced;
		// the banner offers an explicit Import/Dismiss instead. The pre-loaded
		// editor is retained into the session slot (not injected as a prop) so
		// this mount still participates in the session and exercises the real
		// gated read path.
		const loadedEditor = makeEmptyEditor();
		const seedResult = await intakeImageFile({
			editor: loadedEditor,
			role: 'source-overview',
			file: new File([new Uint8Array([1, 2, 3])], 'already-loaded.png', { type: 'image/png' }),
			decode: decodeOf(50, 50)
		});
		if (!seedResult.ok) throw new Error('seed intake failed');
		retainEditor('create-graphics', loadedEditor);

		const secondRound = annotatedRoundOf('second-round.png', 400, 250);
		setPendingAnnotatedRound(secondRound);
		const loaded = mountPage(decodeOf(400, 250));
		await flush();

		expect(getPendingAnnotatedRound()).toBe(secondRound);
		// The active slot from case 1 is untouched by a mount that only banners.
		expect(getActiveAnnotatedRound()).toBe(firstRound);
		expect(textOf(loaded.host, 'pane-filename-source-overview')).toBe('already-loaded.png');
		const banner = loaded.host.querySelector('[data-testid="annotated-round-banner"]');
		expect(banner).not.toBeNull();
		expect(banner?.textContent).toContain('second-round.png');

		unmount(loaded.component);
		loaded.host.remove();
	});
});

describe('course badge/basket handoff (Course Memory)', () => {
	it('carries pending numberBadges into durable ProjectState on auto-intake, and consumes the slot', async () => {
		// A prior test in this file may leave an editor with a source image
		// already loaded retained under the 'create-graphics' key, which would
		// steer this mount onto the banner branch instead of auto-intake.
		takeRetainedEditor('create-graphics');
		const round = annotatedRoundOf('udisc-round.png', 300, 200);
		setPendingAnnotatedRound(round);
		setPendingCourseBadges({
			numberBadges: [
				{ number: 1, xPx: 10, yPx: 20, confidence: 0.91 },
				{ number: 2, xPx: 210, yPx: 40, confidence: 0.77 }
			],
			baskets: [{ holeNumber: 1, xPx: 280, yPx: 180 }]
		});

		const mounted = mountPage(decodeOf(300, 200));
		await flush();

		expect(getPendingCourseBadges()).toBeNull();

		unmount(mounted.component);
		mounted.host.remove();

		const retained = takeRetainedEditor('create-graphics');
		expect(retained?.state.numberBadges).toEqual([
			{ number: 1, xPx: 10, yPx: 20, confidence: 0.91 },
			{ number: 2, xPx: 210, yPx: 40, confidence: 0.77 }
		]);
	});

	it('leaves numberBadges empty when no course badges were pending', async () => {
		takeRetainedEditor('create-graphics');
		const round = annotatedRoundOf('udisc-round-2.png', 300, 200);
		setPendingAnnotatedRound(round);

		const mounted = mountPage(decodeOf(300, 200));
		await flush();
		unmount(mounted.component);
		mounted.host.remove();

		const retained = takeRetainedEditor('create-graphics');
		expect(retained?.state.numberBadges).toEqual([]);
	});
});
