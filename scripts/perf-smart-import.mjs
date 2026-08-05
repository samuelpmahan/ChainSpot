/**
 * P1-002 Chromium performance measurement for smart-import analysis.
 *
 * This is a standalone measurement tool, deliberately NOT part of the Playwright
 * test suite (no *.spec.ts), so it does not consume any Phase 1 test budget.
 *
 * It boots the dev server and a Chromium browser, installs a long-task
 * PerformanceObserver, imports the repository-controlled large smart-import set
 * (four 1600x1200 tiles), and reports:
 *   - total wall time from file selection to the analysis result publishing;
 *   - how much of that time the main thread spent in long tasks (>50ms);
 *   - the number of long tasks.
 *
 * The result decides whether a worker is justified (P1-002: introduce one only
 * if measurements show unacceptable main-thread blocking). Regenerate the large
 * set on demand with the fixture generator; the source of truth is
 * `tests/helpers/smartMap.js`.
 *
 * Usage:
 *   node scripts/perf-smart-import.mjs
 */
import { spawn, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const largeDir = join(root, 'tests', 'fixtures', 'smart-import-large');
const fixtureFiles = ['smart-ul.png', 'smart-ur.png', 'smart-ll.png', 'smart-lr.png'].map(
	(name) => join(largeDir, name)
);

if (!existsSync(join(largeDir, 'smart-ul.png'))) {
	console.log('Large fixture set missing; generating it...');
	execSync('node scripts/generate-smart-import-fixtures.mjs --large', { cwd: root, stdio: 'inherit' });
}

const server = spawn('npm', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', '5199'], {
	cwd: root,
	stdio: ['ignore', 'pipe', 'inherit']
});
let serverUrl = 'http://127.0.0.1:5199';

function waitForServer(url, timeoutMs) {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		const attempt = () => {
			if (Date.now() - started > timeoutMs) return reject(new Error('dev server did not start'));
			fetch(url)
				.then(() => resolve())
				.catch(() => setTimeout(attempt, 250));
		};
		attempt();
	});
}

async function main() {
	await waitForServer(serverUrl, 30000);

	const browser = await chromium.launch();
	const page = await browser.newPage();
	await page.addInitScript(() => {
		const taskTimes = [];
		new PerformanceObserver((list) => {
			for (const entry of list.getEntries()) {
				taskTimes.push({ duration: entry.duration, startTime: entry.startTime });
			}
		}).observe({ type: 'longtask', buffered: true });
		window.__longTasks = taskTimes;
	});

	try {
		await page.goto(`${serverUrl}/stitch-map`, { waitUntil: 'domcontentloaded' });
		await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');

		const started = Date.now();
		await page.getByTestId('smart-import-input').setInputFiles(fixtureFiles);
		await page.getByTestId('smart-import-assignment').waitFor({ state: 'visible', timeout: 120000 });
		const elapsedMs = Date.now() - started;

		const longTasks = await page.evaluate(() => window.__longTasks);
		const longTaskMs = longTasks.reduce((sum, task) => sum + task.duration, 0);
		const maxLongTaskMs = longTasks.reduce((max, task) => Math.max(max, task.duration), 0);

		console.log('Smart-import performance (four 1600x1200 tiles, Chromium):');
		console.log(`  analysis-to-result wall time:  ${elapsedMs} ms`);
		console.log(`  long tasks (>50ms):            ${longTasks.length}`);
		console.log(`  main-thread long-task time:    ${Math.round(longTaskMs)} ms`);
		console.log(`  largest single long task:      ${Math.round(maxLongTaskMs)} ms`);
		console.log(
			`  verdict: ${longTasks.length > 0 ? 'main-thread blocking observed; a single focused worker is justified' : 'no long tasks; no worker needed'}`
		);
	} finally {
		await browser.close();
		server.kill();
	}
}

main().catch((error) => {
	console.error(error);
	server.kill();
	process.exitCode = 1;
});
