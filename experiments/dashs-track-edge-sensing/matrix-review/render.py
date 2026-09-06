"""Render actual LAB matrix receipts; never supplies geometry to the producer.

Usage: python render.py SUMMARY.json OUTPUT_DIR [--hole 18]
The lower plots follow one parent-linked branch, not iteration order across siblings.
"""
import argparse
import json
from pathlib import Path

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
from PIL import Image


def longest_branch(events):
    by_id = {e['id']: e for e in events}
    lengths = {}
    def length(e, seen=None):
        if e['id'] in lengths:
            return lengths[e['id']]
        seen = set() if seen is None else seen
        if e['id'] in seen:
            raise ValueError('Cycle in recorded parent links')
        seen.add(e['id'])
        p = by_id.get(e.get('parentId'))
        d = 0 if p is None else length(p, seen) + np.hypot(e['xPx']-p['xPx'], e['yPx']-p['yPx'])
        lengths[e['id']] = float(d)
        return d
    for e in events:
        length(e)
    if not events:
        return [], []
    last = max(events, key=lambda e: lengths[e['id']])
    branch = []
    while last:
        branch.append(last)
        last = by_id.get(last.get('parentId'))
    branch.reverse()
    return branch, [lengths[e['id']] for e in branch]


def main():
    p = argparse.ArgumentParser()
    p.add_argument('summary', type=Path)
    p.add_argument('output', type=Path)
    p.add_argument('--hole', type=int, default=18)
    args = p.parse_args()
    data = json.loads(args.summary.read_text())
    jobs = data.get('jobs', [])
    if not any('events' in j for j in jobs):
        jobs = list(data.get('results', {}).values())
    jobs = [j for j in jobs if j.get('case', {}).get('hole') == args.hole and j.get('events')]
    if not jobs:
        raise ValueError(f'No measured events for hole {args.hole}')
    image = np.asarray(Image.open(jobs[0]['source']['path']).convert('RGB'))
    pts = np.array([[e['xPx'], e['yPx']] for j in jobs for e in j['events']])
    x0, y0 = np.maximum(0, np.floor(pts.min(axis=0)-65)).astype(int)
    x1, y1 = np.minimum([image.shape[1], image.shape[0]], np.ceil(pts.max(axis=0)+65)).astype(int)
    fig, axes = plt.subplots(2, len(jobs), figsize=(5*len(jobs), 9), squeeze=False,
                             gridspec_kw={'height_ratios': [2, 1]})
    review = []
    for col, job in enumerate(jobs):
        ax = axes[0, col]
        ax.imshow(image)
        by_id = {e['id']: e for e in job['events']}
        branch, distances = longest_branch(job['events'])
        max_segment = 0
        for e in job['events']:
            parent = by_id.get(e.get('parentId'))
            if parent:
                max_segment = max(max_segment, float(np.hypot(e['xPx']-parent['xPx'], e['yPx']-parent['yPx'])))
                ax.plot([parent['xPx'], e['xPx']], [parent['yPx'], e['yPx']], color='#eeeeee', lw=.7, alpha=.5)
        for status, color in [('accepted', '#00d88b'), ('rejected', '#ff3333'), ('unknown', '#ffcc00')]:
            selected = [e for e in job['events'] if e['verdict'] == status]
            ax.scatter([e['xPx'] for e in selected], [e['yPx'] for e in selected], s=9, c=color, label=status)
        if branch:
            ax.plot([e['xPx'] for e in branch], [e['yPx'] for e in branch], c='cyan', lw=1, alpha=.8)
        ax.set(xlim=(x0,x1), ylim=(y1,y0), title=f"{job['variant']['id']}\n{job['status']} · {len(job['events'])} readings")
        ax.set_aspect('equal')
        ax.legend(fontsize=7, loc='upper left')
        plot = axes[1, col]
        for key, color, label in [('leftSigned','#c22aab','Left inward contrast'), ('rightSigned','#0989a2','Right inward contrast')]:
            values = [e['sample'].get(key) for e in branch]
            plot.plot(distances, [np.nan if v is None else v for v in values], color=color, label=label)
        plot.axhline(0, color='#555', lw=.8)
        plot.set(xlabel='Distance along longest recorded branch (source px)', ylabel='Recorded contrast')
        plot.grid(alpha=.2)
        plot.legend(fontsize=7)
        review.append({'case':job['case'], 'variant':job['variant']['id'], 'status':job['status'],
                       'readings':len(job['events']), 'longestRecordedBranchPx':max(distances, default=0),
                       'largestParentSegmentPx':max_segment, 'jobKey':job['jobKey']})
    fig.suptitle(f"Dash's H{args.hole}: actual source readings and exploratory branches\nCyan: longest recorded ancestry; acceptance is a sensor judgment, not verified path ownership", fontsize=14)
    fig.tight_layout(rect=(0,0,1,.94))
    args.output.mkdir(parents=True, exist_ok=True)
    fig.savefig(args.output/f'H{args.hole}-matrix-comparison.png', dpi=160)
    (args.output/f'H{args.hole}-receipt-review.json').write_text(json.dumps(review, indent=2)+'\n')
    print(json.dumps(review, indent=2))


if __name__ == '__main__':
    main()
