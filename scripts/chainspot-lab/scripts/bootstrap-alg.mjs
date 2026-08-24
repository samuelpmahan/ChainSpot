import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(args) {
  const result = spawnSync(npm, args, { cwd: REPO_ROOT, stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const requiredRootDeps = [
  resolve(REPO_ROOT, 'node_modules/typescript'),
  resolve(REPO_ROOT, 'node_modules/jpeg-js'),
  resolve(REPO_ROOT, 'node_modules/pngjs'),
];

if (!requiredRootDeps.every(existsSync)) {
  console.log('[LAB setup] installing repository dependencies required to build @chainspot/alg...');
  run(['install', '--ignore-scripts']);
}

console.log('[LAB setup] building local @chainspot/alg...');
run(['--workspace', '@chainspot/alg', 'run', 'build']);
