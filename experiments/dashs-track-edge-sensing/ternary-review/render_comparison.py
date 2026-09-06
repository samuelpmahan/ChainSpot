import json, math
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from PIL import Image
ROOT=Path(__file__).resolve().parent.parent
path=ROOT/'ternary-edge/output/all18/trace.json'
if not path.exists(): path=ROOT/'ternary-edge/output/first/trace.json'
x=json.loads(path.read_text());im=Image.open(ROOT/'restored/edge-diagnostic/edge-reading-inspection/DashsTrack-full.jpg')
colors={'RIBBON':'#208747','TERRAIN':'#69605a','EDGE':'#c88100','UNKNOWN':'#9a53b0'}
fig=plt.figure(figsize=(13,7.6));gs=fig.add_gridspec(2,3,height_ratios=[3.3,1.4],top=.86,bottom=.08,hspace=.05,wspace=.08)
for i,d in enumerate([70,130,180]):
 r=next(r for r in x['rows'] if r['hole']==18 and r['distancePx']==d);ax=fig.add_subplot(gs[0,i]);c=r.get('centerPx',r.get('center'));ax.imshow(im);ax.set_xlim(c['xPx']-43,c['xPx']+43);ax.set_ylim(c['yPx']+43,c['yPx']-43)
 nx=-math.sin(r['headingRad']);ny=math.cos(r['headingRad'])
 for off,label,col in [(-20,'L','#e319b2'),(0,'C','#ffde00'),(20,'R','#00abd5')]:
  px=c['xPx']+nx*off;py=c['yPx']+ny*off;ax.scatter(px,py,s=40,c=col,edgecolors='black',linewidths=.6)
  ax.annotate(label,(px,py),xytext=(5,-4),textcoords='offset points',fontsize=12,weight='bold',color=col,bbox=dict(fc='#111',alpha=.7,ec='none',pad=1))
 ax.set_title(f'{d} px beyond Badge',fontsize=14);ax.axis('off')
 bx=fig.add_subplot(gs[1,i]);bx.axis('off')
 bx.text(.01,.94,'Method',fontsize=10,weight='bold')
 for j,label in enumerate(['Left','Center','Right']):bx.text(.45+j*.19,.94,label,fontsize=10,ha='center',weight='bold')
 for k,(key,label) in enumerate([('methodA_live','Live center'),('methodA_predrop','Frozen center'),('methodB','Profile fit')]):
  y=.70-k*.26;bx.text(.01,y,label,fontsize=10)
  for j,off in enumerate([-20,0,20]):
   q=next(q for q in r['readers'] if q['offsetPx']==off)[key];s=q.get('classification',q.get('state'));bx.text(.45+j*.19,y,s.title(),ha='center',fontsize=9.5,color=colors[s],weight='bold')
fig.suptitle('Ternary sensing: the same weak edge reading can mean different materials',fontsize=16,y=.96)
fig.text(.5,.9,'H18 · L / C / R mark the original left reader, center, and right reader · states are prototype judgments',ha='center',fontsize=10)
fig.text(.5,.025,'At 180 px the live center has drifted onto terrain. The profile interval also narrows incorrectly; see the boundary comparison.\nFixed initial ray, not a followed path. Both methods share the sampled RGB profiles.',ha='center',fontsize=10)
fig.savefig(ROOT/'ternary-review/H18-ternary-comparison.png',dpi=150)
