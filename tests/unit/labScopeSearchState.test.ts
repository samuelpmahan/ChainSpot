import { describe, expect, test } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	addTempPin,
	addTrailPoint,
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
		expect(visibleTrailPoints(trail).map((p) => p.id)).toEqual([1, 2, 3, 5]);
		expect(trail.points.map((p) => p.id)).toEqual([1, 2, 3, 4, 5]);
		expect(state.events.some((e) => e.op === 'path-back' && e.pointId === 4)).toBe(true);
	});

	test('branch copies only currently visible evidence', () => {
		let state = emptySearchState();
		state = startTrail(state, { name: 'a', imagePath: IMAGE, imageId: IMAGE_ID, point: [1, 1] });
		state = addTrailPoint(state, 'a', [2, 2]);
		state = addTrailPoint(state, 'a', [3, 3]);
		state = backTrail(state, 'a');
		state = branchTrail(state, 'a', 'b');
		const branch = trailByName(state, 'b');
		expect(branch.points.map((p) => p.id)).toEqual([1, 2]);
		expect(branch.visiblePointIds).toEqual([1, 2]);
	});

	test('TempPins age after successful scopes, can be kept, and release cleanly', () => {
		let state = emptySearchState();
		state = addTempPin(state, { name: 'maybe', imagePath: IMAGE, imageId: IMAGE_ID, point: [9, 9], ttl: 2 });
		state = recordSuccessfulScope(state, { imagePath: IMAGE, imageId: IMAGE_ID, focus: [9, 9], ageTempPins: false });
		expect(state.pins.maybe.ttlRemaining).toBe(2);
		state = recordSuccessfulScope(state, { imagePath: IMAGE, imageId: IMAGE_ID, focus: [10, 10] });
		expect(state.pins.maybe.ttlRemaining).toBe(1);
		state = keepPin(state, 'maybe');
		state = recordSuccessfulScope(state, { imagePath: IMAGE, imageId: IMAGE_ID, focus: [11, 11] });
		expect(state.pins.maybe.kind).toBe('kept');
		expect(state.pins.maybe.ttlRemaining).toBeNull();
		state = releasePin(state, 'maybe').state;
		expect(state.pins.maybe).toBeUndefined();
	});

	test('expired TempPin disappears but leaves an audit event, and state persists', () => {
		let state = emptySearchState();
		state = addTempPin(state, { name: 'fleeting', imagePath: IMAGE, imageId: IMAGE_ID, point: [5, 5], ttl: 1 });
		state = recordSuccessfulScope(state, { imagePath: IMAGE, imageId: IMAGE_ID, focus: [6, 6] });
		expect(state.pins.fleeting).toBeUndefined();
		expect(state.events.some((e) => e.op === 'pin-expire' && e.pin === 'fleeting')).toBe(true);
		const dir = mkdtempSync(join(tmpdir(), 'lab-scope-state-'));
		const path = join(dir, 'state.json');
		saveSearchState(path, state);
		expect(loadSearchState(path)).toEqual(state);
	});
});
