import { forkBadgeCompare } from './badgeForkCompare';

type Output = { residual: number; owned: number };
type Measure = Output;

let clock = 10;
const result = forkBadgeCompare(
  {
    checkpointId: 'badge-stage:abc123',
    inputSchemaIdentity: 'threeFactor.badgeStage+BadgeReading',
    coordinateFrame: 'badge-crop-normalized:74x62',
    input: { residual: 100, owned: 200 }
  },
  [
    {
      name: 'defaultLive',
      planConfigHash: 'live-hash',
      run: (input) => ({
        output: input,
        evidenceTrace: { kind: 'live' },
        renderFragment: { kind: 'residual-grid' },
        unexplainedResidual: input.residual
      })
    },
    {
      name: 'experimentalPcr',
      planConfigHash: 'pcr-hash',
      run: (input) => ({
        output: { residual: input.residual - 40, owned: input.owned + 10 },
        evidenceTrace: { kind: 'pcr' },
        renderFragment: { kind: 'progressive-grid' },
        unexplainedResidual: input.residual - 40
      })
    }
  ],
  (output): Measure => output,
  (live, pcr) => ({ residualDelta: pcr.residual - live.residual, ownedDelta: pcr.owned - live.owned }),
  () => ++clock
);

if (result.branches[0].name !== 'defaultLive') throw new Error('default branch identity lost');
if (result.branches[1].name !== 'experimentalPcr') throw new Error('experimental branch identity lost');
if (result.comparison.residualDelta !== -40) throw new Error('comparison measure wrong');
if (result.comparison.ownedDelta !== 10) throw new Error('comparison ownership measure wrong');
if (result.branches[0].inputSchemaIdentity !== result.branches[1].inputSchemaIdentity) throw new Error('schema drift');
if (result.branches[0].coordinateFrame !== result.branches[1].coordinateFrame) throw new Error('frame drift');
console.log(`badge-fork-compare-smoke checkpoint=${result.checkpointId} residualDelta=${result.comparison.residualDelta} ownedDelta=${result.comparison.ownedDelta}`);
