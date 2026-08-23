import { pathToFileURL } from 'node:url';

import { CASE_CARDS } from './cases';
import { DETECTOR_CARDS } from './detectors';
import { LAB_GATES } from './gates';
import { INVARIANT_CARDS } from './invariants';

export type KnownObjectCard = {
	id: string;
	title: string;
	status: 'measured' | 'observed' | 'archetype';
	tags: readonly string[];
	gates: readonly number[];
	detectors: readonly string[];
	invariants: readonly string[];
	cases: readonly string[];
	implementedBy: readonly string[];
	is: readonly string[];
	think: readonly string[];
	footnotes: readonly string[];
	retest: string;
};

export const KNOWN_OBJECT_CARDS: readonly KnownObjectCard[] = [
	{
		id: 'O00-tee',
		title: 'Tee',
		status: 'measured',
		tags: ['tee', 'known-object'],
		gates: [3, 4],
		detectors: ['D04-tee-candidates', 'D05-occluded-tee-recovery'],
		invariants: ['I09-tee-glyph-anatomy', 'I10-tee-aims-at-badge', 'I17-tee-on-neighbor-ring', 'I21-tee-family-signal'],
		cases: ['C00-tee-shard', 'C01-complete-occlusion'],
		implementedBy: ['src/lib/detectors/threeFactor/features/g3.endpoints.ts', 'g3.teeFamily.ts', 'configs/tee-family-on.json'],
		is: [
			'White-bordered grey rectangle, aims at badge (I10), one family/course (I21), occludable (I01, C00, C01).',
			'4/72 dev tees: outline gap, un-closable hollow. 16/72 on neighbor C2 ring (I17).'
		],
		think: [
			'Two-tier ring/component across all 72 dev tees.',
			'FRAGILE fit-to-dev-corpus: elongation ≥1.18 rect vs diamond reject bucket; component windows 8-42px area 80-350 fill 0.2-0.85.',
			'Family log-ratio 1.25 axes / 1.5 area, selection-only. First suspects on new-course G3 failures—Heritage 4 pending audit.'
		],
		footnotes: [
			'Diamond was once real tee; no citation. Reject-bucket names not objects.'
		],
		retest: 'npx vitest run tests/unit/corpusSweep.test.ts (G3 rows; per-candidate values in /lab trace)'
	}
] as const;

const gateIds = new Set(LAB_GATES.map(({ id }) => id));
const detectorIds = new Set(DETECTOR_CARDS.map(({ id }) => id));
const invariantIds = new Set(INVARIANT_CARDS.map(({ id }) => id));
const caseIds = new Set(CASE_CARDS.map(({ id }) => id));
const knownObjectIds = new Set<string>();
for (const card of KNOWN_OBJECT_CARDS) {
	if (knownObjectIds.has(card.id)) throw new Error(`Duplicate known-object card ${card.id}`);
	knownObjectIds.add(card.id);
	for (const gate of card.gates) {
		if (!gateIds.has(gate)) throw new Error(`${card.id} names unknown gate ${gate}`);
	}
	for (const detector of card.detectors) {
		if (!detectorIds.has(detector))
			throw new Error(`${card.id} names unknown detector ${detector}`);
	}
	for (const invariant of card.invariants) {
		if (!invariantIds.has(invariant))
			throw new Error(`${card.id} names unknown invariant ${invariant}`);
	}
	for (const caseId of card.cases) {
		if (!caseIds.has(caseId)) throw new Error(`${card.id} names unknown case ${caseId}`);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	console.log(`KNOWN_OBJECT_CARDS.length = ${KNOWN_OBJECT_CARDS.length}`);
}
