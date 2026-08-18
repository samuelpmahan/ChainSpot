import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * CHSPT-73 guide-style browser coverage.
 *
 * The prototype's whole point is comparing four presentations of the SAME
 * walkthrough live, so everything here revolves around one property:
 * switching guide style is a pure re-render. Same tour step, same route,
 * same product state, no reload, no arming, no import — before, during, and
 * after the switch.
 *
 * Anchored on the Map Round step (script position 5) like the existing demo
 * spec, because it starts fast (no stitch analysis), auto-imports its sample
 * source through the ordinary handoff path, and leaves real editor state on
 * the page (`data-source-loaded`) that a broken switch would visibly destroy.
 */

const STYLES = ['baseline', 'coach', 'spotlight', 'hud'] as const;
type Style = (typeof STYLES)[number];

async function gotoDemo(page: Page): Promise<void> {
	await page.goto('/demo');
	await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
}

/** Starts the tour at the Map Round step and waits for its source to load. */
async function startAtMapRound(page: Page): Promise<void> {
	await gotoDemo(page);
	await page.getByTestId('demo-start-step-map-round').click();
	await expect(page).toHaveURL(/\/map-round$/);
	await expect(page.getByTestId('demo-step-position')).toHaveText('Step 5 of 6');
	await expect(page.getByTestId('annotation-workspace')).toHaveAttribute(
		'data-source-loaded',
		'true',
		{ timeout: 30000 }
	);
}

/**
 * The guide opens collapsed by default at this suite's (<=1280px) viewport;
 * cases that drive the body/footer or settings expand it first. A no-op when
 * already expanded.
 */
async function expandGuide(page: Page): Promise<void> {
	const collapseToggle = page.getByTestId('demo-collapse');
	if ((await collapseToggle.getAttribute('aria-expanded')) === 'false') {
		await collapseToggle.click();
	}
}

async function openSettings(page: Page): Promise<void> {
	if (!(await page.getByTestId('demo-settings-popover').isVisible().catch(() => false))) {
		await page.getByTestId('demo-settings-toggle').click();
	}
	await expect(page.getByTestId('demo-settings-popover')).toBeVisible();
}

async function selectStyle(page: Page, style: Style): Promise<void> {
	await openSettings(page);
	await page.getByTestId(`demo-guide-style-${style}`).check();
	await expect(page.getByTestId('demo-guide')).toHaveAttribute('data-guide-style', style);
}

test('Demo Settings offers all four styles, and opening it has no workflow side effects', async ({
	page
}) => {
	test.setTimeout(90000);
	await startAtMapRound(page);
	await expandGuide(page);

	await openSettings(page);
	for (const style of STYLES) {
		await expect(page.getByTestId(`demo-guide-style-${style}`)).toBeVisible();
	}
	await expect(page.getByTestId('demo-guide-style-baseline')).toBeChecked();

	// Opening the popover changed nothing underneath: same URL, same step,
	// same loaded source, no pending handoff resurrected.
	await expect(page).toHaveURL(/\/map-round$/);
	await expect(page.getByTestId('demo-step-position')).toHaveText('Step 5 of 6');
	await expect(page.getByTestId('annotation-workspace')).toHaveAttribute(
		'data-source-loaded',
		'true'
	);
	await expect(page.getByTestId('pending-handoff')).toHaveCount(0);
});

test('switching between all four styles is an in-place re-render: same step, same product state, no reload, no import', async ({
	page
}) => {
	test.setTimeout(120000);
	await startAtMapRound(page);
	await expandGuide(page);

	// A marker that only survives if the page is never reloaded or navigated
	// away from top-level.
	await page.evaluate(() => {
		(window as unknown as Record<string, unknown>).__chainspotGuideSwitchMarker = 'alive';
	});

	for (const style of ['coach', 'spotlight', 'hud', 'baseline', 'coach'] as Style[]) {
		await selectStyle(page, style);

		// The presentation switched immediately — and the walkthrough did not
		// move: same URL, same step id and position, rendered by the new style
		// from the same tour state.
		await expect(page).toHaveURL(/\/map-round$/);
		await expect(page.getByTestId('demo-guide')).toHaveAttribute('data-step-id', 'map-round');
		await expect(page.getByTestId('demo-step-position')).toHaveText('Step 5 of 6');

		// No reload happened (the marker is in-memory only) …
		expect(
			await page.evaluate(
				() => (window as unknown as Record<string, unknown>).__chainspotGuideSwitchMarker
			)
		).toBe('alive');

		// … the editor kept its imported source, and nothing re-armed: a second
		// handoff arriving with a source already loaded would surface the
		// replace banner, so its absence proves no import was triggered.
		await expect(page.getByTestId('annotation-workspace')).toHaveAttribute(
			'data-source-loaded',
			'true'
		);
		await expect(page.getByTestId('pending-handoff')).toHaveCount(0);
	}
});

