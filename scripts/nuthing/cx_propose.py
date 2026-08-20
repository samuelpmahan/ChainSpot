#!/usr/bin/env python3
"""CX proposal tool — proposing is cheap and credited; ACCEPTANCE is the bar.

A CX entry is a falsifiable, re-checkable claim about the SYSTEM (render
model, pipeline, methodology) — never a war story. This tool makes filing a
proposal one command, makes the quality bar mechanical (validation errors
state what to produce), and makes endorsement a recorded human act: nothing
reaches docs/nuthing-p2/cx-catalog.md without `accept --approved-by <human>`.

Lifecycle: proposed -> accepted (numbered, appended to catalog)
                    -> rejected (kept, with reason — rejections are lab data)
Proposals live in docs/nuthing-p2/cx-proposals/<slug>.json.

Usage:
  cx_propose.py new SLUG --author A --category C --claim TEXT
                 --measurement-cmd CMD --numbers TEXT --frames TEXT
                 --risk TEXT [--control TEXT | --control-na REASON]
                 [--evidence PATH ...] [--history TEXT]
  cx_propose.py validate SLUG
  cx_propose.py list
  cx_propose.py accept SLUG --number N --approved-by HUMAN [--section A-F]
  cx_propose.py reject SLUG --reason TEXT --by HUMAN
  cx_propose.py stats
"""
import argparse
import datetime
import json
import os
import re
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PROPOSALS_DIR = os.path.join(REPO, 'docs', 'nuthing-p2', 'cx-proposals')
CATALOG = os.path.join(REPO, 'docs', 'nuthing-p2', 'cx-catalog.md')

CATEGORIES = ['fact', 'constant', 'invariant', 'edge-case', 'corner-case',
              'technique', 'methodology', 'negative-result']

SECTION_HEADS = {
    'A': '## A. Render-model facts',
    'B': '## B. Validated invariants',
    'C': '## C. Occlusion edge cases',
    'D': '## D. Pairing/assignment corner cases',
    'E': '## E. Truth-quality findings',
    'F': '## F. Methodology',
}


def path_of(slug):
    return os.path.join(PROPOSALS_DIR, f'{slug}.json')


def load(slug):
    p = path_of(slug)
    if not os.path.exists(p):
        sys.exit(f'no proposal {slug} ({p})')
    with open(p) as f:
        return json.load(f)


def store(proposal):
    os.makedirs(PROPOSALS_DIR, exist_ok=True)
    p = path_of(proposal['slug'])
    with open(p, 'w') as f:
        json.dump(proposal, f, indent=1)
    return p


def substrate_commit():
    try:
        return subprocess.run(['git', 'rev-parse', '--short', 'HEAD'], cwd=REPO,
                              capture_output=True, text=True, check=True).stdout.strip()
    except Exception:
        return 'unknown'


