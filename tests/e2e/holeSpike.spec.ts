import { expect, test } from '@playwright/test';

test('renders the real target basemap with native SVG hole geometry', async ({ page }) => {
	await page.goto('/hole-spike');
	await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
	await expect(page.getByTestId('hole-spike-ready')).toBeVisible();

	const svg = page.getByTestId('hole-spike-svg');
	await expect(svg).toHaveAttribute('viewBox', '0 0 1320 2048');
	await expect(svg).toHaveAttribute('data-target-width', '1320');
	await expect(svg).toHaveAttribute('data-target-height', '2048');
	await expect(page.getByTestId('hole-spike-target-image')).toHaveAttribute('href', /^blob:/);

	await expect(page.getByTestId('hole-spike-corridor')).toHaveCount(1);
	await expect(page.getByTestId('hole-spike-centerline')).toHaveCount(1);
	await expect(page.getByTestId('hole-spike-tee')).toHaveCount(1);
	await expect(page.getByTestId('hole-spike-basket')).toHaveCount(1);
	await expect(page.getByTestId('hole-spike-bend-0')).toHaveCount(1);
	await expect(page.locator('.throw-marker')).toHaveCount(0);
});
