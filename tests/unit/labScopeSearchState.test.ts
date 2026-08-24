import { describe, expect, test } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	addTempPin,
	addTrailPoint,
	ageTempPinsForImage,
	backTrail,
	branchTrail,
	emptySearchState,
	keepPin,
	loadSearchState,
	recordSuccessfulScope,
	releasePin,
	saveSearchState,
	startTrail,
	trailByName,
	visibleTrailPoints
} from '../../scripts/chainspot-lab/scope/searchState';

const IMAGE = '/tmp/course.png';
const IMAGE_ID = 'a'.repeat(64);

describe('LAB scope search state', () => {
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

	test('branch copies only currently visible evidence', () => {
		let state = emptySearchState();
		state = startTrail(state, { name: 'a', imagePath: IMAGE, imageId: IMAGE_ID, point: [1, 1] });
		state = addTrailPoint(state, 'a', [2, 2]);
		state = addTrailPoint(state, 'a', [3, 3]);
		state = backTrail(state, 'a');
		state = branchTrail(state, 'a', 'b');
		const branch = trailByName(state, 'b');
		expect(branch.points.map((point) => point.id)).toEqual([1, 2]);
		expect(branch.visiblePointIds).toEqual([1, 2]);
	});

	test('TempPin shown at ttl=1 remains keepable until the following inspection', () => {
		let state = emptySearchState();
		state = addTempPin(state, { name: 'maybe', imagePath: IMAGE, imageId: IMAGE_ID, point: [9, 9], ttl: 2 });
		expect(state.pins.maybe.style).toBe('ring-dot');

		// Before the next successful render ttl=2 ages to ttl=1, which is what is displayed.
		state = ageTempPinsForImage(state, IMAGE_ID);
		expect(state.pins.maybe.ttlRemaining).toBe(1);
		state = recordSuccessfulScope(state, { imagePath: IMAGE, imageId: IMAGE_ID, focus: [10, 10] });
		// It is still present/actionable after the ttl=1 render.
		expect(state.pins.maybe.ttlRemaining).toBe(1);
		state = keepPin(state, 'maybe');
		expect(state.pins.maybe.kind).toBe('kept');
		expect(state.pins.maybe.ttlRemaining).toBeNull();
		state = releasePin(state, 'maybe').state;
		expect(state.pins.maybe).toBeUndefined();
	});

	test('ttl=1 expires immediately before the following scope and leaves audit evidence', () => {
		let state = emptySearchState();
		state = addTempPin(state, { name: 'fleeting', imagePath: IMAGE, imageId: IMAGE_ID, point: [5, 5], ttl: 1, style: 'crosshair' });
		expect(state.pins.fleeting.style).toBe('crosshair');
		state = ageTempPinsForImage(state, IMAGE_ID);
		expect(state.pins.fleeting).toBeUndefined();
		expect(state.events.some((event) => event.op === 'pin-expire' && event.pin === 'fleeting')).toBe(true);
		const dir = mkdtempSync(join(tmpdir(), 'lab-scope-state-'));
		const path = join(dir, 'state.json');
		saveSearchState(path, state);
		expect(loadSearchState(path)).toEqual(state);
	});

	test('old saved pin state migrates to ring-dot without losing the trail', () => {
		const dir = mkdtempSync(join(tmpdir(), 'lab-scope-old-state-'));
		const path = join(dir, 'state.json');
		const old = {
			...emptySearchState(),
			pins: {
				legacy: { name: 'legacy', imagePath: IMAGE, imageId: IMAGE_ID, point: [7, 8], kind: 'temp', ttlRemaining: 2 }
			}
		};
		writeFileSync(path, JSON.stringify(old));
		expect(loadSearchState(path).pins.legacy.style).toBe('ring-dot');
	});
});
