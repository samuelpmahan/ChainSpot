// @vitest-environment jsdom

/**
 * CHSPT-73 presentation-layer coverage: the Demo Settings preference store,
 * the Mission HUD's phase grouping, and the Spotlight anchor contract.
 *
 * The invariant all of these serve: presentation choices are entirely
 * separate from the walkthrough state machine. Changing the guide style must
 * never move the tour cursor, touch product state, or arm an input — the
 * store cannot even reach those, and these tests pin the storage separation
 * that keeps it honest.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DEMO_STEPS } from '../../src/lib/demo/catalog';
import type { DemoAnchorId } from '../../src/lib/demo/catalog';
import {
	DEMO_PHASES,
	phaseIndexForStep,
	phaseStatus
} from '../../src/lib/demo/guidePhases';
import {
	DEFAULT_GUIDE_STYLE,
	DemoGuidePreferences,
	GUIDE_STYLE_OPTIONS
} from '../../src/lib/demo/guidePreferences.svelte';
import { DemoTour } from '../../src/lib/demo/tour.svelte';
import {
	DEMO_ANCHOR_ATTRIBUTE,
	resolveDemoAnchor
} from '../../src/lib/components/demo/anchors';

beforeEach(() => {
	sessionStorage.clear();
	document.body.innerHTML = '';
});

describe('DemoGuidePreferences', () => {
	it('offers exactly the four comparable styles, with baseline as the default', () => {
		expect(GUIDE_STYLE_OPTIONS.map((option) => option.id)).toEqual([
			'baseline',
			'coach',
			'spotlight',
			'hud'
		]);
		expect(DEFAULT_GUIDE_STYLE).toBe('baseline');
		expect(new DemoGuidePreferences().guideStyle).toBe('baseline');
	});

	it('persists a chosen style and restores it in a fresh instance, standing in for a route change or reload', () => {
		const prefs = new DemoGuidePreferences();
		prefs.setGuideStyle('coach');

		const restored = new DemoGuidePreferences();
		expect(restored.guideStyle).toBe('baseline');
		restored.restore();
		expect(restored.guideStyle).toBe('coach');
	});

	it('treats stored preferences as untrusted: malformed or unknown values fall back to the default', () => {
		for (const raw of ['not json', '42', '{"guideStyle":"marquee"}', '{"guideStyle":7}']) {
			sessionStorage.setItem('chainspot.demo.preferences', raw);
			const prefs = new DemoGuidePreferences();
			prefs.restore();
			expect(prefs.guideStyle).toBe('baseline');
		}
	});

	it('keeps its storage fully separate from the tour machine, and never disturbs tour state', () => {
		const tour = new DemoTour();
		tour.start(2);
		const tourRaw = sessionStorage.getItem('chainspot.demo.tour');
		expect(tourRaw).not.toBeNull();

		const prefs = new DemoGuidePreferences();
		prefs.setGuideStyle('hud');
		prefs.setGuideStyle('spotlight');

		// The tour's persisted record is byte-for-byte untouched, and the live
		// cursor did not move: switching presentation is not a tour event.
		expect(sessionStorage.getItem('chainspot.demo.tour')).toBe(tourRaw);
		expect(tour.active).toBe(true);
		expect(tour.stepIndex).toBe(2);

		// And exiting the tour does not forget the presentation choice.
		tour.exit();
		const after = new DemoGuidePreferences();
		after.restore();
		expect(after.guideStyle).toBe('spotlight');
	});
});

describe('Mission HUD phases', () => {
	it('covers every demo step exactly once, contiguously, in script order', () => {
		const flattened = DEMO_PHASES.flatMap((phase) => phase.stepIds);
		expect(flattened).toEqual(DEMO_STEPS.map((step) => step.id));
		for (const phase of DEMO_PHASES) {
			expect(phase.stepIds.length).toBeGreaterThan(0);
			expect(phase.label.length).toBeGreaterThan(0);
		}
	});

	it('reports completed/current/upcoming from the tour cursor alone', () => {
		// Step index 4 is map-round, inside the "register" phase (index 3).
		const current = phaseIndexForStep(4);
		expect(DEMO_PHASES[current].id).toBe('register');
		expect(phaseStatus(current - 1, 4)).toBe('completed');
		expect(phaseStatus(current, 4)).toBe('current');
		expect(phaseStatus(current + 1, 4)).toBe('upcoming');
	});
});

describe('Spotlight anchor contract', () => {
	it('every step spotlight id names a real anchor in the contract vocabulary, and the reload step abstains', () => {
		const vocabulary: DemoAnchorId[] = [
			'stitch-alignment-review',
			'annotation-done',
			'map-round-import',
			'graphics-location-search'
		];
		for (const step of DEMO_STEPS) {
			if (step.kind === 'reload') {
				// Its only CTA is the guide's own Reload button; there is no
				// product control to point at.
				expect(step.spotlight).toBeUndefined();
				continue;
			}
			expect(step.spotlight).toBeDefined();
			expect(vocabulary).toContain(step.spotlight);
		}
	});

	it('resolves nothing when the anchor is absent — the graceful-fallback path', () => {
		expect(resolveDemoAnchor('annotation-done')).toBeNull();
	});

	it('skips hidden or zero-size candidates instead of spotlighting an unusable element', () => {
		const hiddenTarget = document.createElement('button');
		hiddenTarget.setAttribute(DEMO_ANCHOR_ATTRIBUTE, 'annotation-done');
		hiddenTarget.hidden = true;
		document.body.appendChild(hiddenTarget);
		expect(resolveDemoAnchor('annotation-done')).toBeNull();

		// jsdom gives every element a zero-size rect, which the resolver treats
		// as "not actually occupying layout" — also the fallback path.
		hiddenTarget.hidden = false;
		expect(resolveDemoAnchor('annotation-done')).toBeNull();
	});

	it('resolves the first usable candidate when duplicates exist on mutually exclusive branches', () => {
		const first = document.createElement('button');
		first.setAttribute(DEMO_ANCHOR_ATTRIBUTE, 'graphics-location-search');
		first.getBoundingClientRect = () =>
			({ top: 10, left: 10, width: 80, height: 24, right: 90, bottom: 34, x: 10, y: 10 }) as DOMRect;
		const second = document.createElement('button');
		second.setAttribute(DEMO_ANCHOR_ATTRIBUTE, 'graphics-location-search');
		document.body.append(first, second);

		expect(resolveDemoAnchor('graphics-location-search')).toBe(first);
	});
});
