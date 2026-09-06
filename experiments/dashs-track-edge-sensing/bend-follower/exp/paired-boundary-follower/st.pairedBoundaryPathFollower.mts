export default {
  id: 'paired-boundary-path-follower',
  gate: 'G5',
  defaultEnabled: false,
  feature: 'pairedBoundaryPathFollower',
  consumes: ['bendFollower.sourceSpec'],
  produces: ['bendFollower.trace'],
  note: 'Bounded curvature-aware paired-boundary path tracking diagnostic; frozen default behavior unchanged.'
};
