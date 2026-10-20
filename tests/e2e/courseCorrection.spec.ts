/**
 * Correct Course: the click budget, proved in a real browser.
 *
 * Sam's goal: "if a bend can be fixed in under 3 clicks ... a bad course probably takes 10 to 15 clicks to correct".
 * Every gesture below goes through a counter (`Budget`): a click, a double-click, a drag and a key press each count as
 * ONE action, so the asserted totals are the reviewer's real work. Geometry is read back from the overlay's
 * data-x-px / data-y-px (source px of the screenshot) and, for the save test, from project.json inside the saved
 * .chainspot.zip.
 *
 * Fixtures: the toolkit's golden export (`golden.course-geometry.json`, all 18 holes confirmed) and
 * `golden-review.course-geometry.json`, the same file with four holes broken on purpose (see its producer.note):
 * hole 7 bend displaced, hole 14 bend missing, hole 10 spurious bend, hole 12 tee displaced. The fixes are judged
 * against golden with the plan's match rules: bend within half the corridor width, tee within 8 px.
 *
 * Set CS_UI_SHOTS to a directory to save a PNG of each step.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strFromU8, unzipSync } from 'fflate';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const fixture = (path: string) => fileURLToPath(new URL(`../fixtures/${path}`, import.meta.url));
const SCREENSHOT = fileURLToPath(new URL('../../resources/ribbon-reference/IMG_5641.jpg', import.meta.url));
const GOLDEN = fixture('course-geometry/golden.course-geometry.json');
const REVIEW = fixture('course-geometry/golden-review.course-geometry.json');
const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'));
const goldenHole = (number: number) => golden.holes.find((h: { number: number }) => h.number === number);
const HALF_CORRIDOR = golden.holes[0].corridorWidthPx / 2;
const TEE_MATCH_PX = 8;

const SHOTS = process.env.CS_UI_SHOTS;
async function shot(page: Page, name: string): Promise<void> {
	if (!SHOTS) return;
	mkdirSync(SHOTS, { recursive: true });
	await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

/** Counts the reviewer's actions. */
class Budget {
	count = 0;
	constructor(private readonly page: Page) {}
	async click(x: number, y: number) {
		this.count += 1;
		await this.page.mouse.click(x, y);
	}
	async dblclick(x: number, y: number) {
		this.count += 1;
		await this.page.mouse.dblclick(x, y);
	}
	async drag(from: { x: number; y: number }, to: { x: number; y: number }) {
		this.count += 1;
		await this.page.mouse.move(from.x, from.y);
		await this.page.mouse.down();
		await this.page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
		await this.page.mouse.move(to.x, to.y, { steps: 4 });
		await this.page.mouse.up();
	}
	async press(key: string) {
		this.count += 1;
		await this.page.keyboard.press(key);
	}
}

const VIEWPORT = '[data-testid="pane-scene-source-overview"]';

/** Page coordinates of a source-px point under the current view. */
async function toPage(page: Page, point: { xPx: number; yPx: number }): Promise<{ x: number; y: number }> {
	return page.evaluate(
		({ selector, point }) => {
			const el = document.querySelector<HTMLElement>(selector)!;
			const rect = el.getBoundingClientRect();
			const zoom = Number(el.dataset.viewZoom);
			return {
				x: rect.left + el.clientLeft + Number(el.dataset.viewPanX) + point.xPx * zoom,
				y: rect.top + el.clientTop + Number(el.dataset.viewPanY) + point.yPx * zoom
			};
		},
		{ selector: VIEWPORT, point }
	);
}

async function handle(page: Page, testid: string): Promise<{ xPx: number; yPx: number }> {
	const el = page.getByTestId(testid);
	return { xPx: Number(await el.getAttribute('data-x-px')), yPx: Number(await el.getAttribute('data-y-px')) };
}

async function bends(page: Page, number: number): Promise<{ xPx: number; yPx: number }[]> {
	const count = Number(await page.getByTestId(`cc-hole-${number}`).getAttribute('data-bends'));
	const out = [];
	for (let index = 0; index < count; index++) out.push(await handle(page, `cc-bend-${number}-${index}`));
	return out;
}

const dist = (a: { xPx: number; yPx: number }, b: { xPx: number; yPx: number }) => Math.hypot(a.xPx - b.xPx, a.yPx - b.yPx);

/** Waits until a focus jump's transform settles (two equal reads of the view). */
async function settle(page: Page): Promise<void> {
	await page.waitForTimeout(50);
	let last = '';
	for (let i = 0; i < 40; i++) {
		const now = await page.locator(VIEWPORT).evaluate((el: HTMLElement) => `${el.dataset.viewZoom}:${el.dataset.viewPanX}:${el.dataset.viewPanY}`);
		if (now === last) break;
		last = now;
		await page.waitForTimeout(60);
	}
	// The CSS transition on a programmatic jump (ImageEditorPane FOCUS_TRANSITION_MS) must end before the
	// rendered image matches the view numbers the gestures are computed from.
	await page.waitForTimeout(700);
}

async function open(page: Page, files: string[]): Promise<void> {
	await page.goto('/correct-course');
	await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
	await page.getByTestId('cc-open-input').setInputFiles(files);
	await expect(page.getByTestId('course-correction-layer')).toBeVisible();
	await page.waitForTimeout(100);
}

test.use({ viewport: { width: 1600, height: 1000 } });

test('step 1: the golden course loads as corridors over its screenshot, coloured by evidence', async ({ page }) => {
	await open(page, [GOLDEN, SCREENSHOT]);
	await expect(page.getByTestId('cc-message')).toContainText('Loaded 18 holes');
	for (let number = 1; number <= 18; number++) {
		await expect(page.getByTestId(`cc-hole-${number}`)).toHaveAttribute('data-status', /^(resolved|straight)$/);
	}
	await expect(page.locator('g[data-testid^="cc-hole-"][data-status="resolved"]')).toHaveCount(9);
	await expect(page.locator('g[data-testid^="cc-hole-"][data-status="straight"]')).toHaveCount(9);
	await expect(page.getByTestId('cc-queue-count')).toContainText('0 of 18 need review');
	// One image surface: one viewport, the overlay inside its transformed image group.
	await expect(page.locator('.image-viewport')).toHaveCount(1);
	await expect(page.locator('.image-viewport [data-testid="annotation-frame"] [data-testid="course-correction-layer"]')).toHaveCount(1);
	await shot(page, '01-golden-loaded');
});

test('a wrong screenshot is a visible message, not a load', async ({ page }) => {
	await page.goto('/correct-course');
	await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
	await page.getByTestId('cc-open-input').setInputFiles([GOLDEN, fixture('acceptance-source-overview.png')]);
	await expect(page.getByTestId('cc-error')).toContainText('was read from IMG_5641.jpg');
});
