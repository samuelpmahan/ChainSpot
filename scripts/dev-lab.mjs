import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';

// LAB development consumes the latest build's real S0 snapshot, exactly as production does.
// Run build:staging first to refresh it. dev:app retains the application's regular route tree.
const snapshotPath = resolve('build/labui-s0/snapshot.json');
if (!existsSync(snapshotPath)) throw new Error('Run npm run build:staging before starting LAB development.');
const root = mkdtempSync(resolve('.chainspot-lab-dev-'));
const routes = join(root, 'routes');
const publicAssets = join(root, 'static');
const assets = join(publicAssets, 'labui-s0');
cpSync('src/routes', routes, { recursive: true });
cpSync('src/staging-routes', routes, { recursive: true, force: true });
cpSync('static', publicAssets, { recursive: true });
mkdirSync(assets, { recursive: true });
cpSync('build/labui-s0', assets, { recursive: true });
writeFileSync(join(routes, '+page.server.js'), `export function load() { return ${readFileSync(snapshotPath, 'utf8')}; }\n`);
const child = spawn(process.execPath, [resolve('node_modules/vite/bin/vite.js'), 'dev', ...process.argv.slice(2)], {
  stdio: 'inherit', env: { ...process.env, CHAINSPOT_SURFACE: 'staging', CHAINSPOT_ROUTES_DIR: routes, CHAINSPOT_ASSETS_DIR: publicAssets }
});
const clean = () => rmSync(root, { recursive: true, force: true });
child.on('error', error => { clean(); console.error(error); process.exitCode = 1; });
child.on('exit', code => { clean(); process.exitCode = code ?? 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
