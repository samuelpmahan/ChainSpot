import { existsSync, mkdirSync } from 'node:fs';
import { discoverStageContracts } from '../sweep/stageOperation';
import { basename, extname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

const REPO = resolve('.');

function usage(): number {
	console.log(`STORY — materialize a Stage with Sweep, then look through the real Storybook Story

Usage:
  lab story STAGE IMAGE [--out FILE] [--view showReceipt=true|false]
  lab story --test STAGE IMAGE [--out FILE] [--view showReceipt=true|false]

Run binding:
  STAGE is discovered from the compiled Stage contracts; STAGE + IMAGE determine the precise "lab sweep --through" materialization.

View binding:
  --view showReceipt=... changes only Storybook projection.`);
	return 0;
}

function run(command: string, args: string[], options: { quiet?: boolean } = {}): Promise<number> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(command, args, {
			cwd: REPO,
			stdio: options.quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit'
		});
		child.once('error', reject);
		child.once('exit', (code, signal) => {
			if (signal) reject(new Error(`${command} terminated by ${signal}`));
			else resolvePromise(code ?? 1);
		});
	});
}

async function openPort(): Promise<number> {
	return new Promise((resolvePromise, reject) => {
		const server = createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			if (!address || typeof address === 'string')
				return reject(new Error('could not allocate Storybook port'));
			const port = address.port;
			server.close(() => resolvePromise(port));
		});
	});
}

async function waitFor(url: string, timeoutMs = 30_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let last = '';
	while (Date.now() < deadline) {
		try {
			const response = await fetch(url);
			if (response.ok) return;
			last = `${response.status} ${response.statusText}`;
		} catch (error) {
			last = error instanceof Error ? error.message : String(error);
		}
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
	}
	throw new Error(`Storybook did not become ready: ${last}`);
}

function parse(argv: string[]) {
	if (argv.includes('--help') || argv.includes('-h')) return { help: true } as const;
	const args = [...argv];
	const test = args[0] === '--test';
	if (test) args.shift();
	const stage = args.shift();
	const image = args.shift();
	let out: string | undefined;
	let showReceipt = true;
	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--out' && args[i + 1]) out = args[++i];
		else if (args[i] === '--view' && args[i + 1]) {
			const view = args[++i];
			const match = /^showReceipt=(true|false)$/.exec(view);
			if (!match) throw new Error(`unsupported View Arg '${view}'`);
			showReceipt = match[1] === 'true';
		} else throw new Error(`unknown Story argument '${args[i]}'`);
	}
	return { help: false, test, stage, image, out, showReceipt } as const;
}

export async function runStoryCli(argv = process.argv.slice(2)): Promise<number> {
	let request;
	try {
		request = parse(argv);
	} catch (error) {
		console.error(`lab story: ${error instanceof Error ? error.message : String(error)}`);
		return 2;
	}
	if (request.help) return usage();
	if (!request.stage || !request.image) {
		usage();
		return 2;
	}
	const availableStages = discoverStageContracts().map((contract) => contract.id);
	if (!availableStages.includes(request.stage)) {
		console.error(`lab story: unknown Stage '${request.stage}'; available=[${availableStages.join(', ')}].`);
		return 2;
	}
	if (!existsSync(request.image)) {
		console.error(`lab story: input does not exist: ${request.image}`);
		return 2;
	}

	const stage = request.stage;
	const image = resolve(request.image);
	const runName = basename(image, extname(image));
	const out = resolve(request.out ?? `artifacts/story/${runName}-${stage}.png`);
	mkdirSync(resolve(out, '..'), { recursive: true });

	console.log(`STORY materialize: ./lab sweep --through ${stage} "${image}"`);
	let code = await run(resolve(REPO, 'lab'), ['sweep', '--through', stage, image]);
	if (code !== 0) return code;

	const browserEnv = {
		...process.env,
		PLAYWRIGHT_BROWSERS_PATH: resolve(REPO, '.playwright-browsers'),
		GIT_CONFIG_COUNT: '1',
		GIT_CONFIG_KEY_0: 'safe.directory',
		GIT_CONFIG_VALUE_0: REPO,
		VITE_CHAINSPOT_STORY_STAGE: stage,
		VITE_CHAINSPOT_STORY_RUN_NAME: runName,
		VITE_CHAINSPOT_STORY_SHOW_RECEIPT: String(request.showReceipt)
	};

	if (request.test) {
		console.log(`STORY test: vitest --project=storybook ${stage}`);
		return await new Promise((resolvePromise, reject) => {
			const child = spawn(
				resolve(REPO, 'node_modules/.bin/vitest'),
				['run', '--config', 'vitest.storybook.config.ts'],
				{ cwd: REPO, stdio: 'inherit', env: browserEnv }
			);
			child.once('error', reject);
			child.once('exit', (exitCode, signal) => {
				if (signal) reject(new Error(`vitest terminated by ${signal}`));
				else resolvePromise(exitCode ?? 1);
			});
		});
	}

	const port = await openPort();
	const storybook = spawn(
		resolve(REPO, 'node_modules/.bin/storybook'),
		['dev', '-p', String(port), '--no-open', '--quiet'],
		{ cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], env: browserEnv }
	);
	let serverError = '';
	storybook.stderr?.on('data', (chunk) => {
		serverError += String(chunk);
	});
	try {
		await waitFor(`http://127.0.0.1:${port}/index.json`);
		const { chromium } = await import('playwright');
		const browser = await chromium.launch({ headless: true });
		try {
			const page = await browser.newPage({ viewport: { width: 2400, height: 1600 } });
			const storyId = 'lab-stages--stage';
			const args = `stage:${encodeURIComponent(stage)};runName:${encodeURIComponent(runName)};showReceipt:${request.showReceipt}`;
			const url = `http://127.0.0.1:${port}/iframe.html?id=${storyId}&viewMode=story&args=${args}`;
			await page.goto(url, { waitUntil: 'networkidle' });
			await page.locator('main').waitFor({ state: 'visible' });
			await page.screenshot({ path: out, fullPage: true });
		} finally {
			await browser.close();
		}
		if (!existsSync(out)) {
			console.error(`lab story: Playwright did not materialize ${out}`);
			return 1;
		}
		console.log(`STORY percept: ${out}`);
		return 0;
	} catch (error) {
		console.error(`lab story: ${error instanceof Error ? error.message : String(error)}`);
		if (serverError.trim()) console.error(serverError.trim());
		return 1;
	} finally {
		storybook.kill('SIGTERM');
	}
}

process.exitCode = await runStoryCli();
