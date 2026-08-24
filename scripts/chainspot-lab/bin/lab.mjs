#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const HERE = dirname(fileURLToPath(import.meta.url));
const LAB_DIR = resolve(HERE, '..');
const REPO_ROOT = resolve(LAB_DIR, '../..');
const TSX = resolve(LAB_DIR, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');

const COMMANDS = {
  scope: {
    group: 'LOOK',
    summary: 'inspect image regions, trace geometry/search, batch, contact-sheet',
    examples: ['scope --help', 'scope course.png 880,429', 'scope --manifest manifest.json'],
    run: (args) => runTs('scope/scopeCli.ts', args),
  },
  invariants: {
    group: 'KNOW',
    summary: 'observed renderer truths',
    examples: ['invariants', 'invariants I21'],
    run: (args) => runTs('invariants.ts', args),
  },
  detectors: {
    group: 'KNOW',
    summary: 'detector registry',
    examples: ['detectors', 'detectors D04'],
    run: (args) => runTs('detectors.ts', args),
  },
  gates: {
    group: 'KNOW',
    summary: 'pipeline/gate vocabulary',
    examples: ['gates', 'gates 3'],
    run: (args) => runTs('gates.ts', args),
  },
  cases: {
    group: 'KNOW',
    summary: 'hard-evidence cases',
    examples: ['cases'],
    run: (args) => runTs('cases.ts', args),
  },
  compile: {
    group: 'RUN',
    summary: 'inspect/compile an algorithm config; no raster execution',
    examples: ['compile packages/alg/src/detectors/threeFactor/configs/default.json'],
    run: (args) => runTs('sweep/sweepCli.ts', ['compile', ...args]),
  },
  sweep: {
    group: 'RUN',
    summary: 'the only LAB command that executes the algorithm against raster input',
    examples: ['sweep CONFIG.json IMAGE.png', 'sweep CONFIG.json IMAGE.png TRUTH.json'],
    run: (args) => runTs('sweep/sweepCli.ts', ['sweep', ...args]),
  },
  orient: {
    group: 'PROVENANCE',
    summary: 'machine-bound frozen-reference auditor',
    examples: ['orient 3fd72', 'orient 3fd72 --verbose'],
    run: (args) => runOrient(args),
  },
};

const BUILT_INS = new Set(['help', 'history', 'run-script', 'exit', 'quit']);

function printRootHelp() {
  console.log('LAB — tools for seeing, measuring, testing, and learning ChainSpot CV');
  console.log('');
  console.log('Usage:');
  console.log('  lab <command> [args]     one-shot');
  console.log('  lab                      interactive shell');
  console.log('');
  for (const group of ['LOOK', 'KNOW', 'RUN', 'PROVENANCE']) {
    console.log(group);
    for (const [name, command] of Object.entries(COMMANDS)) {
      if (command.group === group) console.log(`  ${name.padEnd(12)} ${command.summary}`);
    }
    console.log('');
  }
  console.log('SHELL');
  console.log('  help [command]            show discoverable help');
  console.log('  history                   show commands entered in this shell');
  console.log('  run-script FILE           execute LAB commands from a text file, in order');
  console.log('  exit | quit               leave interactive LAB');
  console.log('');
  console.log('Discover from here:');
  console.log('  lab help scope');
  console.log('  lab scope --help');
  console.log('  lab help sweep');
  console.log('');
  console.log('LAB does not expose an arbitrary shell/eval escape. `sweep` remains the algorithm execution path.');
}

function printCommandHelp(name) {
  const command = COMMANDS[name];
  if (!command) {
    console.error(`lab: unknown command '${name}'.`);
    printRootHelp();
    return 2;
  }
  console.log(`${name.toUpperCase()} — ${command.summary}`);
  console.log('');
  console.log('Examples:');
  for (const example of command.examples) console.log(`  lab ${example}`);
  if (name === 'scope') console.log('\nFor the full operation surface: lab scope --help');
  return 0;
}

function ensureTsx() {
  if (!existsSync(TSX)) {
    throw new Error('LAB dependencies are not installed. Run: (cd scripts/chainspot-lab && npm install)');
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

async function runTs(relativeFile, args) {
  ensureTsx();
  return spawnProcess(TSX, [resolve(LAB_DIR, relativeFile), ...args]);
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
      if (ch === quote) {
        quote = null;
        continue;
      }
      if (ch === '\\' && next === quote) {
        token += next;
        i++;
        continue;
      }
      token += ch;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (token) {
        out.push(token);
        token = '';
      }
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
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    console.error(`lab: could not read script ${path}: ${error.message}`);
    return 1;
  }
  let lineNumber = 0;
  for (const raw of text.split(/\r?\n/)) {
    lineNumber++;
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    console.log(`lab[${lineNumber}]> ${line}`);
    let argv;
    try {
      argv = splitCommandLine(line);
    } catch (error) {
      console.error(`lab: ${path}:${lineNumber}: ${error.message}`);
      return 2;
    }
    const code = await dispatch(argv, state, { fromScript: true });
    if (code !== 0) return code;
  }
  return 0;
}

async function dispatch(argv, state = { history: [] }, options = {}) {
  if (argv.length === 0) return 0;
  const [name, ...args] = argv;

  if (name === '--help' || name === '-h') {
    printRootHelp();
    return 0;
  }
  if (name === 'help') {
    if (args.length === 0) {
      printRootHelp();
      return 0;
    }
    return printCommandHelp(args[0]);
  }
  if (name === 'history') {
    if (state.history.length === 0) console.log('(no interactive history yet)');
    else state.history.forEach((entry, index) => console.log(`${String(index + 1).padStart(3)}  ${entry}`));
    return 0;
  }
  if (name === 'run-script') {
    if (args.length !== 1) {
      console.error('Usage: lab run-script FILE');
      return 2;
    }
    return runScript(args[0], state);
  }
  if (name === 'exit' || name === 'quit') return options.fromScript ? 0 : 'exit';

  const command = COMMANDS[name];
  if (!command) {
    console.error(`lab: unknown command '${name}'. Try: lab --help`);
    return 2;
  }

  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h') && name !== 'scope') {
    return printCommandHelp(name);
  }

  try {
    return await command.run(args);
  } catch (error) {
    console.error(`lab: ${error.message}`);
    return 1;
  }
}

async function repl() {
  const names = [...Object.keys(COMMANDS), ...BUILT_INS].sort();
  const state = { history: [] };
  const rl = createInterface({
    input,
    output,
    prompt: 'lab> ',
    completer(line) {
      const prefix = line.trimStart();
      const hits = names.filter((name) => name.startsWith(prefix));
      return [hits.length ? hits : names, prefix];
    },
  });

  console.log('ChainSpot LAB. `help` to discover; `exit` to leave.');
  rl.prompt();
  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (!line) {
      rl.prompt();
      continue;
    }
    state.history.push(line);
    let argv;
    try {
      argv = splitCommandLine(line);
    } catch (error) {
      console.error(`lab: ${error.message}`);
      rl.prompt();
      continue;
    }
    const result = await dispatch(argv, state);
    if (result === 'exit') break;
    rl.prompt();
  }
  rl.close();
}

const argv = process.argv.slice(2);
if (argv.length === 0) {
  await repl();
} else {
  const code = await dispatch(argv);
  process.exitCode = code === 'exit' ? 0 : code;
}
