// Dumb JSON asset copy: mirrors every src/**/*.json into dist/, since we
// don't want to depend on tsc's own resolveJsonModule emission behavior.
import { readdir, mkdir, copyFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const srcDir = join(root, '..', 'src');
const distDir = join(root, '..', 'dist');

async function walk(dir) {
	const entries = await readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			await walk(full);
		} else if (entry.name.endsWith('.json')) {
			const rel = full.slice(srcDir.length + 1);
			const dest = join(distDir, rel);
			await mkdir(dirname(dest), { recursive: true });
			await copyFile(full, dest);
			console.log(`copied ${rel}`);
		}
	}
}

await walk(srcDir);
