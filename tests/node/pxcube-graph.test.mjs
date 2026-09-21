import assert from 'node:assert/strict';
import test from 'node:test';
import { comparisonObligations, executeForkCapableTick, invalidationClosure, topologicalTicks } from '../../scripts/pxcube-graph.mjs';

test('toposort follows Part producer -> consumer edges, not declaration order', () => {
  const ticks = [
    { id: 'badge', consumes: ['canonical'], produces: ['badges'] },
    { id: 'decode', consumes: ['source'], produces: ['full'] },
    { id: 'crop', consumes: ['full'], produces: ['canonical'] }
  ];
  const graph = topologicalTicks(ticks);
  assert.deepEqual(graph.order, ['decode', 'crop', 'badge']);
  assert.deepEqual(graph.reasons, [
    { from: 'crop', to: 'badge', part: 'canonical' },
    { from: 'decode', to: 'crop', part: 'full' }
  ]);
});

test('invalidation closes only over downstream Part consumers', () => {
  const ticks = [
    { id: 'decode', consumes: ['source'], produces: ['full'] },
    { id: 'crop', consumes: ['full'], produces: ['canonical'] },
    { id: 'cache', consumes: ['full'], produces: [] },
    { id: 'badge', consumes: ['canonical'], produces: ['badges'] }
  ];
  assert.deepEqual(invalidationClosure(ticks, ['crop']), ['crop', 'badge']);
  assert.deepEqual(invalidationClosure(ticks, ['cache']), ['cache']);
});

test('cycles fail loudly', () => {
  assert.throws(
    () => topologicalTicks([
      { id: 'a', consumes: ['b-out'], produces: ['a-out'] },
      { id: 'b', consumes: ['a-out'], produces: ['b-out'] }
    ]),
    /Tick dependency cycle: a, b/
  );
});


test('real S0-shaped graph keeps cache reusable when Crop changes', () => {
  const ticks = [
    { id: 'source.decodeFullImage', consumes: ['px.source.selectedInput'], produces: ['px.source.fullImage'] },
    { id: 'source.cropUDiscChrome', consumes: ['px.source.fullImage'], produces: ['px.course.canonicalPixels'] },
    { id: 'source.cacheFullImage', consumes: ['px.source.fullImage'], produces: [] },
    { id: 'badges.acceptCroppedImage', consumes: ['px.course.canonicalPixels'], produces: ['px.badges.image'] }
  ];
  const graph = topologicalTicks(ticks);
  assert.deepEqual(graph.order, [
    'source.decodeFullImage',
    'source.cropUDiscChrome',
    'source.cacheFullImage',
    'badges.acceptCroppedImage'
  ]);
  assert.deepEqual(
    invalidationClosure(ticks, ['source.cropUDiscChrome']),
    ['source.cropUDiscChrome', 'badges.acceptCroppedImage']
  );
  assert.ok(!invalidationClosure(ticks, ['source.cropUDiscChrome']).includes('source.cacheFullImage'));
});


test('invalidated Parts create direct comparison obligations', () => {
  const ticks = [
    { id: 'decode', consumes: ['source'], produces: ['full'] },
    { id: 'crop', consumes: ['full'], produces: ['canonical'] },
    { id: 'cache', consumes: ['full'], produces: [] },
    { id: 'badge', consumes: ['canonical'], produces: ['badges'] }
  ];
  assert.deepEqual(comparisonObligations(ticks, ['crop']), [{
    producer: 'crop',
    part: 'canonical',
    consumers: ['badge'],
    reason: 'crop may change canonical; compare baseline vs candidate before trusting downstream consumers'
  }]);
  assert.deepEqual(comparisonObligations(ticks, ['cache']), []);
});


test('zero forks is ordinary authoritative Tick execution', async () => {
  const state = { value: 2 };
  const run = await executeForkCapableTick({
    tick: { id: 'double' },
    state,
    execute: async ({ state: lane }) => ({ value: lane.value * 2 })
  });
  assert.deepEqual(run.authoritative, { value: 4 });
  assert.deepEqual(run.observations, []);
  assert.deepEqual(state, { value: 2 });
});

test('observational fork cannot mutate clean state and may compare semantically', async () => {
  const state = { value: 2 };
  const run = await executeForkCapableTick({
    tick: { id: 'math' },
    state,
    forks: [{ id: 'exp/triple', override: 'triple' }],
    execute: async ({ state: lane, override }) => {
      lane.value = override === 'triple' ? lane.value * 3 : lane.value * 2;
      return { value: lane.value };
    },
    compare: (clean, candidate) => ({
      delta: candidate.value - clean.value,
      why: 'override changed multiplier'
    })
  });
  assert.deepEqual(run.authoritative, { value: 4 });
  assert.equal(run.observations.length, 1);
  assert.equal(run.observations[0].lineage, 'exp/triple');
  assert.deepEqual(run.observations[0].result, { value: 6 });
  assert.deepEqual(run.observations[0].comparison, { delta: 2, why: 'override changed multiplier' });
  assert.deepEqual(state, { value: 2 });
});
