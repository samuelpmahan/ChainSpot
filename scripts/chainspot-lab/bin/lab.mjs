#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { assertBlindCommandLogClean, printTutorial, runSetCommand } from '../context/context.mjs';
import {
  checkContextualOptions,
  checkContextualSubcommands,
  completionCandidates,
  helpTopicForInvocation,
  printCommandHelp,
  printRootHelp,
  printUnknownCommand
} from '../help/render.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LAB_DIR = resolve(HERE, '..');
const REPO_ROOT = resolve(LAB_DIR, '../..');
const requireFromLab = createRequire(import.meta.url);
let tsxImportPath = null;

const COMMANDS = {
  setup: {
    run: () => runSetup(),
  },
  set: {
    run: (args) => runSetCommand(args),
  },
  tutorial: {
    run: () => (printTutorial(), 0),
  },
  ui: {
    run: (args) => runTs('ui/server.ts', args),
  },
  scope: {
    run: (args) => runTs('scope/scopeCli.ts', args),
  },
  search: {
    run: (args) => runTs('search/searchCli.ts', args),
  },
  traverse: {
    run: (args) => runTs('traverse/traverseCli.ts', args),
  },
  invariants: {
    run: (args) => runTs('invariants.ts', args),
  },
  detectors: {
    run: (args) => runTs('detectors.ts', args),
  },
  gates: {
    run: (args) => runTs('gates.ts', args),
  },
  cases: {
    run: (args) => runTs('cases.ts', args),
  },
  compile: {
    run: (args) => runTs('sweep/sweepCli.ts', ['compile', ...args]),
  },
  sweep: {
    run: (args) => runTs('sweep/sweepCli.ts', ['sweep', ...args]),
  },
  orient: {
    run: (args) => runOrient(args),
  },
};

function ensureTsxImport() {
  if (tsxImportPath) return tsxImportPath;
  try {
    tsxImportPath = requireFromLab.resolve('tsx');
    return tsxImportPath;
  } catch {
    throw new Error('LAB runtime dependencies are not installed. Run: ./lab setup');
  }
}

function spawnProcess(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      shell: process.platform === 'win32' && command.toLowerCase().endsWith('.cmd'),
      ...options,
    });
    child.once('error', rejectPromise);
    child.once('exit', (code, signal) => {
      if (signal) rejectPromise(new Error(`command terminated by ${signal}`));
      else resolvePromise(code ?? 1);
    });
  });
}

async function runSetup() {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  console.log(`LAB setup: npm install (${LAB_DIR})`);
  return spawnProcess(npm, ['install'], {
    cwd: LAB_DIR,
    shell: process.platform === 'win32',
  });
}

async function runTs(relativeFile, args) {
  assertBlindCommandLogClean();
  return spawnProcess(process.execPath, [
    '--import',
    pathToFileURL(ensureTsxImport()).href,
    resolve(LAB_DIR, relativeFile),
    ...args,
  ]);
}

async function runOrient(args) {
  if (args[0] !== '3fd72' || args.length > 2 || (args[1] && args[1] !== '--verbose')) {
    console.error('Usage: lab orient 3fd72 [--verbose]');
    return 2;
  }
  return spawnProcess(process.execPath, [resolve(REPO_ROOT, 'scripts/lab-orient-3fd72.mjs'), ...args.slice(1)]);
}

function splitCommandLine(line) {
  const out = [];
  let token = '';
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = line[i + 1];
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      if (ch === '\\' && next === quote) { token += next; i++; continue; }
      token += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (/\s/.test(ch)) {
      if (token) { out.push(token); token = ''; }
      continue;
    }
    if (ch === '\\' && next && (/\s/.test(next) || next === '"' || next === "'" || next === '\\')) {
      token += next;
      i++;
      continue;
    }
    token += ch;
  }
  if (quote) throw new Error(`unterminated ${quote} quote`);
  if (token) out.push(token);
  return out;
}

async function runScript(filePath, state) {
  const path = resolve(process.cwd(), filePath);
  let text;
  try { text = readFileSync(path, 'utf8'); }
  catch (error) { console.error(`lab: could not read script ${path}: ${error.message}`); return 1; }
  let lineNumber = 0;
  for (const raw of text.split(/\r?\n/)) {
    lineNumber++;
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    console.log(`lab[${lineNumber}]> ${line}`);
    let argv;
    try { argv = splitCommandLine(line); }
    catch (error) { console.error(`lab: ${path}:${lineNumber}: ${error.message}`); return 2; }
    const code = await dispatch(argv, state, { fromScript: true });
    if (code !== 0) return code;
  }
  return 0;
}

async function dispatch(argv, state = { history: [] }, options = {}) {
  if (!argv.length) return 0;
  const [name, ...args] = argv;
  if (name === '--help' || name === '-h') { printRootHelp(); return 0; }
  if (name === 'help') return args.length ? printCommandHelp(args) : (printRootHelp(), 0);
  if (name === 'history') { state.history.forEach((entry, index) => console.log(`${String(index + 1).padStart(3)}  ${entry}`)); return 0; }
  if (name === 'run-script') {
    if (args.length !== 1) { console.error('Usage: lab run-script FILE'); return 2; }
    return runScript(args[0], state);
  }
  if (name === 'exit' || name === 'quit') return options.fromScript ? 0 : 'exit';
  const command = COMMANDS[name];
  if (!command) return printUnknownCommand(name);

  if (args.includes('--help') || args.includes('-h')) {
    return printCommandHelp(helpTopicForInvocation(name, args));
  }

  const localNameError = checkContextualSubcommands(name, args);
  if (localNameError !== 0) return localNameError;
  const contextualError = checkContextualOptions(name, args);
  if (contextualError !== 0) return contextualError;

  try { return await command.run(args); }
  catch (error) { console.error(`lab: ${error.message}`); return 1; }
}

async function repl() {
  const state = { history: [] };
  const rl = createInterface({
    input,
    output,
    prompt: 'lab> ',
    completer(line) {
      const prefix = line.trimStart().split(/\s+/).at(-1) ?? '';
      const candidates = completionCandidates(line);
      return [candidates.length ? candidates : completionCandidates(''), prefix];
    },
  });
  console.log('ChainSpot LAB. `help` to discover; `exit` to leave.');
  rl.prompt();
  for await (const raw of rl) {
    const line = raw.trim();
    if (!line) { rl.prompt(); continue; }
    state.history.push(line);
    try {
      const result = await dispatch(splitCommandLine(line), state);
      if (result === 'exit') break;
    } catch (error) {
      console.error(`lab: ${error.message}`);
    }
    rl.prompt();
  }
  rl.close();
}

const argv = process.argv.slice(2);
if (!argv.length) await repl();
else {
  const code = await dispatch(argv);
  process.exitCode = code === 'exit' ? 0 : code;
}
