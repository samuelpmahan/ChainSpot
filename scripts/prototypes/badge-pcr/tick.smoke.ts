import { assertSameProjection, composePcr, projectionSummary, type Tick } from './tick.js';

const ticks: Tick[] = [
  {
    id: 't1', label: 'MASK1', claim: 'bright evidence exists',
    consumes: ['rgba'], produces: ['brightMask'],
    evidence: [{ id: 'bright-components', count: 18 }],
    residue: [{ id: 'not-yet-dark' }]
  },
  {
    id: 't2', label: 'MASK2', claim: 'dark evidence exists',
    consumes: ['brightMask', 'rgba'], produces: ['darkMask'],
    evidence: [{ id: 'dark-components', count: 18 }],
    residue: [{ id: 'unexplained-dark' }]
  }
];

const trace = composePcr('smoke', {
  inputId: 'fixture', schemaId: 'fixture.v1', coordinateFrame: 'image', planHash: 'fixture-plan'
}, ticks);
const renderProjection = projectionSummary(trace);
const cliProjection = projectionSummary(trace);
assertSameProjection(renderProjection, cliProjection);
if (trace.unexplained[0]?.id !== 'unexplained-dark') throw new Error('PCR must retain final residue');
console.log('tick smoke ok', renderProjection);
