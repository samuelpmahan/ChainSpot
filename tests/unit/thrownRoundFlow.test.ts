// @vitest-environment jsdom

/**
 * CHSPT-65 coverage — carrying the thrown-round source into Create Graphics.
 *
 * Three concerns, deliberately unit-scoped:
 *  1. The session slot's semantics: long-lived, replace-on-set, structurally
 *     independent from the clean-source pending-handoff slot (the invariant
 *     that neither role can silently replace the other).
 *  2. Create Graphics renders Fetch Clean Target ABOVE the correspondence
 *     panes exactly when the project carries annotated holes but no committed
 *     clean target, and keeps today's order for the direct-upload entry.
 *  3. The thrown-round note renders from the session slot without consuming
 *     it (a read, not a take).
 *
 * What this file does NOT prove (see the .task Proof Plan): that the
 * module-level slot survives real browser SPA navigation between routes —
 * jsdom mounts every page into one JS realm, so slot survival across mounts
 * here is necessary but not sufficient evidence. That handoff is flagged for
 * manual browser verification.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import Page from '../../src/routes/create-graphics/+page.svelte';
import { ProjectEditor } from '../../src/lib/domain/editor';
import { createProjectState } from '../../src/lib/domain/project';
import type { AnnotatedHole } from '../../src/lib/domain/project';
import type { DecodeImageFile } from '../../src/lib/imageIntake';
import {
	clearThrownRoundSource,
	consumePendingAnnotatedRound,
	consumePendingCourseBadges,
	consumePendingHandoff,
	getPendingHandoff,
	getThrownRoundSource,
	markCourseSourceIntake,
	setPendingHandoff,
	setPendingAnnotatedRound,
	setThrownRoundSource,
	takeRetainedEditor
} from '../../src/lib/session';
import { createAnnotatedRound } from '../../src/lib/domain/annotatedRound';

const NOW = () => new Date('2026-08-17T00:00:00.000Z');

function decodeOf(widthPx: number, heightPx: number): DecodeImageFile {
	return async () => ({ image: document.createElement('img'), widthPx, heightPx });
}

const HOLE: AnnotatedHole = {
	id: 'hole-1',
	number: 1,
	tee: { xPx: 5, yPx: 5 },
	basket: { xPx: 90, yPx: 40 },
	shots: [],
	corridorBends: [],
	corridorWidthPx: 20
};

function makeEditor(holes: readonly AnnotatedHole[] = []): ProjectEditor {
	const base = createProjectState({ createId: () => 'project-1', now: NOW });
	return new ProjectEditor({ state: { ...base, holes: [...holes] }, now: NOW });
}

interface Mounted {
	component: ReturnType<typeof mount>;
	host: HTMLDivElement;
}

/** Injected editor: `participatesInSession` false — session slots untouched. */
function mountInjected(editor: ProjectEditor): Mounted {
	const host = document.createElement('div');
	document.body.appendChild(host);
	const component = mount(Page, { target: host, props: { editor, decode: decodeOf(200, 100) } });
	return { component, host };
}

/** No injected editor: the page participates in the real module-level session. */
function mountParticipating(decode: DecodeImageFile = decodeOf(200, 100)): Mounted {
	const host = document.createElement('div');
	document.body.appendChild(host);
	const component = mount(Page, { target: host, props: { decode } });
	return { component, host };
}