def validate(proposal):
    """The bar, mechanically. Each error says what to PRODUCE, because for a
    model the error message is the training signal."""
    errors = []

    claim = proposal.get('claim', '').strip()
    if not claim:
        errors.append('claim: empty. State ONE falsifiable sentence about the '
                      'system ("X causes Y under Z"), not about your session.')
    if re.search(r'\b(I|we|my|our)\b', claim):
        errors.append('claim: contains first-person language. A CX claim is '
                      'about the SYSTEM; if it only matters to someone who was '
                      'there, it is a war story — put that in --history instead.')
    if len(claim) > 400:
        errors.append('claim: over 400 chars. One or two sentences; the detail '
                      'belongs in numbers/measurement, not the claim.')

    meas = proposal.get('measurement', {})
    if not meas.get('command', '').strip():
        errors.append('measurement.command: empty. Provide the exact command or '
                      'script path a STRANGER could run to re-check the claim. '
                      'No command = not re-checkable = not a CX.')
    numbers = meas.get('numbers', '').strip()
    if not numbers:
        errors.append('measurement.numbers: empty. Paste the actual measured '
                      'values the claim rests on.')
    elif not re.search(r'\d', numbers):
        errors.append('measurement.numbers: contains no digits. "It worked '
                      'much better" is not a measurement.')
    if not meas.get('firsthand', False):
        errors.append('measurement.firsthand: false. Second-hand findings stay '
                      'proposals-with-a-caveat until someone re-measures; set '
                      '--firsthand only if THIS author ran the command. '
                      '(CX-060 was catalogued second-hand and overturned in '
                      'hours — this flag exists because of that.)')

    control = proposal.get('control', '').strip()
    control_na = proposal.get('controlNa', '').strip()
    if not control and not control_na:
        errors.append('control: empty and no --control-na reason. A causal/'
                      'comparative claim needs a working control case measured '
                      'with the SAME metric that defines the failure (support '
                      'deltas do not control a shape claim). Pure facts/'
                      'constants may pass --control-na with why a control does '
                      'not apply.')

    if not proposal.get('frames', '').strip():
        errors.append('frames: empty. Name every coordinate frame/unit the '
                      'measurement used (full-capture px / cropped px / field '
                      'cells / geometry vs native). Frame mixups are the top '
                      'source of confident nonsense (CX-038, CX-058).')

    if not proposal.get('risk', '').strip():
        errors.append('risk: empty. State where the claim could fail to '
                      'generalize (other zoom, other course, renderer update).')

    for path in proposal.get('evidence', []):
        if not os.path.exists(os.path.join(REPO, path)) and not os.path.exists(path):
            errors.append(f'evidence: {path} does not exist. Evidence paths '
                          'must point at real committed artifacts.')

    if proposal.get('category') not in CATEGORIES:
        errors.append(f'category: must be one of {", ".join(CATEGORIES)}.')

    return errors


def cmd_new(args):
    if os.path.exists(path_of(args.slug)):
        sys.exit(f'proposal {args.slug} already exists; edit the JSON or pick a new slug')
    proposal = {
        'slug': args.slug,
        'status': 'proposed',
        'author': args.author,
        'date': datetime.date.today().isoformat(),
        'substrate': substrate_commit(),
        'category': args.category,
        'claim': args.claim,
        'measurement': {
            'command': args.measurement_cmd,
            'numbers': args.numbers,
            'firsthand': args.firsthand,
        },
        'control': args.control or '',
        'controlNa': args.control_na or '',
        'frames': args.frames,
        'risk': args.risk,
        'evidence': args.evidence or [],
        'history': args.history or '',
    }
    errors = validate(proposal)
    p = store(proposal)
    if errors:
        print(f'FILED WITH GAPS -> {p}')
        print('This proposal will not be acceptable until these are fixed:')
        for e in errors:
            print(f'  - {e}')
        sys.exit(1)
    print(f'FILED, valid -> {p}')
    print('Awaiting human review: cx_propose.py accept/reject')


def cmd_validate(args):
    errors = validate(load(args.slug))
    if errors:
        print('NOT ACCEPTABLE:')
        for e in errors:
            print(f'  - {e}')
        sys.exit(1)
    print('valid — awaiting human review')


def cmd_list(args):
    if not os.path.isdir(PROPOSALS_DIR):
        print('no proposals')
        return
    for name in sorted(os.listdir(PROPOSALS_DIR)):
        if not name.endswith('.json'):
            continue
        with open(os.path.join(PROPOSALS_DIR, name)) as f:
            p = json.load(f)
        gaps = len(validate(p))
        tag = p['status'] + (f' ({gaps} gaps)' if p['status'] == 'proposed' and gaps else '')
        num = f" CX-{p['number']:03d}" if p.get('number') else ''
        print(f"  [{tag}]{num} {p['slug']} — {p['author']} {p['date']}: {p['claim'][:90]}")


def format_entry(p):
    lines = [f"**CX-{p['number']:03d}. {p['slug'].replace('-', ' ').capitalize()}.** "
             f"{p['category']}, proposed by {p['author']} on {p['date']} "
             f"(substrate {p['substrate']}), accepted by {p['approvedBy']}."]
    lines.append(p['claim'])
    lines.append(f"Measured: {p['measurement']['numbers']} — re-check: "
                 f"`{p['measurement']['command']}`. Frames: {p['frames']}.")
    if p.get('control'):
        lines.append(f"Control: {p['control']}")
    elif p.get('controlNa'):
        lines.append(f"Control n/a: {p['controlNa']}")
    if p.get('evidence'):
        lines.append('Evidence: ' + ', '.join(p['evidence']) + '.')
    lines.append(f"Risk: {p['risk']}")
    if p.get('history'):
        lines.append(f"History: {p['history']}")
    return '\n'.join(lines) + '\n'