test('every style consumes the same tour actions: Back/Next from any presentation moves the one shared cursor', async ({
	page
}) => {
	test.setTimeout(90000);
	await startAtMapRound(page);
	await expandGuide(page);

	// Move back to the reload step from the HUD presentation…
	await selectStyle(page, 'hud');
	await page.getByTestId('demo-previous').click();
	await expect(page).toHaveURL(/\/create-graphics$/);
	await expect(page.getByTestId('demo-step-position')).toHaveText('Step 4 of 6');
	await expect(page.getByTestId('demo-reload')).toBeVisible();

	// …then verify a different presentation reads the very same cursor.
	await selectStyle(page, 'coach');
	await expect(page.getByTestId('demo-step-position')).toHaveText('Step 4 of 6');
	await expect(page.getByTestId('demo-reload')).toBeVisible();
});

test('the chosen style survives ordinary route navigation during an active demo', async ({
	page
}) => {
	test.setTimeout(90000);
	await startAtMapRound(page);
	await expandGuide(page);
	await selectStyle(page, 'hud');

	// Advance with the guide's own Next (an ordinary SvelteKit goto)…
	await page.getByTestId('demo-next').click();
	await expect(page).toHaveURL(/\/create-graphics$/);
	await expect(page.getByTestId('demo-guide')).toHaveAttribute('data-guide-style', 'hud');
	await expect(page.getByTestId('demo-step-position')).toHaveText('Step 6 of 6');

	// …and with the product's own header navigation, which the guide follows
	// via route sync. Style still sticks.
	await page.getByRole('link', { name: 'Map Round' }).click();
	await expect(page).toHaveURL(/\/map-round$/);
	await expect(page.getByTestId('demo-guide')).toHaveAttribute('data-guide-style', 'hud');
});

test('Spotlight rings its anchor when the real control is present, and gracefully renders without one otherwise', async ({
	page
}) => {
	test.setTimeout(90000);
	await startAtMapRound(page);
	await expandGuide(page);
	await selectStyle(page, 'spotlight');

	// Fresh Map Round visit: the sample already imported itself, so this
	// step's anchor (the handoff-import button) is not on screen — the guide
	// must render fine with no ring rather than pointing at nothing.
	await expect(page.getByTestId('demo-guide')).toBeVisible();
	await expect(page.getByTestId('demo-spotlight-ring')).toHaveCount(0);

	// Explicitly re-arming (a user action) resurfaces the product's handoff
	// banner — now the anchor exists and the ring appears around it.
	await page.getByTestId('demo-load-inputs').click();
	await expect(page.getByTestId('pending-handoff')).toBeVisible({ timeout: 30000 });
	await expect(page.getByTestId('demo-spotlight-ring')).toHaveCount(1);

	// The ring is decoration: the real button stays clickable through it.
	await page.getByTestId('handoff-dismiss').click();
	await expect(page.getByTestId('pending-handoff')).toHaveCount(0);
	await expect(page.getByTestId('demo-spotlight-ring')).toHaveCount(0);
});

test('the Mission HUD makes the whole journey legible: completed, current, and upcoming phases from one cursor', async ({
	page
}) => {
	test.setTimeout(90000);
	await startAtMapRound(page);
	await expandGuide(page);
	await selectStyle(page, 'hud');

	await expect(page.getByTestId('hud-phase-stitch')).toHaveAttribute('data-status', 'completed');
	await expect(page.getByTestId('hud-phase-annotate')).toHaveAttribute('data-status', 'completed');
	await expect(page.getByTestId('hud-phase-air')).toHaveAttribute('data-status', 'completed');
	await expect(page.getByTestId('hud-phase-register')).toHaveAttribute('data-status', 'current');
	await expect(page.getByTestId('hud-phase-export')).toHaveAttribute('data-status', 'upcoming');
	await expect(page.getByTestId('hud-mission-card')).toBeVisible();
});
