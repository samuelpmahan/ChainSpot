"""Exercise the actual LAB CLI: resume, selectors, and per-cell failure isolation."""
import argparse
import json
import subprocess
import tempfile
from pathlib import Path


def main():
    p = argparse.ArgumentParser()
    p.add_argument('repo', type=Path)
    p.add_argument('output', type=Path)
    args = p.parse_args()
    repo = args.repo.resolve()
    base = json.loads((repo/'experiments/dashs-track-edge-sensing/matrix-review/MATRIX.json').read_text())
    case = next(c for c in base['cases'] if c.get('metadata',{}).get('hole') == 18)
    manifest = {'version':1,'id':'matrix-runner-root-check','cases':[case], 'variants':[
        {'id':'one-operation','implementation':'branching','params':{'mode':'fixed','sliceSteps':1,'supportFactor':.5}},
        {'id':'bad-mode','implementation':'branching','params':{'mode':'invalid','sliceSteps':1}}
    ]}
    root = repo/'artifacts/sweep/matrix/matrix-runner-root-check'
    with tempfile.TemporaryDirectory(prefix='matrix-check-') as temp:
        source = Path(temp)/'manifest.json'
        source.write_text(json.dumps(manifest))
        def run(*flags):
            result = subprocess.run(['./lab','sweep','matrix',str(source),*flags],cwd=repo,text=True,capture_output=True)
            if result.returncode != 1:
                raise AssertionError(f'Expected one explicit failed cell, got {result.returncode}: {result.stdout} {result.stderr}')
            return result
        run()
        first = json.loads((root/'summary.json').read_text())
        assert len(first['rows']) == 2, 'Failed variant duplicated its successful sibling'
        assert first['rows'][1]['status'] == 'failed'
        assert len(first['jobs'][0]['events']) == 1
        assert first['jobs'][0]['status'] == 'PAUSED'
        before = Path(first['jobs'][0]['receiptPath']).read_bytes()
        run('H18','--resume')
        second = json.loads((root/'summary-resume-H18.json').read_text())
        assert len(second['rows']) == 2
        job = second['jobs'][0]
        assert len(job['events']) >= 2 and job['resumed'] and job['sliceCount'] >= 2
        assert job['events'][0] == first['jobs'][0]['events'][0], 'Resume changed the first measured event'
        assert Path(first['jobs'][0]['receiptPath']).read_bytes() == before, 'Resume overwrote the original slice'
        run('DashsTrack')
        selected = json.loads((root/'summary-DashsTrack.json').read_text())
        assert len(selected['rows']) == 2
        report = {'passed':True,'checks':['one cell per case/variant despite partial failure','actual CLI resume increases observations','old slice immutable','course and hole selectors'],
                  'initialEvents':1,'resumedEvents':len(job['events']),'sourceHash':job['source']['sha256'],'implementation':job['implementation']}
        args.output.parent.mkdir(parents=True,exist_ok=True)
        args.output.write_text(json.dumps(report,indent=2)+'\n')
        print(json.dumps(report,indent=2))


if __name__ == '__main__':
    main()
