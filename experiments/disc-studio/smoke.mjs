import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const proof = resolve(root, 'artifacts/disc-studio-proof');
mkdirSync(proof, { recursive: true });
const offline = process.argv.includes('--offline');
const url = process.env.BASE_URL ?? 'http://127.0.0.1:5174';
const html = readFileSync(
	resolve(root, 'artifacts/disc-studio-site/ChainSpot-Disc-Studio.html'),
	'utf8'
);
const checks = [],
	errors = [];
const browser = await chromium.launch({
	headless: true,
	executablePath: process.env.CHROMIUM_PATH || undefined,
	args: ['--no-sandbox']
});
function passed(name) {
	checks.push(name);
	console.log('PASS', name);
}
async function newPage(width = 1536, height = 1100, storageFixture) {
	const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
	page.setDefaultTimeout(8000);
	page.on('pageerror', (e) => errors.push(e.message));
	// The fixture is used ONLY for an explicitly labeled storage-integration test on an
	// opaque document. All main screenshots and interactions use the unmodified browser.
	if (storageFixture)
		await page.evaluate((seed) => {
			const map = new Map(Object.entries(seed));
			Object.defineProperty(window, 'localStorage', {
				configurable: true,
				value: {
					getItem: (k) => map.get(k) ?? null,
					setItem: (k, v) => map.set(k, String(v)),
					removeItem: (k) => map.delete(k)
				}
			});
		}, storageFixture);
	if (offline) await page.setContent(html);
	else await page.goto(url);
	await page.getByRole('button', { name: 'Increase Buzzz score' }).waitFor();
	await page.waitForTimeout(400);
	return page;
}
async function inspect(page) {
	if (!(await page.getByTestId('state-json').count()))
		await page.getByRole('button', { name: '⌘ State' }).click();
	return JSON.parse(await page.getByTestId('state-json').textContent());
}
async function closeState(page) {
	if (await page.getByRole('button', { name: 'Close state' }).count())
		await page.getByRole('button', { name: 'Close state' }).click();
}
async function dismiss(page) {
	for (const name of ['Dismiss error', 'Dismiss notice'])
		if (await page.getByRole('button', { name }).count())
			await page.getByRole('button', { name }).click();
}
try {
	const page = await newPage();
	assert.equal(await page.getByTestId('shelf-disc').count(), 7);
	assert.equal(await page.getByTestId('disc-card').count(), 4);
	passed('cold start: 7 specimens, 4 rendered cards');
	if (offline) {
		assert.match(await page.getByRole('alert').textContent(), /not been overwritten/);
		passed('unavailable native storage is visibly reported, not silently called saved');
	}
	await dismiss(page);
	await page.screenshot({ path: resolve(proof, '02-default-desktop.png'), fullPage: true });
	await page
		.getByTestId('preview-stage')
		.screenshot({ path: resolve(proof, '02-default-preview.png') });

	await page.getByRole('button', { name: 'Inspect Zone entry', exact: true }).click();
	let state = await inspect(page);
	assert.equal(state.editorOnly.selectedEntryId, 'entry-2');
	assert.equal(state.presentation.visual.highlightedEntryId, 'entry-1');
	passed('editing selection does not change the graphic highlight');
	await page.getByRole('button', { name: 'Highlight Zone', exact: true }).click();
	state = await inspect(page);
	assert.equal(state.presentation.visual.highlightedEntryId, 'entry-2');
	assert.deepEqual(
		state.composition.entries.map((e) => e.score),
		[2, 1, 0, 3]
	);
	passed('manual highlight does not change scores or advance another state');
	await page.getByRole('button', { name: 'Increase Zone score' }).click();
	assert.equal((await page.getByTestId('rendered-score').allTextContents())[1], '2');
	await page.getByRole('spinbutton', { name: 'Zone score', exact: true }).fill('-2.5');
	state = await inspect(page);
	assert.equal(state.composition.entries[1].score, -2.5);
	assert.equal(state.editorOnly.lastChange.to, -2.5);
	passed('manual scores accept signed fractions and show the actual change');
	await page.getByRole('button', { name: 'Winner emphasis for Buzzz' }).click();
	state = await inspect(page);
	assert.deepEqual(state.presentation.visual.emphasizedEntryIds, ['entry-1']);
	assert.equal(state.presentation.visual.highlightedEntryId, 'entry-2');
	passed('winner treatment is independent of score and highlighted entry');

	await page.getByRole('button', { name: 'Move Buzzz later' }).click();
	state = await inspect(page);
	assert.equal(state.composition.entries[1].id, 'entry-1');
	assert.equal(state.presentation.visual.highlightedEntryId, 'entry-2');
	passed('reorder preserves entry identity and visual references');
	await page.getByRole('button', { name: 'Remove Leopard3 from battle' }).click();
	assert.equal(await page.getByTestId('disc-card').count(), 3);
	assert.equal(await page.getByTestId('shelf-disc').count(), 7);
	passed('3-card composition; removing an entry retains the source disc');
	await closeState(page);
	await page.getByLabel('Card layout', { exact: true }).selectOption('compact');
	await page.getByLabel('Card surface', { exact: true }).selectOption('paper');
	await page.getByLabel('Preview backdrop', { exact: true }).selectOption('dark');
	await page
		.getByTestId('preview-stage')
		.screenshot({ path: resolve(proof, '03-compact-three-manual-states.png') });
	passed('same cards compose in compact/paper treatment on dark background');
	await page.getByLabel('Preview width', { exact: true }).selectOption('320');
	assert.equal(await page.locator('.density-note').count(), 1);
	passed('undersized compositions expose a density warning');
	await page.getByRole('button', { name: 'Layout stack', exact: true }).click();
	await page.getByTestId('preview-stage').screenshot({ path: resolve(proof, '04-stack.png') });
	await page.getByRole('button', { name: 'Layout grid', exact: true }).click();
	await page.getByTestId('preview-stage').screenshot({ path: resolve(proof, '05-grid.png') });
	passed('row, stack and grid are projection controls, not new compositions');

	await page.getByRole('button', { name: 'DiscCard', exact: true }).click();
	await page.getByLabel('Card layout', { exact: true }).selectOption('showcase');
	await page.getByLabel('Card hierarchy', { exact: true }).selectOption('flight');
	await page.getByLabel('Preview backdrop', { exact: true }).selectOption('neutral');
	await page.getByRole('button', { name: 'Winner', exact: true }).click();
	await page.getByRole('button', { name: 'Compare states', exact: true }).click();
	assert.equal(await page.getByTestId('disc-card').count(), 4);
	passed('single specimen and side-by-side idle/highlight/winner states reuse DiscCard');
	await page.screenshot({ path: resolve(proof, '06-card-workbench.png'), fullPage: true });
	await page.getByRole('button', { name: 'Hide comparison', exact: true }).click();

	// Synthetic input, explicitly NOT a physical disc photo. Tests the real local decode path.
	const png = await page.evaluate(() => {
		const canvas = document.createElement('canvas');
		canvas.width = 600;
		canvas.height = 360;
		const c = canvas.getContext('2d');
		c.fillStyle = '#f0e8cd';
		c.fillRect(0, 0, 600, 360);
		c.fillStyle = '#254333';
		c.fillRect(15, 15, 570, 330);
		c.fillStyle = '#bce17a';
		c.beginPath();
		c.arc(300, 180, 125, 0, Math.PI * 2);
		c.fill();
		c.fillStyle = '#203731';
		c.textAlign = 'center';
		c.font = 'bold 26px sans-serif';
		c.fillText('PHOTO PIPELINE TEST', 300, 174);
		c.font = '14px sans-serif';
		c.fillText('Synthetic fixture · not a disc photo', 300, 206);
		c.fillStyle = '#fff';
		c.font = '16px sans-serif';
		c.fillText('TOP LEFT', 70, 38);
		c.fillText('BOTTOM RIGHT', 515, 330);
		return canvas.toDataURL('image/png').split(',')[1];
	});
	writeFileSync(resolve(proof, 'photo-pipeline-fixture.png'), Buffer.from(png, 'base64'));
	await page.getByLabel('Exact disc photo', { exact: true }).setInputFiles({
		name: 'synthetic-photo-pipeline-test.png',
		mimeType: 'image/png',
		buffer: Buffer.from(png, 'base64')
	});
	await page.getByRole('button', { name: 'Replace exact photo', exact: true }).waitFor();
	assert.equal(await page.getByTestId('preview-stage').locator('img').count(), 1);
	assert.equal(
		await page
			.getByTestId('preview-stage')
			.locator('img')
			.evaluate((i) => i.naturalWidth),
		600
	);
	passed('local photo selection decodes and displays the original image aspect ratio');
	await dismiss(page);
	await page
		.getByTestId('preview-stage')
		.screenshot({ path: resolve(proof, '07-image-pipeline-contain.png') });
	await page.getByLabel('Photo framing', { exact: true }).selectOption('cover');
	await page
		.getByTestId('preview-stage')
		.screenshot({ path: resolve(proof, '08-image-pipeline-cover.png') });
	assert.equal(
		await page
			.getByTestId('preview-stage')
			.locator('img')
			.evaluate((i) => getComputedStyle(i).objectFit),
		'cover'
	);
	passed('contain/cover changes presentation without replacing source bytes');
	await page
		.getByLabel('Exact disc photo', { exact: true })
		.setInputFiles({ name: 'bad.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>') });
	await page.getByRole('alert').waitFor();
	assert.match(await page.getByRole('alert').textContent(), /JPEG, PNG or WebP/);
	passed('unsupported image is rejected without replacing the previous image');
	await dismiss(page);

	await page.getByRole('button', { name: 'Create a disc', exact: true }).click();
	await page.getByRole('textbox', { name: 'Disc name', exact: true }).fill('My actual disc');
	await page.getByRole('textbox', { name: 'Disc manufacturer', exact: true }).fill('Manual maker');
	state = await inspect(page);
	const created = state.domain.find((d) => d.mold === 'My actual disc');
	assert(created);
	assert.equal(created.flight.speed, null);
	await page.getByRole('button', { name: 'Duplicate disc', exact: true }).click();
	state = await inspect(page);
	assert.equal(state.domain.filter((d) => d.mold === 'My actual disc').length, 2);
	passed(
		'manual add and duplicate create independent specimen identities; unknown ratings stay unknown'
	);
	await page.getByRole('button', { name: 'Remove', exact: true }).click();
	state = await inspect(page);
	assert.equal(state.domain.filter((d) => d.mold === 'My actual disc').length, 1);
	passed('unused specimen deletion works');
	await page.getByLabel('Search discs', { exact: true }).fill('My actual disc');
	assert.equal(await page.getByTestId('shelf-disc').count(), 1);
	await page.getByTestId('shelf-disc').click();
	await page.getByRole('button', { name: '+ Add selected to battle', exact: true }).click();
	state = await inspect(page);
	assert.equal(state.composition.entries.length, 4);
	const addedEntry = state.composition.entries.at(-1);
	assert.equal(addedEntry.discId, created.id);
	assert.equal(addedEntry.score, 0);
	passed('search and add-to-battle reuse the chosen specimen without another data-entry step');
	await page.getByRole('spinbutton', { name: 'My actual disc score', exact: true }).fill('7');
	await page.getByLabel('Search discs', { exact: true }).fill('Mako3');
	await page.getByTestId('shelf-disc').click();
	await page.getByRole('button', { name: 'Replace “My actual disc”', exact: true }).click();
	state = await inspect(page);
	assert.equal(state.composition.entries.at(-1).id, addedEntry.id);
	assert.equal(state.composition.entries.at(-1).score, 7);
	assert.equal(
		state.domain.find((d) => d.id === state.composition.entries.at(-1).discId).mold,
		'Mako3'
	);
	await page.getByLabel('Search discs', { exact: true }).fill('');
	passed('replacing a participant preserves the entry identity and score');
	await page.getByLabel('Load workspace draft', { exact: true }).setInputFiles({
		name: 'invalid.json',
		mimeType: 'application/json',
		buffer: Buffer.from('{"version":99}')
	});
	await page.getByRole('alert').waitFor();
	assert.match(await page.getByRole('alert').textContent(), /not changed/);
	passed('invalid draft import is atomic and visibly rejected');
	await closeState(page);
	await dismiss(page);

	const nativeStorageAvailable = await page.evaluate(() => {
		try {
			return Boolean(localStorage);
		} catch {
			return false;
		}
	});
	const storagePage = await newPage(1536, 1100, offline ? {} : undefined);
	await storagePage.getByRole('button', { name: 'Increase Buzzz score' }).click();
	await storagePage.waitForTimeout(500);
	const saved = await storagePage.evaluate(() => localStorage.getItem('chainspot.disc-studio.v1'));
	assert.equal(JSON.parse(saved).battle.entries[0].score, 3);
	assert(!saved.includes('selectedEntryId'));
	await storagePage.close();
	const restored = await newPage(
		1536,
		1100,
		offline ? { 'chainspot.disc-studio.v1': saved } : undefined
	);
	if (!offline) {
		// newPage uses an isolated context, so replay the saved draft in this context then reload.
		await restored.evaluate((raw) => localStorage.setItem('chainspot.disc-studio.v1', raw), saved);
		await restored.reload();
		await restored.getByRole('button', { name: 'Increase Buzzz score' }).waitFor();
	}
	assert.equal((await inspect(restored)).composition.entries[0].score, 3);
	passed(
		offline
			? 'storage integration: autosave + remount restore with an explicitly injected Storage fixture'
			: 'native browser storage: autosave + reload restore'
	);
	await restored.close();

	await page.getByRole('button', { name: 'DiscBattle 4', exact: true }).click();
	const beforeImport = (await inspect(page)).composition;
	page.once('dialog', (dialog) => dialog.dismiss());
	await page.getByLabel('Load workspace draft', { exact: true }).setInputFiles({
		name: 'valid-cancelled.json',
		mimeType: 'application/json',
		buffer: Buffer.from(saved)
	});
	await page.waitForTimeout(100);
	assert.deepEqual((await inspect(page)).composition, beforeImport);
	page.once('dialog', (dialog) => dialog.accept());
	await page.getByLabel('Load workspace draft', { exact: true }).setInputFiles({
		name: 'valid-workspace.json',
		mimeType: 'application/json',
		buffer: Buffer.from(saved)
	});
	await page.getByRole('button', { name: 'Increase Buzzz score', exact: true }).waitFor();
	state = await inspect(page);
	assert.equal(state.composition.entries[0].score, 3);
	assert.equal(state.domain.length, 7);
	passed('valid JSON draft import requires confirmation and restores the saved composition');
	page.once('dialog', (dialog) => dialog.accept());
	await page.getByRole('button', { name: 'Reset', exact: true }).click();
	assert.equal((await inspect(page)).composition.entries[0].score, 2);
	passed('explicit reset restores the seed workspace');

	const mobile = await newPage(390, 844);
	await dismiss(mobile);
	assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth), 390);
	await mobile.getByRole('button', { name: 'Increase Buzzz score' }).click();
	assert.equal((await mobile.getByTestId('rendered-score').allTextContents())[0], '3');
	await mobile.screenshot({ path: resolve(proof, '09-mobile.png'), fullPage: true });
	passed('390px viewport has no document overflow and score controls remain operable');
	await mobile.close();

	assert.deepEqual(errors, []);
	passed('no uncaught browser JavaScript errors');
	writeFileSync(
		resolve(proof, 'receipt.json'),
		JSON.stringify(
			{
				mode: offline
					? 'production HTML rendered via page.setContent on about:blank'
					: 'normal URL navigation',
				url: offline ? null : url,
				nativeStorageAvailable,
				storageIntegration: offline ? 'explicit test Storage fixture' : 'native browser Storage',
				browser: await browser.version(),
				checks,
				errors,
				limitations: offline
					? [
							'System Chromium URLBlocklist blocks localhost navigation. Hosted URL not browser-verified here.',
							'Main screenshots use native opaque-origin behavior; persistent-storage integration separately uses an injected fixture.'
						]
					: []
			},
			null,
			2
		)
	);
	console.log(`${checks.length} browser checks passed. Proof: ${proof}`);
} finally {
	await browser.close();
}
