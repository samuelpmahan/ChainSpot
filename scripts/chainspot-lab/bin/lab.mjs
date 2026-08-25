#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const HERE = dirname(fileURLToPath(import.meta.url));
const LAB_DIR = resolve(HERE, '..');
const REPO_ROOT = resolve(LAB_DIR, '../..');
const requireFromLab = createRequire(import.meta.url);
let tsxImportPath = null;

const COMMANDS = {
  setup: {
    group: 'SETUP',
    summary: 'install/build LAB dependencies from a cold checkout',
    examples: ['setup'],
    usage: [
      'lab setup',
      '',
      'Runs npm install inside scripts/chainspot-lab.',
      'LAB postinstall then bootstraps/builds the local @chainspot/alg workspace.',
      'No TypeScript runtime is required to discover or invoke setup.'
    ],
    run: () => runSetup(),
  },
  ui: {
    group: 'LOOK',
    summary: 'open the local clickable LAB workbench',
    examples: ['ui', 'ui --port 4317', 'ui --no-open'],
    usage: [
      'lab ui [--port N] [--no-open]',
      '',
      'Starts a localhost-only human workbench over the same LAB operations as CLI:',
      '  Scope · Search Pages/pins/trails · Traverse · Sweep',
      '',
      '--port N     listen on 127.0.0.1:N (default 4317)',
      '--no-open    do not launch the browser automatically'
    ],
    run: (args) => runTs('ui/server.ts', args),
  },
  scope: {
    group: 'LOOK',
    summary: 'stateless canonical raster inspection',
    examples: ['scope course.png 880,429', 'scope full course.png', 'scope --hole 7 course.png truth.json'],
    usage: [
      'lab scope IMAGE x,y [view flags]',
      'lab scope IMAGE x,y,w,h [view flags]',
      'lab scope full IMAGE [view flags]',
      'lab scope mark IMAGE NAME x,y [view flags]',
      'lab scope dots IMAGE NAME x,y x,y ... [view flags]',
      'lab scope path IMAGE NAME x,y x,y ... [view flags]',
      'lab scope --hole N IMAGE ANNOTATION.json [view flags]',
      'lab scope --manifest MANIFEST.json [--case NAME] [--out-dir DIR]',
      'lab scope contact-sheet MANIFEST.json [--case NAME] [--out FILE]',
      'lab scope templates',
      '',
      'Raster contract:',
      '  StripChrome -> AutoStitch -> canonical raster -> Scope AutoCrop',
      '  `scope full` is post-StripChrome/AutoStitch and pre-ScopeCrop.',
      '',
      'View flags:',
      '  --context N --context-out N --full-out N',
      '  --local-extra-w N --local-extra-h N --local-out N',
      '  --fw N --fm N --ft N --forensic-out N --no-grid',
      '',
      'Persistent investigation lives under: lab search --help'
    ],
    run: (args) => runTs('scope/scopeCli.ts', args),
  },
  search: {
    group: 'LOOK',
    summary: 'stateful visual investigation with Pages/pins/trails',
    examples: ['search start course.png h7 1143,1105', 'search page show scratch', 'search branch h7 h7-final --page final'],
    usage: [
      'lab search start IMAGE NAME x,y [--page PAGE] [view flags]',
      'lab search add NAME x,y [view flags]',
      'lab search back NAME [view flags]',
      'lab search branch NAME NEW_NAME [--page PAGE] [view flags]',
      'lab search show NAME [view flags]',
      'lab search revisit NAME POINT_NUMBER [view flags]',
      'lab search log NAME',
      'lab search list',
      '',
      'Pages:',
      '  lab search page new PAGE [IMAGE]',
      '  lab search page use PAGE [IMAGE]',
      '  lab search page list [IMAGE]',
      '  lab search page show PAGE [IMAGE] [view flags]',
      '  lab search page clear PAGE [IMAGE]',
      '',
      'Pins:',
      '  lab search pin NAME x,y [--ttl N] [--style ring-dot|crosshair|diamond] [--page PAGE]',
      '  lab search pin here NAME [--ttl N] [--style STYLE]',
      '  lab search pin style NAME STYLE',
      '  lab search keep NAME | release NAME | pins',
      '',
      'Pages change visible overlays, never the canonical raster.',
      'For spatial movement: lab traverse --help'
    ],
    run: (args) => runTs('search/searchCli.ts', args),
  },
  traverse: {
    group: 'LOOK',
    summary: 'hex-assisted Cartesian/polar navigation over Search',
    examples: ['traverse start course.png walk 700,900', 'traverse go walk 2', 'traverse go walk --polar 100,245'],
    usage: [
      'lab traverse start IMAGE NAME x,y [--radius N] [--page PAGE]',
      'lab traverse start IMAGE NAME --annotation FILE --start T7|N7|B7 [--radius N] [--page PAGE]',
      'lab traverse go NAME 1|2|3|4|5|6',
      'lab traverse go NAME --xy DX,DY',
      'lab traverse go NAME --polar DISTANCE,ANGLE',
      'lab traverse back NAME',
      'lab traverse show NAME',
      'lab traverse log NAME',
      'lab traverse list',
      '',
      'Hex neighbors are convenient suggestions, not movement constraints.',
      '+x = right, +y = down; polar 0° right, 90° down, 180° left, 270° up.',
      'Tn/Bn are annotation anchors. Nn is used only when annotation explicitly owns badge coordinates.'
    ],
    run: (args) => runTs('traverse/traverseCli.ts', args),
  },
  invariants: {
    group: 'KNOW', summary: 'observed renderer truths', examples: ['invariants', 'invariants I21'],
    usage: ['lab invariants [ID]', '', 'List observed renderer invariants, or inspect one invariant by ID.'],
    run: (args) => runTs('invariants.ts', args),
  },
  detectors: {
    group: 'KNOW', summary: 'detector registry', examples: ['detectors', 'detectors D04'],
    usage: ['lab detectors [ID]', '', 'List detector knowledge, or inspect one detector by ID.'],
    run: (args) => runTs('detectors.ts', args),
  },
  gates: {
    group: 'KNOW', summary: 'pipeline/gate vocabulary', examples: ['gates', 'gates 3'],
    usage: ['lab gates [ID]', '', 'List pipeline/gate knowledge, or inspect one gate.'],
    run: (args) => runTs('gates.ts', args),
  },
  cases: {
    group: 'KNOW', summary: 'hard-evidence cases', examples: ['cases'],
    usage: ['lab cases', '', 'List recorded hard-evidence cases.'],
    run: (args) => runTs('cases.ts', args),
  },
  compile: {
    group: 'RUN', summary: 'inspect/compile algorithm config; no raster execution',
    examples: ['compile packages/alg/src/detectors/threeFactor/configs/default.json'],
    usage: ['lab compile CONFIG.json', '', 'Parse, resolve, and compile an algorithm config without raster execution.'],
    run: (args) => runTs('sweep/sweepCli.ts', ['compile', ...args]),
  },
  sweep: {
    group: 'RUN', summary: 'StripChrome/AutoStitch + only algorithm execution path',
    examples: ['sweep CONFIG.json IMAGE.png', 'sweep CONFIG.json TILE1.png TILE2.png', 'sweep CONFIG.json IMAGE.png TRUTH.json'],
    usage: [
      'lab sweep CONFIG.json INPUT... [TRUTH.json]',
      '',
      'INPUT is one or more .png/.jpg/.jpeg captures.',
      'Sweep canonicalizes: decode -> StripChrome -> AutoStitch -> canonical raster -> algorithm.',
      'TRUTH is optional evaluation-only Annotation JSON.',
      'Sweep is the only LAB command that executes the algorithm plan.'
    ],
    run: (args) => runTs('sweep/sweepCli.ts', ['sweep', ...args]),
  },
  orient: {
    group: 'PROVENANCE', summary: 'machine-bound frozen-reference auditor', examples: ['orient 3fd72', 'orient 3fd72 --verbose'],
    usage: ['lab orient 3fd72 [--verbose]', '', 'Run the frozen 3fd72 reference auditor.'],
    run: (args) => runOrient(args),
  },
};

