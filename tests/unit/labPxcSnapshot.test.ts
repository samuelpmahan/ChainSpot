import { describe, expect, test } from 'vitest';
import { createExecBoard, pxFn } from '@chainspot/alg/exec/board';
import { capturePxC, restorePxC, snapshotIdentity } from '../../scripts/chainspot-lab/sweep/pxcSnapshot';

describe('retained PxC experimental snapshots', () => {
  test('retains typed pixel arrays and semantic object structure', () => {
    const board = createExecBoard();
    const value = { px: new Uint32Array([3, 5, 8]), has: { frame: { label: 7 } } };
    board.set('px.tees', [value]);
    const restored = restorePxC(capturePxC(board, ['px.tees']));
    expect(restored.get('px.tees')).toEqual([value]);
    expect(restored.get<any[]>('px.tees')[0].px).toBeInstanceOf(Uint32Array);
  });
  test('mutating a candidate cannot alter its seed or another restored candidate', () => {
    const seed = createExecBoard();
    seed.set('px.image', { rgba: new Uint8Array([1, 2, 3, 255]) });
    const bytes = capturePxC(seed, ['px.image']);
    const first = restorePxC(bytes), second = restorePxC(bytes);
    first.get<{rgba: Uint8Array}>('px.image').rgba[0] = 99;
    expect(seed.get<{rgba: Uint8Array}>('px.image').rgba[0]).toBe(1);
    expect(second.get<{rgba: Uint8Array}>('px.image').rgba[0]).toBe(1);
  });
  test('missing declared state is loud and unproduced values stay missing', () => {
    const seed = createExecBoard();
    expect(() => capturePxC(seed, ['px.missing'])).toThrow('missing declared address');
    seed.set('px.present', 1);
    expect(restorePxC(capturePxC(seed, ['px.present'])).has('px.missing')).toBe(false);
  });
  test('does not smuggle calculation closures from another run', () => {
    const seed = createExecBoard(), fn = pxFn<number, number>('fn.double');
    seed.register(fn, n => n * 2); seed.set('px.n', 2);
    const restored = restorePxC(capturePxC(seed, ['px.n']));
    expect(() => restored.call(fn, 2)).toThrow('not registered');
    restored.register(fn, n => n * 2);
    expect(restored.call(fn, 2)).toBe(4);
  });
  test('identity is order independent and changes with code, input, or runtime', () => {
    const base = { code: 'abc', input: 'xyz', runtime: 'node22' };
    expect(snapshotIdentity(base)).toBe(snapshotIdentity({ runtime: 'node22', input: 'xyz', code: 'abc' }));
    for (const key of Object.keys(base)) expect(snapshotIdentity({ ...base, [key]: 'changed' })).not.toBe(snapshotIdentity(base));
  });
  test('restored object aliases retain their relationships within one candidate', () => {
    const seed = createExecBoard(), pixels = new Uint8Array([1, 2]);
    seed.set('px.a', pixels); seed.set('px.b', pixels);
    const restored = restorePxC(capturePxC(seed, ['px.a', 'px.b']));
    expect(restored.get('px.a')).toBe(restored.get('px.b'));
  });
});
