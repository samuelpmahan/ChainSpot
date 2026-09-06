"""Portable gallery of actual LAB matrix outcomes, including unrun cases.

python gallery.py SUMMARY.json OUTPUT_DIR
"""
import argparse
import html
import json
import shutil
from pathlib import Path


def main():
    p = argparse.ArgumentParser()
    p.add_argument('summary', type=Path)
    p.add_argument('output', type=Path)
    args = p.parse_args()
    data = json.loads(args.summary.read_text())
    args.output.mkdir(parents=True, exist_ok=True)
    images = args.output/'images'
    images.mkdir(exist_ok=True)
    jobs = data.get('jobs', [])
    if not any('events' in j for j in jobs):
        jobs = list(data.get('results', {}).values())
    cards, index = [], []
    for j in jobs:
        if 'events' not in j:
            continue
        course, hole = j['case']['course'], j['case'].get('hole', '?')
        variant = j['variant']['id']
        tags = list(j.get('groups', []))
        reflection = j.get('reflection')
        if reflection and reflection.get('status') == 'unsupported':
            tags.append('reflection_unsupported')
        src = Path(j['galleryPath'])
        target = images/(j['jobKey']+'.png')
        shutil.copyfile(src, target)
        statuses = {}
        for e in j['events']:
            statuses[e['verdict']] = statuses.get(e['verdict'], 0)+1
        title = f'{course} H{hole} · {variant}'
        label = f"{j['status']} · {len(j['events'])} readings · "+', '.join(f'{v} {k}' for k,v in statuses.items())
        detail = f"Reflection: {reflection.get('status')} / {reflection.get('reason', '')}" if reflection else ''
        record = {'title':title,'tags':tags,'status':j['status'],'sourceHash':j['source']['sha256'],'jobKey':j['jobKey']}
        index.append(record)
        cards.append(f'<article data-tags="{html.escape(" ".join(tags))}" data-search="{html.escape(title.lower())}"><h2>{html.escape(title)}</h2><p>{html.escape(label)}</p><a href="images/{target.name}"><img loading="lazy" src="images/{target.name}" alt="{html.escape(title)} source measurements"></a><p>{html.escape(" · ".join(tags) or "No failure tag")}</p><p>{html.escape(detail)}</p><details><summary>Provenance</summary><pre>{html.escape(json.dumps(record,indent=2))}</pre></details></article>')
    for row in data.get('rows', []):
        if row.get('status') not in ['missing-prerequisite','failed','unsupported']:
            continue
        title = f"{row.get('case',row.get('caseId','UNKNOWN'))} · {row.get('variant',row.get('variantId','UNKNOWN'))}"
        tags = row['status']
        cards.append(f'<article data-tags="{tags}" data-search="{html.escape(title.lower())}"><h2>{html.escape(title)}</h2><p>{tags}</p><p>{html.escape(row.get("reason", "No measured output"))}</p></article>')
    groups = sorted({tag for r in index for tag in r['tags']} | {'missing-prerequisite','failed','unsupported'})
    options = ''.join(f'<option>{html.escape(g)}</option>' for g in groups)
    page = '''<!doctype html><html lang="en"><meta charset="utf-8"><title>LAB matrix source gallery</title>
<style>body{font:16px system-ui;background:#171c22;color:#e8edf2;margin:24px}h1{margin-bottom:6px}header{position:sticky;top:0;background:#171c22;padding:12px;z-index:1}input,select{font:inherit;padding:9px;margin:8px}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:18px}article{background:#25303a;padding:16px;border-radius:10px}h2{font-size:17px}img{width:100%;max-height:600px;object-fit:contain;background:#0b1014}pre{overflow:auto;font-size:11px}article[hidden]{display:none}</style>
<header><h1>LAB matrix: source measurements and failures</h1><p>Green marks a sensor acceptance; it does not establish path ownership. Missing prerequisites remain visible.</p><input id="search" placeholder="Course, hole, or variant"><select id="group"><option value="">All groups</option>'''+options+'''</select><span id="count"></span></header><main>'''+''.join(cards)+'''</main><script>
const cards=[...document.querySelectorAll('article')],q=document.querySelector('#search'),g=document.querySelector('#group');
function filter(){let n=0;for(const c of cards){c.hidden=!(c.dataset.search.includes(q.value.toLowerCase())&&(!g.value||c.dataset.tags.split(' ').includes(g.value)));if(!c.hidden)n++}document.querySelector('#count').textContent=`${n} of ${cards.length} outcomes`;}q.addEventListener('input',filter);g.addEventListener('change',filter);filter();</script></html>'''
    (args.output/'index.html').write_text(page)
    (args.output/'index.json').write_text(json.dumps(index,indent=2)+'\n')
    shutil.copyfile(args.summary,args.output/'summary.json')
    print(f'{len(jobs)} measured job entries; {len(cards)} gallery cards: {args.output}/index.html')


if __name__ == '__main__':
    main()