const BUILT_INS = new Set(['help', 'history', 'run-script', 'exit', 'quit']);

function printRootHelp() {
  console.log('LAB — tools for seeing, navigating, measuring, testing, and learning ChainSpot CV');
  console.log('');
  console.log('Usage:');
  console.log('  lab <command> [args]     one-shot');
  console.log('  lab                      interactive shell');
  console.log('');
  for (const group of ['SETUP', 'LOOK', 'KNOW', 'RUN', 'PROVENANCE']) {
    console.log(group);
    for (const [name, command] of Object.entries(COMMANDS)) {
      if (command.group === group) console.log(`  ${name.padEnd(12)} ${command.summary}`);
    }
    console.log('');
  }
  console.log('SHELL');
  console.log('  help [command]            dependency-free help');
  console.log('  history                   show commands entered in this shell');
  console.log('  run-script FILE           execute LAB commands in order');
  console.log('  exit | quit               leave interactive LAB');
  console.log('');
  console.log('Cold checkout:');
  console.log('  All help works before dependencies are installed.');
  console.log('  Run `lab setup` before executing TypeScript-backed operations.');
  console.log('');
  console.log('Raster contract:');
  console.log('  raw capture(s) -> Sweep StripChrome -> AutoStitch -> canonical raster -> Scope/Search/Traverse/algorithm');
  console.log('');
  console.log('Discover:');
  console.log('  lab scope --help');
  console.log('  lab search --help');
  console.log('  lab traverse --help');
  console.log('  lab ui --help');
  console.log('  lab sweep --help');
  console.log('');
  console.log('`ui` and CLI call the same LAB operation modules. `sweep` remains the only algorithm execution path.');
}

function printCommandHelp(name) {
  const command = COMMANDS[name];
  if (!command) {
    console.error(`lab: unknown command '${name}'. Try: lab --help`);
    return 2;
  }
  console.log(`${name.toUpperCase()} — ${command.summary}`);
  console.log('');
  console.log(command.usage.join('\n'));
  if (command.examples.length) {
    console.log('\nExamples:');
    for (const example of command.examples) console.log(`  lab ${example}`);
  }
  return 0;
}

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
  if (name === 'help') return args.length ? printCommandHelp(args[0]) : (printRootHelp(), 0);
  if (name === 'history') { state.history.forEach((entry, index) => console.log(`${String(index + 1).padStart(3)}  ${entry}`)); return 0; }
  if (name === 'run-script') {
    if (args.length !== 1) { console.error('Usage: lab run-script FILE'); return 2; }
    return runScript(args[0], state);
  }
  if (name === 'exit' || name === 'quit') return options.fromScript ? 0 : 'exit';
  const command = COMMANDS[name];
  if (!command) { console.error(`lab: unknown command '${name}'. Try: lab --help`); return 2; }

  // Recursive discovery must work from a completely cold checkout. Never touch
  // the TS loader for a help-only invocation.
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) return printCommandHelp(name);

  try { return await command.run(args); }
  catch (error) { console.error(`lab: ${error.message}`); return 1; }
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
