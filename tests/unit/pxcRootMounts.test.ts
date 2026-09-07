import { describe, expect, it } from 'vitest';
import { createExecBoard } from '../../packages/alg/src/exec/board';
import { createPxCRootMounts } from '../../packages/alg/src/exec/mounts';

describe('PxC root mounts', () => {
	it('keeps ImgID outside the PxC address space', () => {
		const roots = createPxCRootMounts();
		const dash = createExecBoard();
		const north = createExecBoard();
		dash.set('px.s1.badges', ['dash']);
		north.set('px.s1.badges', ['north']);
		roots.mount('DashsTrack', dash);
		roots.mount('NorthPark', north);
		expect(roots.get('DashsTrack').get('px.s1.badges')).toEqual(['dash']);
		expect(roots.get('NorthPark').get('px.s1.badges')).toEqual(['north']);
		expect(dash.has('px.DashsTrack.s1.badges')).toBe(false);
		expect(north.has('px.NorthPark.s1.badges')).toBe(false);
	});

	it('slices roots without cloning or rewriting their worlds', () => {
		const roots = createPxCRootMounts();
		const a = createExecBoard();
		const b = createExecBoard();
		roots.mount('A', a);
		roots.mount('B', b);
		const sliced = roots.slice(['B']);
		expect(sliced.roots()).toEqual(['B']);
		expect(sliced.get('B')).toBe(b);
	});
});
