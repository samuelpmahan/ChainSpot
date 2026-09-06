"""Compare frozen source-inspection judgments with already-produced sensor states."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
expected = json.loads((ROOT/'ternary-review/pre-model-visual-checks.json').read_text())
trace = json.loads((ROOT/'ternary-edge/output/all18/trace.json').read_text())
rows = {(r['hole'],r['distancePx']):r for r in trace['rows']}
checks = []
for e in expected['rows']:
    row = rows[(e['hole'],e['distancePx'])]
    offset = -20 if e['side']=='left' else 20
    c = next(c for c in row['readers'] if c['offsetPx']==offset)
    out = dict(e)
    for method in ['methodA_live','methodA_predrop','methodB']:
        value = c[method]
        out[method] = value.get('classification',value.get('state'))
    checks.append(out)
summary = {}
for method in ['methodA_live','methodA_predrop','methodB']:
    matches = sum(c[method].lower()==c['visualState'] for c in checks)
    unknown = sum(c[method]=='UNKNOWN' for c in checks)
    summary[method] = {'matches':matches,'unknown':unknown,'mismatches':len(checks)-matches-unknown,'total':len(checks)}
result = {'runId':trace['runId'],'traceHash':trace['traceHash'],'scope':'14 hand-inspected reader positions; illustrative check, not corpus accuracy', 'summary':summary, 'checks':checks}
(ROOT/'ternary-review/source-check-results.json').write_text(json.dumps(result,indent=2))
print(json.dumps(result,indent=2))
