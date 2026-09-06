import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepareS0Viewer } from './prepare-s0-viewer.mjs';

function overlayRoutes(from, to) {
	mkdirSync(to, { recursive: true });
	for (const entry of readdirSync(from, { withFileTypes: true })) {
		const source = join(from, entry.name);
		const target = join(to, entry.name);
		if (entry.isDirectory()) overlayRoutes(source, target);
		else cpSync(source, target, { force: true });
	}
}

// Keep the generated tree below the repository so Node/Vite resolve workspace
// packages exactly as they do for src/routes. The finally block always shears
// it away after the staging-only compilation.
const routeRoot = mkdtempSync(resolve('.chainspot-staging-routes-'));
const viewerAssets = resolve('static/labui-s0');
if (existsSync(viewerAssets)) throw new Error('static/labui-s0 is reserved for generated S0 outputs');

try {
	cpSync(resolve('src/routes'), routeRoot, { recursive: true });
	overlayRoutes(resolve('src/staging-routes'), routeRoot);
	await prepareS0Viewer(routeRoot, viewerAssets);
	const vite = resolve('node_modules/vite/bin/vite.js');
	const result = spawnSync(process.execPath, [vite, 'build'], {
		stdio: 'inherit',
		env: { ...process.env, CHAINSPOT_SURFACE: 'staging', CHAINSPOT_ROUTES_DIR: routeRoot }
	});
	if (result.error) throw result.error;
	if (result.status !== 0)
		throw new Error(`staging build exited ${result.status ?? 'without status'}`);
	for (const page of ['build/index.html', 'build/labui-s0/snapshot.json', 'build/lab.html', 'build/lab/pcr.html']) {
		if (!existsSync(resolve(page))) throw new Error(`staging build omitted ${page}`);
	}
	console.log('STAGING_LAB_PRESENT build/lab.html build/lab/pcr.html');
} finally {
	rmSync(routeRoot, { recursive: true, force: true });
	rmSync(viewerAssets, { recursive: true, force: true });
}
