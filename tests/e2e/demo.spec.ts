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
 */
async function gotoDemo(page: Page): Promise<void> {
	await page.goto('/demo');
	await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
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
	await expect(page.getByTestId('demo-step-position')).toHaveText('Step 1 of 5');

	// The arrangement is produced by the product's own inference over the supplied
	// pixels. The assertion is deliberately on the outcome that matters to a
	// visitor — every slot filled from a distinct capture, and an arrangement the
	// product itself calls exportable — not on which corner each file lands in.
	// Corner labelling is the product's judgement on real, heavily overlapping
	// captures; pinning it here would make this a smart-import regression test
	// wearing a demo's clothes.
	await expect(page.getByTestId('smart-import-assignment')).toBeVisible({ timeout: 60000 });
	const assigned = await Promise.all(
		['upper-left', 'upper-right', 'lower-left', 'lower-right'].map((slot) =>
			page.getByTestId(`smart-import-slot-${slot}`).innerText()
		)
	);
	expect(new Set(assigned).size).toBe(4);
	await expect(page.getByTestId('stitch-readiness')).toContainText('Export is ready');
});

test('walkthrough steps to Annotate Round and can be exited without resetting the app', async ({
	page
}) => {
	// Generous despite not running stitch analysis: this file runs alongside the
	// CV-heavy stitch specs, and under that parallel load the image fetch and
	// route transitions here have been observed to outlast a 60s budget.
	test.setTimeout(90000);
	await gotoDemo(page);

	// Start at step 2 so this case exercises narration and the handoff banner
	// without paying for the four-screenshot stitch analysis.
	await page.getByTestId('demo-start-step-annotate').click();

	await expect(page).toHaveURL(/\/annotate-round$/);
	await expect(page.getByTestId('demo-step-position')).toHaveText('Step 2 of 5');

	// The sample source arrives through the product's ordinary import banner,
	// awaiting an explicit decision rather than being applied behind the visitor.
	await expect(page.getByTestId('pending-handoff')).toBeVisible({ timeout: 30000 });
	await expect(page.getByTestId('handoff-import')).toBeVisible();

	await page.getByTestId('demo-next').click();
	await expect(page).toHaveURL(/\/create-graphics$/);
	await expect(page.getByTestId('demo-step-position')).toHaveText('Step 3 of 5');

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
 * without the rail's knowledge.
 */
test('the rail stays usable when the visitor is already on the step route, and follows product navigation', async ({
	page
}) => {
	test.setTimeout(60000);
	await gotoDemo(page);
	await page.getByTestId('demo-start-step-annotate').click();
	await expect(page).toHaveURL(/\/annotate-round$/);

	// Dismissing leaves the visitor on the step's route with nothing loaded —
	// the state a visitor also reaches by using the rail's Next from step 1.
	await page.getByTestId('handoff-dismiss').click();
	await expect(page.getByTestId('pending-handoff')).toHaveCount(0);

	// Arming from here must reach the already-mounted page, not report a
	// success the visitor cannot see.
	await page.getByTestId('demo-load-inputs').click();
	await expect(page.getByTestId('pending-handoff')).toBeVisible({ timeout: 30000 });

	// Navigating the way the product does, without touching the rail, moves the
	// narration with the visitor instead of stranding it a step behind.
	await page.getByRole('link', { name: 'Create Graphics' }).click();
	await expect(page).toHaveURL(/\/create-graphics$/);
	await expect(page.getByTestId('demo-step-position')).toHaveText('Step 3 of 5');
});
