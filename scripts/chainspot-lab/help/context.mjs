// @ts-nocheck
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LAB_CONFIG_PATH, REPO_ROOT } from '../context/context.mjs';

const SEARCH_STATE_PATH = process.env.LAB_SEARCH_STATE
  ? resolve(process.env.LAB_SEARCH_STATE)
  : resolve(REPO_ROOT, 'artifacts', 'search', 'search-state.json');

function readJsonIfPresent(path) {
  if (!existsSync(path)) return { present: false };
  try { return { present: true, value: JSON.parse(readFileSync(path, 'utf8')) }; }
  catch (error) { return { present: true, error: error.message }; }
}

/**
 * Read-only contextual help.  Deliberately restricted to config and Search
 * state: no annotation/truth file is opened, no operation is invoked, and no
 * state file is created or changed.
 */
export function renderHere() {
  const blind = process.env.LAB_TEST_RUN === '1' || process.env.LAB_BLIND_TEST === '1';
  const config = readJsonIfPresent(LAB_CONFIG_PATH);
  const search = readJsonIfPresent(SEARCH_STATE_PATH);
  const lines = ['HERE — read-only LAB context', '', 'Effects: zero writes; zero algorithm operations; no Annotation/truth read.'];
  if (!config.present) lines.push('Course context: unset (no LAB config yet). Try: lab help set');
  else if (config.error) lines.push(`Course context: config unreadable (${config.error}). Try: lab help set`);
  else lines.push(`Course context: ${config.value?.course ?? 'unset'}${config.value?.course ? ' (from config only)' : ''}.`);

  if (!search.present) lines.push('Search context: no saved Search state. Try: lab help search');
  else if (search.error) lines.push(`Search context: state unreadable (${search.error}). Try: lab help search`);
  else {
    const pages = Object.keys(search.value?.pages ?? {}).length;
    const trails = Object.keys(search.value?.trails ?? {}).length;
    const traversals = Object.keys(search.value?.traversals ?? {}).length;
    lines.push(`Search context: ${pages} Page(s), ${trails} trail(s), ${traversals} traversal(s) (state summary only).`);
  }

  lines.push('', 'Next safe help: lab help scope | lab help search | lab help traverse | lab help sweep');
  if (blind) lines.push('Blind mode: truth-assisted suggestions are suppressed.');
  console.log(lines.join('\n'));
  return 0;
}

export const HELP_HERE_PATHS = Object.freeze({ config: LAB_CONFIG_PATH, search: SEARCH_STATE_PATH });
