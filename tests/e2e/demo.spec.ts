import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Guided-demo browser case.
 *
 * Asserts the property the whole `/demo` route exists to deliver: starting the
 * walkthrough lands a visitor inside a real product route holding real inputs,
 * and the product — not the demo — computes what they then see. It also pins
 * the escape hatch, since a prospective customer who cannot leave the tour is
 * worse off than one who never started it.
 *
 * The script now tells the whole product story in six steps: build the map
 * once (stitch, annotate on Annotate Course), put one course on air (basemap +
 * export), reload the browser for real, then annotate a *played round* of the
 * same course (Map Round: throws + walking path) purely from what Course
 * Memory remembered, and export again. This file does not attempt to drive
 * the reload step itself — a real `window.location.assign` mid-test is
 * exactly the kind of thing worth a dedicated, deliberately isolated case
 * rather than folding it into these broader flows.
 */
async function gotoDemo(page: Page): Promise<void> {
	await page.goto('/demo');
	await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
}

/**
 * The rail now opens collapsed by default at this suite's (narrow, <=1280px)
 * viewport — see `DemoGuide.svelte` — so cases that drive the step body or
 * footer (`demo-next`, `demo-load-inputs`, …) must expand it first. A no-op
 * when it's already expanded.
 */
async function expandRail(page: Page): Promise<void> {
	const collapseToggle = page.getByTestId('demo-collapse');
	if ((await collapseToggle.getAttribute('aria-expanded')) === 'false') {
		await collapseToggle.click();
	}
}

test('walkthrough drives the real Stitch Map with the real course captures', async ({ page }) => {
	// The demo loads four full-size phone screenshots and then pays the
	// smart-import worker's one-time OpenCV WASM compile, exactly as a first-time
	// visitor does; 90s matches tests/e2e/smartImport.spec.ts for the same reason.
	test.setTimeout(90000);
	await gotoDemo(page);

	await expect(page.getByTestId('demo-cover')).toBeVisible();
	await page.getByTestId('demo-start').click();

	// A real route, not a demo surface.
	await expect(page).toHaveURL(/\/stitch-map$/);
	await expect(page.getByTestId('stitch-map')).toBeVisible();
	await expect(page.getByTestId('demo-guide')).toBeVisible();
	await expect(page.getByTestId('demo-step-position')).toHaveText('Step 1 of 6');

	// The arrangement is produced by the product's own inference over the supplied
	// pixels. The assertion is deliberately on the outcome that matters to a
	// visitor — every slot filled from a distinct capture, and an arrangement the
	// product itself calls exportable — not on which corner each file lands in.
	// Corner labelling is the product's judgement on real, heavily overlapping
	// captures; pinning it here would make this a smart-import regression test
	// wearing a demo's clothes. (This dataset's placement has not previously been
	// exercised through this pipeline in this repo's test suite — see
	// docs/demo-walkthrough.md's "What building the demo found".)
	await expect(page.getByTestId('smart-import-assignment')).toBeVisible({ timeout: 60000 });
	const assigned = await Promise.all(
		['upper-left', 'upper-right', 'lower-left', 'lower-right'].map((slot) =>
			page.getByTestId(`smart-import-slot-${slot}`).innerText()
		)
	);
	expect(new Set(assigned).size).toBe(4);
	await expect(page.getByTestId('stitch-readiness')).toContainText('Export is ready');
});

test('the round-annotation step imports its sample source automatically and can be exited without resetting the app', async ({
	page
}) => {
	// Generous despite not running stitch analysis: this file runs alongside the
	// CV-heavy stitch specs, and under that parallel load the image fetch and
	// route transitions here have been observed to outlast a 60s budget.
	test.setTimeout(90000);
	await gotoDemo(page);

	// Start at the Map Round annotate step (script position 5) so this case
	// exercises narration and the handoff import without paying for the
	// four-screenshot stitch analysis, the Annotate Course pass, or a real
	// page reload. This is the step demo arming still supplies a fallback
	// asset for — the Annotate Course step relies entirely on the product's
	// own "Use as UDisc source" handoff from step 1 and has nothing to arm on
	// its own.
	await page.getByTestId('demo-start-step-map-round').click();

	await expect(page).toHaveURL(/\/map-round$/);
	await expect(page.getByTestId('demo-step-position')).toHaveText('Step 5 of 6');

	// This is a fresh visit — no source image, no annotations yet — so the
	// sample source is safe to complete on its own: it imports itself through
	// the product's ordinary handoff path (same as a real visitor's stitched
	// export would) with no banner and no click required.
	await expect(page.getByTestId('pending-handoff')).toHaveCount(0);
	await expect(page.getByTestId('annotation-workspace')).toHaveAttribute('data-source-loaded', 'true', {
		timeout: 30000
	});

	await expandRail(page);
	await page.getByTestId('demo-next').click();
	await expect(page).toHaveURL(/\/create-graphics$/);
	await expect(page.getByTestId('demo-step-position')).toHaveText('Step 6 of 6');

	// Exiting removes the rail and leaves the visitor in the working product.
	await page.getByTestId('demo-exit').click();
	await expect(page.getByTestId('demo-guide')).toHaveCount(0);
	await expect(page.getByTestId('app-shell')).toBeVisible();
});

/**
 * The two ways the rail and the product can fall out of step with each other.
 * Both were reachable on the walkthrough's own recommended path, and both are
 * invisible in unit tests: one depends on SvelteKit treating `goto` to the
 * current URL as a no-op, the other on the product's controls navigating
 * without the rail's knowledge. Anchored on the Map Round annotate step
 * specifically because Create Graphics is now visited both before and after
 * the reload step: following product navigation here must land forward on the
 * export-the-round step, not snap back to the earlier basemap step just
 * because it happens to share a route and comes first in the script array.
 */
test('the rail stays usable when the visitor is already on the step route, and follows product navigation to the correct occurrence of a repeated route', async ({
	page
}) => {
	test.setTimeout(60000);
	await gotoDemo(page);
	await page.getByTestId('demo-start-step-map-round').click();
	await expect(page).toHaveURL(/\/map-round$/);
	await expect(page.getByTestId('demo-step-position')).toHaveText('Step 5 of 6');

	// This is a fresh visit, so the step's sample source imports itself
	// automatically — no banner, nothing to dismiss.
	await expect(page.getByTestId('pending-handoff')).toHaveCount(0);
	await expect(page.getByTestId('annotation-workspace')).toHaveAttribute('data-source-loaded', 'true', {
		timeout: 30000
	});

	// Arming again from here must reach the already-mounted page, not report a
	// success the visitor cannot see — and with a source image now loaded,
	// completing this second handoff without a decision would silently replace
	// it, so the banner returns (this route's normal unsafe-replacement guard).
	// The rail defaults collapsed at this viewport, so open it to reach the arm
	// control.
	await expandRail(page);
	await page.getByTestId('demo-load-inputs').click();
	await expect(page.getByTestId('pending-handoff')).toBeVisible({ timeout: 30000 });

	// Navigating the way the product does, without touching the rail, moves the
	// narration with the visitor instead of stranding it a step behind — and
	// lands on the export-round step (6), the nearer forward occurrence of
	// Create Graphics, not the basemap step (3) that comes first in the script.
	await page.getByRole('link', { name: 'Create Graphics' }).click();
	await expect(page).toHaveURL(/\/create-graphics$/);
	await expect(page.getByTestId('demo-step-position')).toHaveText('Step 6 of 6');
});
