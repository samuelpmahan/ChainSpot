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

// ---------------------------------------------------------------------------
// Step 2: bend editing within the click budget (each fix from the fitted view, no navigation)
// ---------------------------------------------------------------------------

test('fix a wrong bend: 1 drag', async ({ page }) => {
	await open(page, [REVIEW, SCREENSHOT]);
	const budget = new Budget(page);
	const wrong = await handle(page, 'cc-bend-7-0');
	const target = goldenHole(7).corridorBends[0];
	expect(dist(wrong, target)).toBeGreaterThan(HALF_CORRIDOR);
	await shot(page, '02-wrong-bend-before');
	await budget.drag(await toPage(page, wrong), await toPage(page, target));
	const fixed = await handle(page, 'cc-bend-7-0');
	expect(dist(fixed, target)).toBeLessThan(HALF_CORRIDOR);
	expect(Number(await page.getByTestId('cc-hole-7').getAttribute('data-bends'))).toBe(1);
	expect(budget.count).toBe(1);
	await expect(page.getByTestId('cc-edited-7')).toBeVisible();
	await shot(page, '03-wrong-bend-fixed');

	// One drag is one ProjectEditor history step.
	await page.keyboard.press('Control+z');
	expect(await handle(page, 'cc-bend-7-0')).toEqual(wrong);
	await page.keyboard.press('Control+Shift+z');
	expect(await handle(page, 'cc-bend-7-0')).toEqual(fixed);
});

test('add a missing bend: 1 drag from the corridor leg (or 1 click to drop it on the leg)', async ({ page }) => {
	await open(page, [REVIEW, SCREENSHOT]);
	const h = goldenHole(14);
	const target = h.corridorBends[0];
	expect(Number(await page.getByTestId('cc-hole-14').getAttribute('data-bends'))).toBe(0);
	const legMid = { xPx: (h.tee.xPx + h.basket.xPx) / 2, yPx: (h.tee.yPx + h.basket.yPx) / 2 };

	const budget = new Budget(page);
	await shot(page, '04-missing-bend-before');
	await budget.drag(await toPage(page, legMid), await toPage(page, target));
	expect(Number(await page.getByTestId('cc-hole-14').getAttribute('data-bends'))).toBe(1);
	expect(dist(await handle(page, 'cc-bend-14-0'), target)).toBeLessThan(HALF_CORRIDOR);
	expect(budget.count).toBe(1);
	await shot(page, '05-missing-bend-added');

	// The click variant: one click on the leg adds a bend exactly there.
	await page.keyboard.press('Control+z');
	expect(Number(await page.getByTestId('cc-hole-14').getAttribute('data-bends'))).toBe(0);
	const clicks = new Budget(page);
	await clicks.click(...Object.values(await toPage(page, legMid)) as [number, number]);
	expect(Number(await page.getByTestId('cc-hole-14').getAttribute('data-bends'))).toBe(1);
	expect(dist(await handle(page, 'cc-bend-14-0'), legMid)).toBeLessThan(3);
	expect(clicks.count).toBe(1);
});

test('remove a spurious bend: 1 double-click, or click + Delete', async ({ page }) => {
	await open(page, [REVIEW, SCREENSHOT]);
	const spurious = await handle(page, 'cc-bend-10-0');
	const at = await toPage(page, spurious);
	const budget = new Budget(page);
	await budget.dblclick(at.x, at.y);
	expect(Number(await page.getByTestId('cc-hole-10').getAttribute('data-bends'))).toBe(0);
	expect(budget.count).toBe(1);
	await shot(page, '06-spurious-bend-removed');

	await page.keyboard.press('Control+z');
	expect(Number(await page.getByTestId('cc-hole-10').getAttribute('data-bends'))).toBe(1);
	const twoStep = new Budget(page);
	await twoStep.click(at.x, at.y);
	await twoStep.press('Delete');
	expect(Number(await page.getByTestId('cc-hole-10').getAttribute('data-bends'))).toBe(0);
	expect(twoStep.count).toBe(2);
});

test('drag a tee endpoint: 1 drag', async ({ page }) => {
	await open(page, [REVIEW, SCREENSHOT]);
	const target = goldenHole(12).tee;
	const budget = new Budget(page);
	await budget.drag(await toPage(page, await handle(page, 'cc-tee-12')), await toPage(page, target));
	expect(dist(await handle(page, 'cc-tee-12'), target)).toBeLessThan(TEE_MATCH_PX);
	expect(budget.count).toBe(1);
});

