import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const LAB_DIR = resolve(HERE, '..');
export const REPO_ROOT = resolve(LAB_DIR, '../..');
export const COURSE_MANIFEST_DIR = resolve(LAB_DIR, 'courses');
export const DEFAULT_CORPUS_ROOT = resolve(REPO_ROOT, '..', 'chainspot-corpus');
export const LAB_CONFIG_PATH = process.env.LAB_CONFIG
  ? resolve(process.env.LAB_CONFIG)
  : resolve(process.env.LAB_HOME ? process.env.LAB_HOME : resolve(REPO_ROOT, '.lab'), 'config.json');
export const LAB_PRESET_DIR = resolve(dirname(LAB_CONFIG_PATH), 'presets');
export const LAB_COMMAND_LOG = process.env.LAB_COMMAND_LOG
  ? resolve(process.env.LAB_COMMAND_LOG)
  : resolve(REPO_ROOT, 'artifacts', 'lab', 'commands.jsonl');

function normalized(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function words(value) {
  return String(value ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function initials(value) {
  return words(value).map((word) => word[0]).join('').toLowerCase();
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

export function listCourseManifests() {
  if (!existsSync(COURSE_MANIFEST_DIR)) return [];
  return readdirSync(COURSE_MANIFEST_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => ({ path: resolve(COURSE_MANIFEST_DIR, name), ...readJson(resolve(COURSE_MANIFEST_DIR, name)) }))
    .sort((a, b) => a.course.localeCompare(b.course));
}

function courseTokens(manifest) {
  const values = [manifest.course, manifest.devDir, ...(manifest.aliases ?? [])];
  return new Set([
    ...values.map(normalized),
    initials(manifest.course),
    initials(manifest.devDir)
  ].filter(Boolean));
}

export function resolveCourseManifest(query) {
  const q = normalized(query);
  if (!q) throw new Error('lab set: course name is empty.');
  const manifests = listCourseManifests();
  const exact = manifests.filter((manifest) => courseTokens(manifest).has(q));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw new Error(`lab set: '${query}' is ambiguous: ${exact.map((m) => m.course).join(', ')}`);

  if (q.length >= 2) {
    const prefix = manifests.filter((manifest) => [...courseTokens(manifest)].some((token) => token.startsWith(q)));
    if (prefix.length === 1) return prefix[0];
    if (prefix.length > 1) throw new Error(`lab set: '${query}' is ambiguous: ${prefix.map((m) => m.course).join(', ')}`);
  }
  throw new Error(`lab set: unknown course '${query}'. Try: lab set courses`);
}

export function emptyLabConfig() {
  return { version: 1, vars: {} };
}

export function loadLabConfig() {
  if (!existsSync(LAB_CONFIG_PATH)) return emptyLabConfig();
  const parsed = readJson(LAB_CONFIG_PATH);
  if (parsed.version !== 1 || !parsed.vars || typeof parsed.vars !== 'object') {
    throw new Error(`lab set: invalid config at ${LAB_CONFIG_PATH}`);
  }
  return parsed;
}

export function saveLabConfig(config) {
  writeJson(LAB_CONFIG_PATH, config);
  return config;
}

export function resolveCourseContext(config = loadLabConfig()) {
  if (!config.course) throw new Error('lab: no course selected. Run: lab set DT (or another course)');
  const manifest = resolveCourseManifest(config.course);
  const corpusRoot = resolve(config.corpusRoot ?? DEFAULT_CORPUS_ROOT);
  const devDir = resolve(corpusRoot, 'dev', manifest.devDir);
  return {
    config,
    manifest,
    corpusRoot,
    devDir,
    imagePath: resolve(devDir, manifest.image),
    annotationPath: manifest.annotation ? resolve(devDir, manifest.annotation) : undefined
  };
}

function prettyConfig(config) {
  const lines = [`config: ${LAB_CONFIG_PATH}`];
  if (config.course) {
    const ctx = resolveCourseContext(config);
    lines.push(`course: ${ctx.manifest.course}`);
    lines.push(`corpus: ${ctx.corpusRoot}`);
    lines.push(`image: ${ctx.imagePath}`);
    lines.push(`truth: ${ctx.annotationPath ?? '(none)'}`);
  } else {
    lines.push('course: (unset)');
    lines.push(`corpus: ${resolve(config.corpusRoot ?? DEFAULT_CORPUS_ROOT)}`);
  }
  const entries = Object.entries(config.vars ?? {});
  if (entries.length) {
    lines.push('vars:');
    for (const [key, value] of entries.sort(([a], [b]) => a.localeCompare(b))) lines.push(`  ${key}=${value}`);
  }
  return lines.join('\n');
}

function setCourse(config, query) {
  const manifest = resolveCourseManifest(query);
  const next = { ...config, course: manifest.course };
  saveLabConfig(next);
  console.log(`course -> ${manifest.course}`);
  console.log(prettyConfig(next));
  return 0;
}

function presetPath(name) {
  const safe = String(name ?? '').trim();
  if (!/^[a-zA-Z0-9._-]+$/.test(safe)) throw new Error('lab set: preset name must use letters, numbers, dot, underscore, or dash.');
  return resolve(LAB_PRESET_DIR, `${safe}.json`);
}

export function runSetCommand(args) {
  let config = loadLabConfig();
  if (args.length === 0 || args[0] === 'show') {
    console.log(prettyConfig(config));
    return 0;
  }
  if (args[0] === 'courses') {
    for (const manifest of listCourseManifests()) {
      const short = initials(manifest.course).toUpperCase();
      console.log(`${short.padEnd(4)} ${manifest.course.padEnd(18)} dev/${manifest.devDir}`);
    }
    return 0;
  }
  if (args[0] === 'reset') {
    saveLabConfig(emptyLabConfig());
    console.log(`reset ${LAB_CONFIG_PATH}`);
    return 0;
  }
  if (args[0] === 'save') {
    if (args.length !== 2) throw new Error('Usage: lab set save NAME');
    const path = presetPath(args[1]);
    writeJson(path, config);
    console.log(`preset saved -> ${path}`);
    return 0;
  }
  if (args[0] === 'load' || String(args[0]).startsWith('@')) {
    const name = args[0] === 'load' ? args[1] : String(args[0]).slice(1);
    if (!name || (args[0] === 'load' && args.length !== 2)) throw new Error('Usage: lab set load NAME');
    const path = presetPath(name);
    if (!existsSync(path)) throw new Error(`lab set: preset '${name}' does not exist at ${path}`);
    config = readJson(path);
    saveLabConfig(config);
    console.log(`preset -> ${name}`);
    console.log(prettyConfig(config));
    return 0;
  }
  if (args[0] === 'course') {
    if (args.length !== 2) throw new Error('Usage: lab set course NAME');
    return setCourse(config, args[1]);
  }
  if (args[0] === 'corpus' || args[0] === 'corpusRoot') {
    if (args.length !== 2) throw new Error('Usage: lab set corpus PATH');
    const next = { ...config, corpusRoot: resolve(args[1]) };
    saveLabConfig(next);
    console.log(prettyConfig(next));
    return 0;
  }
  if (args[0] === 'unset') {
    if (args.length !== 2) throw new Error('Usage: lab set unset KEY');
    const key = args[1];
    if (key === 'course') {
      const { course, ...next } = config;
      saveLabConfig(next);
      console.log(prettyConfig(next));
      return 0;
    }
    if (key === 'corpus' || key === 'corpusRoot') {
      const { corpusRoot, ...next } = config;
      saveLabConfig(next);
      console.log(prettyConfig(next));
      return 0;
    }
    const vars = { ...(config.vars ?? {}) };
    delete vars[key];
    const next = { ...config, vars };
    saveLabConfig(next);
    console.log(prettyConfig(next));
    return 0;
  }
  if (args.length === 1) return setCourse(config, args[0]);
  if (args.length === 2) {
    const [key, value] = args;
    const next = { ...config, vars: { ...(config.vars ?? {}), [key]: value } };
    saveLabConfig(next);
    console.log(prettyConfig(next));
    return 0;
  }
  throw new Error('Usage: lab set [COURSE | KEY VALUE | save/load/unset ...]');
}

export function appendLabCommand(entry) {
  mkdirSync(dirname(LAB_COMMAND_LOG), { recursive: true });
  const config = loadLabConfig();
  appendFileSync(LAB_COMMAND_LOG, JSON.stringify({
    at: new Date().toISOString(),
    course: config.course ?? null,
    ...entry
  }) + '\n');
}

export function guardTruthTaint(argv) {
  appendLabCommand({ argv, taints: ['truth'] });
  if (process.env.LAB_TEST_RUN === '1' || process.env.LAB_BLIND_TEST === '1') {
    throw new Error('LAB TRUTH-TAINT: --truth is forbidden in an automated blind/test run. The tainted command was logged.');
  }
}

export function printTutorial() {
  console.log([
    'LAB TUTORIAL — learn the visual loop on one hole',
    '',
    '0. Cold checkout:',
    '   ./lab --help',
    '   ./lab setup',
    '',
    '1. Pick the course by lazy name/initials:',
    '   ./lab set DT',
    '',
    '2. Look at Hole 1 using only the course manifest viewport:',
    '   ./lab scope h1',
    '',
    '3. Now ask for the teaching answer:',
    '   ./lab scope h1 --truth',
    '',
    '   --truth is deliberately TAINTED. It is logged and auto-fails when',
    '   LAB_TEST_RUN=1 or LAB_BLIND_TEST=1. Use it to learn, never to certify.',
    '',
    '4. Inspect your persisted context:',
    '   ./lab set',
    '',
    '5. Next:',
    '   ./lab search --help',
    '   ./lab traverse --help',
    '   ./lab ui',
    '',
    'The rule: manifests may tell you where a hole is worth looking; Annotation truth',
    'may tell you the answer only when you explicitly request --truth.'
  ].join('\n'));
}
