import assert from 'node:assert/strict';
import test from 'node:test';
import { invalidationClosure, topologicalTicks } from '../../scripts/pxcube-graph.mjs';

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