test('a background drag still pans the one surface (not an edit)', async ({ page }) => {
	await open(page, [REVIEW, SCREENSHOT]);
	const vp = page.locator(VIEWPORT);
	const before = Number(await vp.getAttribute('data-view-pan-x'));
	const box = (await vp.boundingBox())!;
	await page.mouse.move(box.x + 40, box.y + 40);
	await page.mouse.down();
	await page.mouse.move(box.x + 140, box.y + 60, { steps: 5 });
	await page.mouse.up();
	expect(Number(await vp.getAttribute('data-view-pan-x'))).toBeCloseTo(before + 100, 0);
	await expect(page.getByTestId('cc-undo')).toBeDisabled();
});

test('adopt an alternative route: 1 click on its ghost, undoable', async ({ page }) => {
	await open(page, [REVIEW, SCREENSHOT]);
	await page.getByTestId('cc-hole-row-7').click(); // navigation, not counted: the walk reaches it with N
	await settle(page);
	await expect(page.getByTestId('cc-ghost-0')).toBeVisible();
	await shot(page, '15-hole7-ghost-alternative');
	const before = await bends(page, 7);
	const target = goldenHole(7).corridorBends[0];
	const budget = new Budget(page);
	const at = await toPage(page, target);
	await budget.click(at.x, at.y);
	expect(budget.count).toBe(1);
	const adopted = await bends(page, 7);
	expect(adopted).toHaveLength(1);
	expect(dist(adopted[0], target)).toBeLessThan(0.01);
	expect(dist(await handle(page, 'cc-tee-7'), goldenHole(7).tee)).toBeLessThan(0.01);
	await expect(page.getByTestId('cc-message')).toContainText('adopted alternative 1');
	await shot(page, '16-hole7-alternative-adopted');
	await page.keyboard.press('Control+z');
	expect(await bends(page, 7)).toEqual(before);
});

// ---------------------------------------------------------------------------
// Steps 3 and 4: walk only the uncertain holes with N, fix each, save, reopen
// ---------------------------------------------------------------------------