async function flush(): Promise<void> {
	for (let i = 0; i < 8; i += 1) {
		await tick();
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

function thrownBlob(): Blob {
	return new Blob([new Uint8Array([7, 7, 7])], { type: 'image/png' });
}

function setFileInput(input: HTMLInputElement, file: File): void {
	Object.defineProperty(input, 'files', { configurable: true, value: [file] });
	input.dispatchEvent(new Event('change', { bubbles: true }));
}

/** True when `first` precedes `second` in document order. */
function precedes(first: Element, second: Element): boolean {
	return (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

afterEach(() => {
	document.body.replaceChildren();
	clearThrownRoundSource();
	consumePendingHandoff();
	consumePendingAnnotatedRound();
	consumePendingCourseBadges();
	takeRetainedEditor('create-graphics');
});

describe('thrown-round session slot (CHSPT-65)', () => {
	it('is long-lived, replace-on-set, and clearable', () => {
		expect(getThrownRoundSource()).toBeNull();

		setThrownRoundSource({ blob: thrownBlob(), fileName: 'round-a.png' });
		const first = getThrownRoundSource();
		expect(first?.fileName).toBe('round-a.png');
		// A read is not a take: the slot survives repeated reads.
		expect(getThrownRoundSource()).toBe(first);

		setThrownRoundSource({ blob: thrownBlob(), fileName: 'round-b.png' });
		expect(getThrownRoundSource()?.fileName).toBe('round-b.png');

		clearThrownRoundSource();
		expect(getThrownRoundSource()).toBeNull();
	});

	it('is independent of the clean-source pending-handoff slot in both directions', () => {
		setThrownRoundSource({ blob: thrownBlob(), fileName: 'thrown.png' });
		expect(getPendingHandoff()).toBeNull();

		setPendingHandoff({
			blob: new Blob([new Uint8Array([1])], { type: 'image/png' }),
			fileName: 'clean-map.png',
			targetRole: 'source-overview',
			destination: 'annotate-course'
		});
		expect(getThrownRoundSource()?.fileName).toBe('thrown.png');

		// Consuming the clean-source handoff (the destination importing it)
		// must not disturb the thrown round, and vice versa.
		consumePendingHandoff();
		expect(getThrownRoundSource()?.fileName).toBe('thrown.png');
		clearThrownRoundSource();
		expect(getPendingHandoff()).toBeNull();
	});

	it('is scoped to one course workflow: the first course intake attaches it, a second clears it as stale', () => {
		// Workflow A: keep round-A, then its clean course lands in Annotate
		// Course (intake #1) — the round attaches and survives.
		setThrownRoundSource({ blob: thrownBlob(), fileName: 'round-a.png' });
		markCourseSourceIntake();
		expect(getThrownRoundSource()?.fileName).toBe('round-a.png');

		// Workflow B: a new course lands (intake #2) with NO new thrown round
		// kept — round-A is stale leftover state and must not present itself as
		// workflow B's input.
		markCourseSourceIntake();
		expect(getThrownRoundSource()).toBeNull();

		// And a further intake with nothing kept stays a no-op.
		markCourseSourceIntake();
		expect(getThrownRoundSource()).toBeNull();
	});

	it('re-keeping between course intakes re-scopes the round to the next workflow', () => {
		setThrownRoundSource({ blob: thrownBlob(), fileName: 'round-a.png' });
		markCourseSourceIntake();
		// Same-workflow keep AFTER the course already arrived (order swapped):
		// the fresh keep detaches, so the next intake attaches instead of
		// clearing.
		setThrownRoundSource({ blob: thrownBlob(), fileName: 'round-b.png' });
		markCourseSourceIntake();
		expect(getThrownRoundSource()?.fileName).toBe('round-b.png');
	});
});

describe('Create Graphics: Fetch Clean Target ordering (CHSPT-65)', () => {
	it('renders the NAIP fetch section above the panes when holes exist with no committed clean target', async () => {
		const { component, host } = mountInjected(makeEditor([HOLE]));
		await flush();

		const naip = host.querySelector('[data-testid="naip-fetch"]');
		const panes = host.querySelector('section.panes');
		expect(naip).not.toBeNull();
		expect(panes).not.toBeNull();
		// Exactly one instance — the snippet renders in one position or the other.
		expect(host.querySelectorAll('[data-testid="naip-fetch"]')).toHaveLength(1);
		expect(precedes(naip as Element, panes as Element)).toBe(true);

		unmount(component);
		host.remove();
	});

	it('keeps the existing order (panes first) for the direct-upload entry with no annotation', async () => {
		const { component, host } = mountInjected(makeEditor());
		await flush();

		const naip = host.querySelector('[data-testid="naip-fetch"]');
		const panes = host.querySelector('section.panes');
		expect(naip).not.toBeNull();
		expect(panes).not.toBeNull();
		expect(host.querySelectorAll('[data-testid="naip-fetch"]')).toHaveLength(1);
		expect(precedes(panes as Element, naip as Element)).toBe(true);

		unmount(component);
		host.remove();
	});
});

describe('Create Graphics: thrown-round note (CHSPT-65)', () => {
	// Ordering note: this test must run BEFORE any test that imports an
	// AnnotatedRound — the active-round session slot has no clear API (it
	// deliberately survives route round trips), so a prior import in this file
	// would leak an active course into this mount and legitimately render the
	// note.
	it('renders no note for a direct-upload arrival (no annotated course), even with a leftover slot', async () => {
		// The note claims the round rides "with this course" — with no course
		// present, a leftover slot must not masquerade as this workflow's input.
		setThrownRoundSource({ blob: thrownBlob(), fileName: 'stale-round.png' });
		const { component, host } = mountParticipating();
		await flush();

		expect(host.querySelector('[data-testid="thrown-round-note"]')).toBeNull();

		unmount(component);
		host.remove();
	});

	it('shows the note when the annotated course arrives alongside it, without consuming the slot or touching the course source', async () => {
		// Both the thrown round and a pending AnnotatedRound arrive together —
		// the fresh-course flow. The note renders (visible confirmation the
		// round was carried through), the source pane receives the
		// AnnotatedRound image — never the thrown-round image — and the slot
		// remains available for the follow-up registration ticket.
		setThrownRoundSource({ blob: thrownBlob(), fileName: 'thrown-round.png' });
		setPendingAnnotatedRound(
			createAnnotatedRound({
				sourceImage: {
					fileName: 'udisc-course.png',
					mimeType: 'image/png',
					widthPx: 200,
					heightPx: 100,
					blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })
				}
			})
		);
		const { component, host } = mountParticipating();
		await flush();

		const note = host.querySelector('[data-testid="thrown-round-note"]');
		expect(note).not.toBeNull();
		expect(note?.textContent).toContain('thrown-round.png');
		expect(
			host.querySelector('section.panes [data-testid="pane-filename-source-overview"]')?.textContent
		).toBe('udisc-course.png');
		// Mounting read the slot; it did not take it.
		expect(getThrownRoundSource()?.fileName).toBe('thrown-round.png');

		unmount(component);
		host.remove();
	});

	it('renders no note when no thrown round was kept', async () => {
		const { component, host } = mountParticipating();
		await flush();

		expect(host.querySelector('[data-testid="thrown-round-note"]')).toBeNull();

		unmount(component);
		host.remove();
	});

	it('rebuilds registration for a replaced clean source while preserving same-image close and reopen', async () => {
		setThrownRoundSource({ blob: thrownBlob(), fileName: 'thrown-round.png' });
		setPendingAnnotatedRound(
			createAnnotatedRound({
				sourceImage: {
					fileName: 'course-v1.png',
					mimeType: 'image/png',
					widthPx: 200,
					heightPx: 100,
					blob: new Blob([new Uint8Array([1])], { type: 'image/png' })
				}
			})
		);
		const decodedNames: string[] = [];
		const decode: DecodeImageFile = async (file) => {
			decodedNames.push(file.name);
			return { image: document.createElement('img'), widthPx: 200, heightPx: 100 };
		};
		const { component, host } = mountParticipating(decode);
		await flush();

		host.querySelector<HTMLButtonElement>('[data-testid="open-played-round-registration"]')?.click();
		await flush();
		const registration = host.querySelector<HTMLElement>('[data-testid="played-round-registration"]');
		expect(registration?.querySelector('[data-testid="played-round-registration-loading"]')).toBeNull();
		expect(registration?.querySelector('[data-testid="pane-filename-target-basemap"]')?.textContent).toBe(
			'course-v1.png'
		);
		expect(decodedNames).toContain('thrown-round.png');

		registration?.querySelector<HTMLInputElement>('[data-testid="played-model-affine"]')?.click();
		registration?.querySelector<HTMLButtonElement>('[data-testid="played-round-registration-close"]')?.click();
		await flush();
		host.querySelector<HTMLButtonElement>('[data-testid="open-played-round-registration"]')?.click();
		await flush();
		expect(
			registration?.querySelector<HTMLInputElement>('[data-testid="played-model-affine"]')?.checked
		).toBe(true);

		registration?.querySelector<HTMLButtonElement>('[data-testid="played-round-registration-close"]')?.click();
		const parentSourceInput = host.querySelector<HTMLInputElement>(
			'section.panes [data-testid="pane-input-source-overview"]'
		);
		expect(parentSourceInput).not.toBeNull();
		setFileInput(
			parentSourceInput!,
			new File([new Uint8Array([2])], 'course-v2.png', { type: 'image/png' })
		);
		await flush();

		host.querySelector<HTMLButtonElement>('[data-testid="open-played-round-registration"]')?.click();
		await flush();
		expect(registration?.querySelector('[data-testid="played-round-registration-loading"]')).toBeNull();
		expect(registration?.querySelector('[data-testid="pane-filename-target-basemap"]')?.textContent).toBe(
			'course-v2.png'
		);
		expect(
			registration?.querySelector<HTMLInputElement>('[data-testid="played-model-similarity"]')?.checked
		).toBe(true);

		unmount(component);
		host.remove();
	});
});
