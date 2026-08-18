/**
 * CLI launcher for Toph's local counterfactual-replay diagnostic viewer,
 * wired to the Pancake CV pipeline via `createChainSpotReplayAdapter`.
 *
 * Usage:
 *   npx tsx scripts/toph-viewer.ts --image resources/cv-fixtures/TheRec-stitched.png \
 *     [--session .toph-sessions/the-rec] [--port 4173] [--toph-dir <path>] [--truth <path>]
 *
 * Requirements: both repos checked out on disk (ChainSpot and Toph), `tsx`
 * available (this repo's devDependency), and Toph's own dependencies
 * installed (`npm install` in the Toph checkout) since the viewer imports
 * Toph's TypeScript sources directly by path -- there is no npm package
 * dependency between the two repos. tophDir resolution order: `--toph-dir`
 * flag, then `TOPH_DIR` env var, then `../toph` sibling of this repo, then
 * `/workspace/toph`.
 */
import { existsSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createChainSpotReplayAdapter } from './toph-replay-adapter';

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv: readonly string[]): {
	image: string;
	session: string;
	port: number;
	tophDir: string;
	truthPath?: string;
} {
	const get = (flag: string): string | undefined => {
		const index = argv.indexOf(flag);
		return index >= 0 ? argv[index + 1] : undefined;
	};
	const image = get('--image');
	if (!image) {
		throw new Error(
			'Usage: npx tsx scripts/toph-viewer.ts --image <path> [--session <dir>] [--port <n>] [--toph-dir <path>] [--truth <path>]'
		);
	}
	const tophDir = get('--toph-dir') ?? process.env.TOPH_DIR ?? resolveDefaultTophDir();
	return {
		image,
		session: get('--session') ?? '.toph-sessions/the-rec',
		port: Number(get('--port') ?? '4173'),
		tophDir,
		truthPath: get('--truth')
	};
}

function resolveDefaultTophDir(): string {
	const sibling = resolve(__dirname, '..', '..', 'toph');
	if (existsSync(sibling)) return sibling;
	return '/workspace/toph';
}

function contentTypeFor(path: string): string {
	switch (extname(path).toLowerCase()) {
		case '.png':
			return 'image/png';
		case '.jpg':
		case '.jpeg':
			return 'image/jpeg';
		default:
			return 'application/octet-stream';
	}
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const projectRoot = resolve(__dirname, '..');
	const tophDir = resolve(args.tophDir);
	if (!existsSync(tophDir)) {
		throw new Error(`Toph checkout not found at ${tophDir}. Pass --toph-dir, set TOPH_DIR, or check out the sibling repo.`);
	}

	const adapter = await createChainSpotReplayAdapter({
		imagePath: resolve(args.image),
		projectRoot,
		tophDir,
		truthPath: args.truthPath ? resolve(args.truthPath) : undefined
	});

	const serverUrl = pathToFileURL(resolve(tophDir, 'src/viewer/server.ts')).href;
	const { startReplayViewer } = (await import(serverUrl)) as typeof import('/workspace/toph/src/viewer/server.js');

	const handle = await startReplayViewer({
		sessionDir: resolve(projectRoot, args.session),
		adapter,
		port: args.port,
		sourceImage: { path: resolve(args.image), contentType: contentTypeFor(args.image) }
	});

	console.log(`Toph replay viewer listening at http://localhost:${handle.port}`);
	console.log(`Session dir: ${resolve(projectRoot, args.session)}`);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
