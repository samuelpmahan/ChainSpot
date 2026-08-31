// @ts-nocheck
import {
  AVAILABILITY_MEANING,
  EXECUTABLE_SWEEP_GATES,
  HELP_CATALOG,
  ROOT_COMMANDS,
  SHELL_FORMS,
  allTopicIds,
  findHelpRecord,
  optionNamesForCommand,
  recordsForParent
} from './catalog.mjs';
import { renderHere } from './context.mjs';

const line = (text = '') => console.log(text);
const section = (title, items) => {
  if (!items?.length) return;
  line('');
  line(`${title}:`);
  for (const item of items) line(`  ${item}`);
};

function describeOption(entry) {
  const pieces = [entry.name + (entry.value ? ` ${entry.value}` : ''), '—', entry.summary];
  if (entry.default !== undefined) pieces.push(`(default ${entry.default})`);
  if (entry.appliesTo) pieces.push(`[${entry.appliesTo}]`);
  if (entry.constraints) pieces.push(`{${entry.constraints}}`);
  if (entry.availability && entry.availability !== 'AVAILABLE') pieces.push(`[${entry.availability}]`);
  return pieces.join(' ');
}

export function printRootHelp() {
  line('LAB — tools for seeing, navigating, measuring, testing, and learning ChainSpot CV');
  line('');
  line('Usage:');
  line('  lab <command> [args]     one-shot');
  line('  lab help [COMMAND | TOPIC]');
  line('  lab help --all');
  line('  lab help here            read-only local context');
  line('  lab                      interactive shell');
  for (const group of ['SETUP', 'CONTEXT', 'LEARN', 'STUDY', 'LOOK', 'KNOW', 'RUN', 'PROVENANCE']) {
    const entries = ROOT_COMMANDS.filter((entry) => entry.group === group);
    if (!entries.length) continue;
    line('');
    line(group);
    for (const entry of entries) line(`  ${entry.id.padEnd(12)} ${entry.summary} [${entry.availability}]`);
  }
  line('');
  line('SHELL');
  for (const entry of SHELL_FORMS) line(`  ${entry.forms.join(' | ').padEnd(30)} ${entry.summary}`);
  section('Cold checkout', ['All catalog help, `set`, and `tutorial` run without LAB TypeScript dependencies.', 'Run `lab setup` before executing TypeScript-backed operations.']);
  section('Discover', ['lab help scope path', 'lab scope path --help', 'lab help gate-vocabulary', 'lab help availability']);
  section('Truthful limits', ['`sweep` remains the only algorithm execution path.', 'UI Sweep has no --through and always runs the full plan.', 'Use `lab help known-limits` for registered/parked source boundaries.']);
}

export function printRecordHelp(record) {
  line(`${record.title} [${record.availability}]`);
  line(record.summary);
  if (record.availability !== 'AVAILABLE') line(`Availability: ${AVAILABILITY_MEANING[record.availability]}`);
  section('Usage', record.forms);
  section('Options', record.options.map(describeOption));
  section('Examples', record.examples.map((example) => example.startsWith('lab ') ? example : `lab ${example}`));
  section('Writes / effects', record.sideEffects);
  section('Outputs', record.outputs);
  section('Caveats', record.caveats);
  const children = [...new Map([
    ...recordsForParent(record.id),
    ...record.subtopics.map((id) => findHelpRecord(id)).filter(Boolean)
  ].map((entry) => [entry.id, entry])).values()];
  if (children.length) section('Nested help', children.map((entry) => `lab help ${entry.id.replace('/', ' ')} — ${entry.summary}`));
}

function distance(a, b) {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    for (let j = 0; j <= b.length; j++) previous[j] = current[j];
  }
  return previous[b.length];
}

export function nearestName(value, candidates) {
  const normalized = String(value ?? '').toLowerCase();
  return [...candidates].sort((a, b) => distance(normalized, a.toLowerCase()) - distance(normalized, b.toLowerCase()) || a.localeCompare(b))[0];
}

