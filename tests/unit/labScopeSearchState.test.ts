import { describe, expect, test } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	activePageName,
	addTempPin,
	addTrailPoint,
	ageTempPinsForPage,
	backTrail,
	backTraversal,
	branchTrail,
	emptySearchState,
	ensurePage,
	keepPin,
	loadSearchState,
	moveTraversal,
	pagesForImage,
	recordSuccessfulScope,
	releasePin,
	saveSearchState,
	startTrail,
	startTraversal,
	trailByName,
	trailsForPage,
	usePage,
	visibleTrailPoints
} from '../../scripts/chainspot-lab/search/searchState';

const IMAGE = '/tmp/course.png';
const IMAGE_ID = 'a'.repeat(64);

describe('LAB search state', () => {
	test('back removes visible evidence but preserves history and numbering', () => {
		let state = emptySearchState();
		state = startTrail(state, { name: 'shard-search', imagePath: IMAGE, imageId: IMAGE_ID, point: [10, 10] });
		state = addTrailPoint(state, 'shard-search', [20, 20]);
		state = addTrailPoint(state, 'shard-search', [30, 30]);
		state = addTrailPoint(state, 'shard-search', [40, 40]);
		state = backTrail(state, 'shard-search');
		state = addTrailPoint(state, 'shard-search', [50, 50]);
		const trail = trailByName(state, 'shard-search');
		expect(visibleTrailPoints(trail).map((point) => point.id)).toEqual([1, 2, 3, 5]);
		expect(trail.points.map((point) => point.id)).toEqual([1, 2, 3, 4, 5]);
		expect(state.events.some((event) => event.op === 'path-back' && event.pointId === 4)).toBe(true);
	});

	test('Pages separate messy scratch evidence from clean final overlays', () => {
		let state = emptySearchState();
		state = startTrail(state, { name: 'scratch-path', imagePath: IMAGE, imageId: IMAGE_ID, point: [1, 1], page: 'scratch' });
		state = addTrailPoint(state, 'scratch-path', [2, 2]);
		state = ensurePage(state, { imagePath: IMAGE, imageId: IMAGE_ID, page: 'final' });
		state = usePage(state, IMAGE_ID, 'final');
		state = branchTrail(state, 'scratch-path', 'final-path', 'final');
		expect(activePageName(state, IMAGE_ID)).toBe('final');
		expect(pagesForImage(state, IMAGE_ID).map((page) => page.name)).toEqual(['final', 'scratch']);
		expect(trailsForPage(state, IMAGE_ID, 'scratch').map((trail) => trail.name)).toEqual(['scratch-path']);
		expect(trailsForPage(state, IMAGE_ID, 'final').map((trail) => trail.name)).toEqual(['final-path']);
	});

	test('TempPin shown at ttl=1 remains keepable until the following inspection', () => {
		let state = emptySearchState();
		state = addTempPin(state, { name: 'maybe', imagePath: IMAGE, imageId: IMAGE_ID, page: 'scratch', point: [9, 9], ttl: 2 });
		expect(state.pins.maybe.style).toBe('ring-dot');
		state = ageTempPinsForPage(state, IMAGE_ID, 'scratch');
		expect(state.pins.maybe.ttlRemaining).toBe(1);
		state = recordSuccessfulScope(state, { imagePath: IMAGE, imageId: IMAGE_ID, page: 'scratch', focus: [10, 10] });
		expect(state.pins.maybe.ttlRemaining).toBe(1);
		state = keepPin(state, 'maybe');
		expect(state.pins.maybe.kind).toBe('kept');
		expect(state.pins.maybe.ttlRemaining).toBeNull();
		state = releasePin(state, 'maybe').state;
		expect(state.pins.maybe).toBeUndefined();
	});

	test('Traverse is Search trail state: move, back, history retained', () => {
		let state = emptySearchState();
		state = startTraversal(state, { name: 'course-walk', imagePath: IMAGE, imageId: IMAGE_ID, page: 'scratch', point: [100, 100], radiusPx: 75 });
		state = moveTraversal(state, 'course-walk', [175, 100], 'xy 75,0');
		state = moveTraversal(state, 'course-walk', [175, 175], 'xy 0,75');
		state = backTraversal(state, 'course-walk');
		const trail = trailByName(state, 'course-walk');
		expect(visibleTrailPoints(trail).map((point) => point.point)).toEqual([[100, 100], [175, 100]]);
		expect(trail.points.map((point) => point.point)).toEqual([[100, 100], [175, 100], [175, 175]]);
		expect(state.events.some((event) => event.op === 'traverse-back')).toBe(true);
	});

	test('v1 state migrates into scratch Page with ring-dot pins', () => {
		const dir = mkdtempSync(join(tmpdir(), 'lab-search-old-state-'));
		const path = join(dir, 'state.json');
		const old = {
			schemaVersion: 1,
			nextEventId: 1,
			trails: {},
			pins: { legacy: { name: 'legacy', imagePath: IMAGE, imageId: IMAGE_ID, point: [7, 8], kind: 'temp', ttlRemaining: 2 } },
			events: []
		};
		writeFileSync(path, JSON.stringify(old));
		const migrated = loadSearchState(path);
		expect(migrated.schemaVersion).toBe(2);
		expect(migrated.pins.legacy.style).toBe('ring-dot');
		expect(migrated.pins.legacy.page).toBe('scratch');
		expect(pagesForImage(migrated, IMAGE_ID).map((page) => page.name)).toEqual(['scratch']);
		saveSearchState(path, migrated);
		expect(loadSearchState(path)).toEqual(migrated);
	});
});
