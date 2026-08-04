import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const FIXTURES = [
	{ name: 'tiny.png', mimeType: 'image/png', width: 2, height: 3 },
	{ name: 'tiny.jpg', mimeType: 'image/jpeg', width: 5, height: 4 }
];

test('application shell loads with no console or page errors', async ({ page }) => {
	const consoleErrors: string[] = [];
	page.on('console', (message) => {
		if (message.type() === 'error') consoleErrors.push(message.text());
	});
	page.on('pageerror', (error) => consoleErrors.push(String(error)));

	await page.goto('/');

	await expect(page.getByTestId('app-shell')).toBeVisible();
	await expect(page.getByRole('heading', { name: 'ChainSpot' })).toBeVisible();
	expect(consoleErrors).toEqual([]);
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
