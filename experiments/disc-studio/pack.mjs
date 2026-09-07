import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const dir = resolve(root, 'artifacts/disc-studio-site');
let html = readFileSync(resolve(dir, 'index.html'), 'utf8');
html = html.replace(
	/<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/g,
	(_, src) =>
		`<script type="module">${readFileSync(resolve(dir, src), 'utf8').replace(/<\/script/gi, '<\\/script')}</script>`
);
html = html.replace(
	/<link\b[^>]*\bhref="([^"]+\.css)"[^>]*>/g,
	(_, src) => `<style>${readFileSync(resolve(dir, src), 'utf8')}</style>`
);
writeFileSync(resolve(dir, 'ChainSpot-Disc-Studio.html'), html);
console.log('Standalone file:', resolve(dir, 'ChainSpot-Disc-Studio.html'));
