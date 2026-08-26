import { createServer } from 'node:net';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { describe, expect, test } from 'vitest';

const ROOT = resolve('.');
const SERVER = resolve('scripts/chainspot-lab/ui/server.ts');
const TSX = resolve('scripts/chainspot-lab/node_modules/tsx/dist/loader.mjs');

async function freePort(): Promise<number> {
	const server = createServer();
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const address = server.address();
	server.close();
	return typeof address === 'object' && address ? address.port : 0;
}

describe('LAB browser contextual-help API', () => {
	test('serves the same catalog record for the active UI mode', async () => {
		const port = await freePort();
		const child = spawn(process.execPath, ['--import', `file://${TSX}`, SERVER, '--port', String(port), '--no-open'], {
			cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LAB_SEARCH_STATE: resolve('/tmp/lab-help-api-search-state.json') }
		});
		try {
			await new Promise<void>((resolveReady, reject) => {
				const timer = setTimeout(() => reject(new Error('LAB UI did not start')), 8_000);
				child.stdout.on('data', (chunk) => {
					if (String(chunk).includes('LAB UI ->')) { clearTimeout(timer); resolveReady(); }
				});
				child.once('error', reject);
				child.stderr.on('data', (chunk) => reject(new Error(String(chunk))));
			});
			const response = await fetch(`http://127.0.0.1:${port}/api/help?topic=ui%2Fsweep`);
			expect(response.status).toBe(200);
			const payload = await response.json() as any;
			expect(payload.source).toBe('chainspot-lab-help-catalog');
			expect(payload.record.id).toBe('ui/sweep');
			expect(payload.record.availability).toBe('UI_ONLY');
			expect(payload.record.caveats.join(' ')).toContain('no --through');
			const context = await fetch(`http://127.0.0.1:${port}/api/help?context=sweep`);
			expect(context.status).toBe(200);
			expect((await context.json() as any).record.id).toBe('ui/sweep');
			const invalid = await fetch(`http://127.0.0.1:${port}/api/help?topic=not-a-topic`);
			expect(invalid.status).toBe(404);
			expect((await invalid.json() as any).error).toContain('unknown help topic');

			const html = readFileSync(resolve('scripts/chainspot-lab/ui/app/index.html'), 'utf8');
			const app = readFileSync(resolve('scripts/chainspot-lab/ui/app/app.js'), 'utf8');
			expect(html).toContain('aria-expanded="true"');
			expect(html).toContain('id="helpClose"');
			expect(html).toContain('id="sweepTruthStatus"');
			expect(app).toContain('function setHelpDrawerOpen');
			expect(app).toContain("event.key !== 'Escape'");
			expect(app).toContain("$('#helpClose').onclick = () => setHelpDrawerOpen(false, { focus: true })");
			expect(app).toContain('Truth scoreboard skipped:');
			expect(app).toContain('result.truthScoringReason');
		} finally {
			child.kill('SIGTERM');
			await once(child, 'exit').catch(() => undefined);
		}
	});
});
