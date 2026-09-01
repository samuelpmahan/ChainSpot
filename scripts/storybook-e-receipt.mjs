import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { materializeBadgeSpecimens } from '../.storybook/storybookBadgeSource.mjs';

const library = await materializeBadgeSpecimens();
const index = JSON.parse(readFileSync(resolve('storybook-static/index.json'), 'utf8'));
const entries = Object.values(index.entries);
const stories = entries.filter((entry) => entry.type === 'story');
const docs = entries.filter((entry) => entry.type === 'docs');
const pinned = library.specimens.find((specimen) => specimen.id === 'badge-0');
if (library.status !== 'materialized') throw new Error(library.note);
if (library.specimens.length !== 18)
	throw new Error(`expected 18 real specimens; got ${library.specimens.length}`);
if (!pinned) throw new Error('badge-0 missing from materialized specimen library');

const receipt = {
	source: library.source,
	specimens: library.specimens.length,
	indexedProjections: stories.length,
	composedNotebooks: docs.length,
	pinnedBadge0: pinned.metrics,
	provenance: pinned.provenance
};

mkdirSync(resolve('artifacts/storybook-e'), { recursive: true });
writeFileSync(
	resolve('artifacts/storybook-e/receipt.json'),
	`${JSON.stringify(receipt, null, 2)}\n`
);
console.log('STORYBOOK E RECEIPT');
console.log(`real specimens: ${receipt.specimens} (live DashsTrack materialization)`);
console.log(`indexed projections: ${receipt.indexedProjections} (storybook-static/index.json)`);
console.log(`composed notebooks: ${receipt.composedNotebooks} (storybook-static/index.json)`);
console.log(
	`badge-0: B+W ${pinned.metrics.ownedBw}; AA +${pinned.metrics.aaAdded}; residue ${pinned.metrics.residueBefore} -> ${pinned.metrics.residueAfter}`
);
console.log('machine receipt: artifacts/storybook-e/receipt.json');