export function printUnknownHelp(query) {
  const wanted = Array.isArray(query) ? query.join(' ') : String(query ?? '');
  const suggestion = nearestName(wanted.replace(/\s+/g, '/'), allTopicIds());
  console.error(`lab help: unknown topic '${wanted}'.${suggestion ? ` Did you mean '${suggestion.replace('/', ' ')}'?` : ''}`);
  console.error('Try: lab help --all');
  return 2;
}

export function printCommandHelp(query) {
  const parts = Array.isArray(query) ? query : String(query ?? '').trim().split(/\s+/);
  if (!parts.length || !parts[0]) return (printRootHelp(), 0);
  if (parts.length === 1 && parts[0] === '--all') return printAllHelp();
  if (parts.length === 1 && parts[0] === 'here') return renderHere();
  const record = findHelpRecord(parts);
  if (!record) return printUnknownHelp(parts);
  printRecordHelp(record);
  return 0;
}

export function printAllHelp() {
  line(`LAB COMPLETE REFERENCE — ${HELP_CATALOG.length} catalog records`);
  for (const record of HELP_CATALOG) {
    line('\n' + '='.repeat(78));
    printRecordHelp(record);
  }
  return 0;
}

export function printUnknownCommand(name) {
  const valid = ROOT_COMMANDS.map((entry) => entry.id);
  const suggestion = nearestName(name, valid);
  console.error(`lab: unknown command '${name}'.${suggestion ? ` Did you mean '${suggestion}'?` : ''}`);
  console.error(`Valid commands: ${valid.join(', ')}.`);
  console.error('Try: lab help');
  return 2;
}

export function helpTopicForInvocation(command, args) {
  if (command === 'sweep' && args.some((arg) => arg === 'batch')) return ['sweep', 'batch'];
  if (command === 'sweep' && args.includes('--through')) return ['sweep', 'through'];
  const winner = [command];
  const candidate = [command];
  for (const arg of args) {
    if (arg.startsWith('-')) continue;
    candidate.push(arg);
    if (findHelpRecord(candidate)) winner.splice(0, winner.length, ...candidate);
  }
  return winner;
}

function recordForInvocation(command, args) {
  return findHelpRecord(helpTopicForInvocation(command, args)) ?? findHelpRecord(command);
}

const NAMED_SUBCOMMANDS = Object.freeze({
  search: ['start', 'add', 'back', 'show', 'branch', 'revisit', 'log', 'list', 'page', 'pin', 'keep', 'release', 'pins'],
  traverse: ['start', 'go', 'back', 'show', 'log', 'list']
});

export function checkContextualSubcommands(command, args) {
  const known = NAMED_SUBCOMMANDS[command];
  if (!known) return 0;
  const first = args.find((arg) => !arg.startsWith('-'));
  if (!first || known.includes(first)) {
    if (command === 'search' && first === 'page') {
      const pageIndex = args.indexOf('page');
      const next = args.slice(pageIndex + 1).find((arg) => !arg.startsWith('-'));
      const pageNames = ['new', 'use', 'list', 'show', 'clear'];
      if (next && !pageNames.includes(next)) {
        const suggestion = nearestName(next, pageNames);
        console.error(`lab search page: unknown action '${next}'.${suggestion ? ` Did you mean '${suggestion}'?` : ''}`);
        console.error(`Valid local names: ${pageNames.join(', ')}.`);
        console.error('Try: lab help search page');
        return 2;
      }
    }
    if (command === 'search' && first === 'pin') {
      const pinIndex = args.indexOf('pin');
      const raw = args.slice(pinIndex + 1);
      const values = [];
      for (let index = 0; index < raw.length; index++) {
        if (raw[index].startsWith('--')) { index++; continue; }
        values.push(raw[index]);
      }
      if (values[0] === 'here' && values.length !== 2) {
        console.error('lab search pin here: requires NAME.');
        console.error('Valid local forms: pin here NAME | pin NAME x,y | pin style NAME STYLE.');
        console.error('Try: lab help search pin');
        return 2;
      }
      if (values[0] === 'style' && values.length !== 3) {
        console.error('lab search pin style: requires NAME and STYLE.');
        console.error('Valid styles: ring-dot, crosshair, diamond.');
        console.error('Try: lab help search pin style');
        return 2;
      }
      if (values[0] && values[0] !== 'here' && values[0] !== 'style' && values.length < 2) {
        console.error(`lab search pin: '${values[0]}' needs an x,y coordinate.`);
        console.error('Valid local forms: pin NAME x,y | pin here NAME | pin style NAME STYLE.');
        console.error('Try: lab help search pin');
        return 2;
      }
    }
    return 0;
  }
  const suggestion = nearestName(first, known);
  console.error(`lab ${command}: unknown action '${first}'.${suggestion ? ` Did you mean '${suggestion}'?` : ''}`);
  console.error(`Valid local names: ${known.join(', ')}.`);
  console.error(`Try: lab help ${command}`);
  return 2;
}

