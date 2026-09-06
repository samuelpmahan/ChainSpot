#!/usr/bin/env python3
"""Dependency-light synthetic controls for the bounded follower."""
import json, math, sys
sys.path.insert(0,'lib')
from tracker import track_hole

def corridor(w=120,h=80):
    a=[[0.0]*w for _ in range(h)]
    for y in range(25,56):
        for x in range(w): a[y][x]=100.0
    return a

def run(name,img,config):
    r=track_hole(img,None,{'center':(8,40),'heading':0.0,'width':30.0},config)
    return {'name':name,'status':r['status'],'stop':r['stop'],'points':len(r['points']),'end':r['points'][-1]['center'] if r['points'] else None,'bends':r['bendCandidates'],'rejections':r['widthDiagnostics']['rejections']}
base={'steps':20,'step_length':3.0,'beam_width':16,'heading_offsets':(-.12,0,.12),'width_offsets':(-1,0,1),'min_width':20,'max_width':42,'min_pair_support':.01,'min_individual_support':.01}
straight=run('straight_corridor',corridor(),base)
# Crossing distractor: bright diagonal intersects, but two corridor boundaries remain the primary paired support.
cross=corridor()
for i in range(15,70):
 for dy in (-1,0,1):
  y=i//2+15+dy
  if 0<=y<len(cross) and 0<=i<len(cross[0]):cross[y][i]=220.0
beam=run('crossing_distractor_beam',cross,base)
greedy=run('crossing_distractor_greedy',cross,{**base,'beam_width':1})
no=run('no_signal',[[0.0]*80 for _ in range(60)],base)
# Conservative evidence: no signal must not claim a continuation.
assert straight['points']>=10, straight
assert no['points']<=1 and no['stop']=='lack_support', no
# The beam must retain a trace; greedy is an ablation comparison, not a truth oracle.
assert beam['points']>=2, beam
out={'straight':straight,'crossing':{'beam':beam,'greedy':greedy},'noSignal':no,'claims':'Synthetic turning geometry is not asserted here; crossing is a paired-support-vs-greedy ablation and no-signal must stop.'}
open('output/synthetic-controls.json','w').write(json.dumps(out,indent=2))
print(json.dumps(out,indent=2))
# Turning corridor: bounded tracker may stop at unsupported corner, but must not invent a bend.
turn=[[0.0]*120 for _ in range(90)]
for y in range(90):
 for x in range(120):
  if (x<=55 and abs(y-40)<=15) or (y<=40 and abs(x-55)<=15): turn[y][x]=100.0
out['turningCorridor']=run('turning_corridor',turn,{**base,'steps':28,'heading_offsets':(-.22,-.11,0,.11,.22),'beam_width':24})
open('output/synthetic-controls.json','w').write(json.dumps(out,indent=2))
print(json.dumps({'turningCorridor':out['turningCorridor']},indent=2))