def cmd_accept(args):
    p = load(args.slug)
    if p['status'] != 'proposed':
        sys.exit(f"{args.slug} is {p['status']}, not proposed")
    errors = validate(p)
    if errors:
        print('cannot accept — the bar is not met:')
        for e in errors:
            print(f'  - {e}')
        sys.exit(1)
    with open(CATALOG) as f:
        catalog = f.read()
    if f"CX-{args.number:03d}" in catalog:
        sys.exit(f'CX-{args.number:03d} already exists in the catalog')
    p['status'] = 'accepted'
    p['number'] = args.number
    p['approvedBy'] = args.approved_by
    entry = format_entry(p)
    head = SECTION_HEADS[args.section]
    idx = catalog.find(head)
    if idx < 0:
        sys.exit(f'catalog section {args.section} not found')
    # append at the end of the section (before the next '## ' heading)
    next_idx = catalog.find('\n## ', idx + len(head))
    insert_at = next_idx if next_idx > 0 else len(catalog)
    catalog = catalog[:insert_at] + '\n' + entry + catalog[insert_at:]
    with open(CATALOG, 'w') as f:
        f.write(catalog)
    store(p)
    print(f"accepted as CX-{args.number:03d} (approved by {args.approved_by}) "
          f"and appended to catalog section {args.section}")


def cmd_reject(args):
    p = load(args.slug)
    p['status'] = 'rejected'
    p['rejectedBy'] = args.by
    p['rejectReason'] = args.reason
    store(p)
    print(f"rejected (kept on file — rejections are lab data): {args.reason}")


def cmd_stats(args):
    tallies = {}
    if os.path.isdir(PROPOSALS_DIR):
        for name in os.listdir(PROPOSALS_DIR):
            if not name.endswith('.json'):
                continue
            with open(os.path.join(PROPOSALS_DIR, name)) as f:
                p = json.load(f)
            t = tallies.setdefault(p['author'], {'proposed': 0, 'accepted': 0, 'rejected': 0})
            t[p['status']] = t.get(p['status'], 0) + 1
    if not tallies:
        print('no proposals yet')
        return
    print(f"{'author':24} {'proposed':>9} {'accepted':>9} {'rejected':>9}")
    for author, t in sorted(tallies.items(), key=lambda kv: -kv[1].get('accepted', 0)):
        print(f"{author:24} {t.get('proposed', 0):>9} {t.get('accepted', 0):>9} {t.get('rejected', 0):>9}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)

    p = sub.add_parser('new')
    p.add_argument('slug')
    p.add_argument('--author', required=True)
    p.add_argument('--category', required=True)
    p.add_argument('--claim', required=True)
    p.add_argument('--measurement-cmd', required=True)
    p.add_argument('--numbers', required=True)
    p.add_argument('--firsthand', action='store_true')
    p.add_argument('--control')
    p.add_argument('--control-na')
    p.add_argument('--frames', required=True)
    p.add_argument('--risk', required=True)
    p.add_argument('--evidence', action='append')
    p.add_argument('--history')
    p.set_defaults(fn=cmd_new)

    p = sub.add_parser('validate'); p.add_argument('slug'); p.set_defaults(fn=cmd_validate)
    p = sub.add_parser('list'); p.set_defaults(fn=cmd_list)
    p = sub.add_parser('accept')
    p.add_argument('slug')
    p.add_argument('--number', type=int, required=True)
    p.add_argument('--approved-by', required=True)
    p.add_argument('--section', choices=list(SECTION_HEADS), default='F')
    p.set_defaults(fn=cmd_accept)
    p = sub.add_parser('reject')
    p.add_argument('slug')
    p.add_argument('--reason', required=True)
    p.add_argument('--by', required=True)
    p.set_defaults(fn=cmd_reject)
    p = sub.add_parser('stats'); p.set_defaults(fn=cmd_stats)

    args = ap.parse_args()
    args.fn(args)


if __name__ == '__main__':
    main()