export function checkContextualOptions(command, args) {
  const record = recordForInvocation(command, args);
  const known = record?.strictOptions ? record.options.map((entry) => entry.name) : optionNamesForCommand(command);
  for (const arg of args) {
    if (!arg.startsWith('--') || arg === '--') continue;
    if (known.includes(arg) || arg === '--help') continue;
    const suggestion = nearestName(arg, known);
    const path = helpTopicForInvocation(command, args).join(' ');
    console.error(`lab ${path}: unknown option '${arg}'.${suggestion ? ` Did you mean '${suggestion}'?` : ''}`);
    console.error(`Valid local options: ${known.length ? known.join(', ') : '(none)'}.`);
    if (command === 'sweep') console.error(`Gate vocabulary: --through accepts ${EXECUTABLE_SWEEP_GATES.join(', ')}; shared is cross-gate infrastructure, not a cutoff.`);
    console.error(`Try: lab help ${path}`);
    return 2;
  }
  if (command === 'sweep') {
    const index = args.indexOf('--through');
    if (index >= 0) {
      const gate = args[index + 1];
      if (!EXECUTABLE_SWEEP_GATES.includes(gate)) {
        const suggestion = gate ? nearestName(gate, EXECUTABLE_SWEEP_GATES) : undefined;
        console.error(`lab sweep: --through requires one executable gate: ${EXECUTABLE_SWEEP_GATES.join(', ')}.${suggestion ? ` Did you mean '${suggestion}'?` : ''}`);
        console.error('`shared` names cross-gate infrastructure and is intentionally not an execution cutoff.');
        console.error('Try: lab help gate-vocabulary');
        return 2;
      }
    }
  }
  return 0;
}

export function completionCandidates(line) {
  const words = String(line ?? '').trimStart().split(/\s+/).filter(Boolean);
  const rootNames = ROOT_COMMANDS.map((entry) => entry.id);
  const shellNames = ['help', 'history', 'run-script', 'exit', 'quit'];
  if (words.length <= 1) {
    const prefix = words[0] ?? '';
    return [...rootNames, ...shellNames].filter((name) => name.startsWith(prefix));
  }
  if (words[0] === 'help') {
    const parts = words.slice(1);
    const prefix = parts.pop() ?? '';
    const parent = parts.join('/');
    const target = parent ? `${parent}/${prefix}` : prefix;
    return ['--all', 'here', ...allTopicIds()]
      .filter((name) => name.startsWith(target))
      .map((name) => parent && name.startsWith(`${parent}/`) ? name.slice(parent.length + 1) : name);
  }
  const command = words[0];
  const prefix = words.at(-1) ?? '';
  const positional = words.slice(1).filter((word) => !word.startsWith('-'));
  const parent = positional.length > 1 ? `${command}/${positional.slice(0, -1).join('/')}` : command;
  const children = recordsForParent(parent).map((entry) => entry.id.slice(parent.length + 1));
  const aliases = HELP_CATALOG.flatMap((entry) => entry.aliases)
    .filter((alias) => alias.startsWith(`${parent}/`) && !alias.slice(parent.length + 1).includes('/'))
    .map((alias) => alias.slice(parent.length + 1));
  return [...children, ...aliases, ...optionNamesForCommand(command), '--help'].filter((name) => name.startsWith(prefix));
}

export function browserHelpPayload(query) {
  const record = findHelpRecord(query);
  return {
    source: 'chainspot-lab-help-catalog',
    record,
    related: record ? recordsForParent(record.id).map((entry) => ({ id: entry.id, title: entry.title, summary: entry.summary })) : []
  };
}
