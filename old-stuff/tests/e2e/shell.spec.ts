import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const FIXTURES = [
	{ name: 'tiny.png', mimeType: 'image/png', width: 2, height: 3 },
	{ name: 'tiny.jpg', mimeType: 'image/jpeg', width: 5, height: 4 }
];

test('application shell loads with no console or page errors on /create-graphics', async ({ page }) => {
	const consoleErrors: string[] = [];
	page.on('console', (message) => {
		if (message.type() === 'error') consoleErrors.push(message.text());
	});
	page.on('pageerror', (error) => consoleErrors.push(String(error)));

	await page.goto('/create-graphics');

	await expect(page.getByTestId('app-shell')).toBeVisible();
	await expect(page.getByRole('heading', { name: 'ChainSpot' })).toBeVisible();
	expect(consoleErrors).toEqual([]);
});

test('root route / redirects to /annotate-course with Annotate Course active', async ({ page }) => {
	await page.goto('/');
	await expect(page).toHaveURL(/\/annotate-course$/);
	await expect(page).toHaveTitle('Annotate Course | ChainSpot');
	const annotateCourseLink = page.getByRole('link', { name: 'Annotate Course' });
	await expect(annotateCourseLink).toHaveAttribute('aria-current', 'page');
});

test('direct load of /stitch-map shows Stitch Map title, workflow, and active link', async ({ page }) => {
	await page.goto('/stitch-map');
	await expect(page).toHaveTitle('Stitch Map | ChainSpot');
	await expect(page.getByTestId('stitch-map')).toBeVisible();
	const stitchMapLink = page.getByRole('link', { name: 'Stitch Map' });
	await expect(stitchMapLink).toHaveAttribute('aria-current', 'page');
});

test('header navigation switches between routes via pointer and keyboard', async ({ page }) => {
	await page.goto('/annotate-course');

	// Pointer navigation to Map Round
	await page.getByRole('link', { name: 'Map Round' }).click();
	await expect(page).toHaveURL(/\/map-round$/);
	await expect(page).toHaveTitle('Map Round | ChainSpot');
	await expect(page.getByRole('link', { name: 'Map Round' })).toHaveAttribute('aria-current', 'page');

	// Pointer navigation to Stitch Map
	await page.getByRole('link', { name: 'Stitch Map' }).click();
	await expect(page).toHaveURL(/\/stitch-map$/);
	await expect(page).toHaveTitle('Stitch Map | ChainSpot');
	await expect(page.getByRole('link', { name: 'Stitch Map' })).toHaveAttribute('aria-current', 'page');

	// Pointer navigation to Create Graphics
	await page.getByRole('link', { name: 'Create Graphics' }).click();
	await expect(page).toHaveURL(/\/create-graphics$/);
	await expect(page).toHaveTitle('Create Graphics | ChainSpot');
	await expect(page.getByRole('link', { name: 'Create Graphics' })).toHaveAttribute('aria-current', 'page');

	// Keyboard navigation back to Annotate Course
	await page.getByRole('link', { name: 'Annotate Course' }).focus();
	await page.keyboard.press('Enter');
	await expect(page).toHaveURL(/\/annotate-course$/);
	await expect(page).toHaveTitle('Annotate Course | ChainSpot');
	await expect(page.getByRole('link', { name: 'Annotate Course' })).toHaveAttribute('aria-current', 'page');
});

test('tiny synthetic fixtures decode in Chromium with their documented dimensions', async ({
	page
}) => {
	for (const fixture of FIXTURES) {
		const path = fileURLToPath(new URL(`../fixtures/${fixture.name}`, import.meta.url));
		const base64 = readFileSync(path).toString('base64');

		const dimensions = await page.evaluate(
			async (dataUrl: string) => {
				const image = new Image();
				image.src = dataUrl;
				await image.decode();
				return { width: image.naturalWidth, height: image.naturalHeight };
			},
			`data:${fixture.mimeType};base64,${base64}`
		);

		expect(dimensions).toEqual({ width: fixture.width, height: fixture.height });
	}
});