test('review walk: N visits only the five flagged holes; the whole course is fixed in 9 actions, saved and reopened', async ({ page }) => {
	test.setTimeout(120_000);
	await open(page, [REVIEW, SCREENSHOT]);
	await expect(page.getByTestId('cc-queue-count')).toContainText('5 of 18 need review');
	// The list puts the flagged holes first: hole 3 is confirmed but its alternative disagrees.
	const rows = page.locator('[data-testid^="cc-hole-row-"]');
	expect(await rows.evaluateAll((els) => els.slice(0, 5).map((el) => el.getAttribute('data-testid')))).toEqual([
		'cc-hole-row-3',
		'cc-hole-row-7',
		'cc-hole-row-10',
		'cc-hole-row-12',
		'cc-hole-row-14'
	]);
	const budget = new Budget(page);
	const zoomOf = async () => Number(await page.locator(VIEWPORT).getAttribute('data-view-zoom'));
	const fitZoom = await zoomOf();

	// Hole 3: the primary is right, its off-route alternative is not; look and move on (no edit).
	await budget.press('n');
	await settle(page);
	await expect(page.getByTestId('cc-hole-row-3')).toHaveAttribute('aria-current', 'true');
	expect(await zoomOf()).toBeGreaterThan(fitZoom);
	await expect(page.getByTestId('cc-ghost-0')).toBeVisible();
	await shot(page, '07a-walk-hole3-alternative-disagrees');

	// Hole 7: wrong bend.
	await budget.press('n');
	await settle(page);
	await expect(page.getByTestId('cc-hole-row-7')).toHaveAttribute('aria-current', 'true');
	await shot(page, '07-walk-hole7');
	await budget.drag(await toPage(page, await handle(page, 'cc-bend-7-0')), await toPage(page, goldenHole(7).corridorBends[0]));

	// Hole 10: spurious bend.
	await budget.press('n');
	await settle(page);
	await expect(page.getByTestId('cc-hole-row-10')).toHaveAttribute('aria-current', 'true');
	await shot(page, '08-walk-hole10');
	const spurious = await toPage(page, await handle(page, 'cc-bend-10-0'));
	await budget.dblclick(spurious.x, spurious.y);

	// Hole 12: displaced tee.
	await budget.press('n');
	await settle(page);
	await expect(page.getByTestId('cc-hole-row-12')).toHaveAttribute('aria-current', 'true');
	await shot(page, '09-walk-hole12');
	await budget.drag(await toPage(page, await handle(page, 'cc-tee-12')), await toPage(page, goldenHole(12).tee));

	// Hole 14: missing bend.
	await budget.press('n');
	await settle(page);
	await expect(page.getByTestId('cc-hole-row-14')).toHaveAttribute('aria-current', 'true');
	await shot(page, '10-walk-hole14');
	const h14 = goldenHole(14);
	await budget.drag(
		await toPage(page, { xPx: (h14.tee.xPx + h14.basket.xPx) / 2, yPx: (h14.tee.yPx + h14.basket.yPx) / 2 }),
		await toPage(page, h14.corridorBends[0])
	);
	await shot(page, '11-walk-hole14-fixed');

	// N wraps back to the first flagged hole: the walk never visits a confirmed hole.
	await page.keyboard.press('n');
	await expect(page.getByTestId('cc-hole-row-3')).toHaveAttribute('aria-current', 'true');
	await page.keyboard.press('p');
	await expect(page.getByTestId('cc-hole-row-14')).toHaveAttribute('aria-current', 'true');

	expect(budget.count).toBe(9);

	// Every hole now agrees with golden (bends within half the corridor, tees within 8 px).
	const checkAgainstGolden = async () => {
		for (const g of golden.holes) {
			expect(await bends(page, g.number), `hole ${g.number} bends`).toHaveLength(g.corridorBends.length);
			const got = await bends(page, g.number);
			g.corridorBends.forEach((b: { xPx: number; yPx: number }, i: number) => expect(dist(got[i], b), `hole ${g.number} bend ${i}`).toBeLessThan(HALF_CORRIDOR));
			expect(dist(await handle(page, `cc-tee-${g.number}`), g.tee), `hole ${g.number} tee`).toBeLessThan(TEE_MATCH_PX);
		}
	};
	await checkAgainstGolden();
	await page.locator(VIEWPORT).focus();
	await page.keyboard.press('0');
	await settle(page);
	await shot(page, '12-walk-all-fixed');

	// Step 4: save through the existing persistence, then reopen.
	const downloadPromise = page.waitForEvent('download');
	await page.getByTestId('cc-save').click();
	const download = await downloadPromise;
	expect(download.suggestedFilename()).toMatch(/\.chainspot\.zip$/);
	const zipPath = test.info().outputPath(download.suggestedFilename());
	await download.saveAs(zipPath);
	const zip = unzipSync(new Uint8Array(readFileSync(zipPath)));
	const project = JSON.parse(strFromU8(zip['project.json']));
	expect(project.schemaVersion).toBe(8);
	expect(project.images.map((i: { role: string }) => i.role)).toEqual(['source-overview']);
	expect(project.holes).toHaveLength(18);
	const saved7 = project.holes.find((h: { number: number }) => h.number === 7);
	expect(dist(saved7.corridorBends[0], goldenHole(7).corridorBends[0])).toBeLessThan(HALF_CORRIDOR);
	expect(project.holes.find((h: { number: number }) => h.number === 10).corridorBends).toEqual([]);
	expect(project.holes.find((h: { number: number }) => h.number === 14).corridorBends).toHaveLength(1);
	// No evidence or review state inside the project: ProjectState stays clean.
	expect(Object.keys(saved7).sort()).toEqual(['basket', 'corridorBends', 'corridorWidthPx', 'id', 'number', 'shots', 'tee']);

	// Reopen in a fresh page: the bundle alone restores every edit.
	const fresh = await page.context().newPage();
	await open(fresh, [zipPath]);
	await expect(fresh.getByTestId('cc-message')).toContainText('18 holes');
	for (const saved of project.holes) {
		const got = await bends(fresh, saved.number);
		expect(got).toEqual(saved.corridorBends);
		expect(await handle(fresh, `cc-tee-${saved.number}`)).toEqual(saved.tee);
	}
	await expect(fresh.locator('g[data-testid^="cc-hole-"][data-status="none"]')).toHaveCount(18);
	await shot(fresh, '13-reopened-bundle');

	// With the geometry file alongside, the evidence comes back and the edits are marked.
	await fresh.getByTestId('cc-open-input').setInputFiles([zipPath, REVIEW]);
	await expect(fresh.locator('g[data-testid="cc-hole-7"]')).toHaveAttribute('data-status', 'partial');
	for (const n of [7, 10, 12, 14]) await expect(fresh.getByTestId(`cc-edited-${n}`)).toBeVisible();
	await expect(fresh.locator('[data-testid^="cc-edited-"]')).toHaveCount(4);
	expect(await bends(fresh, 14)).toEqual(project.holes.find((h: { number: number }) => h.number === 14).corridorBends);
	await shot(fresh, '14-reopened-with-evidence');
});
