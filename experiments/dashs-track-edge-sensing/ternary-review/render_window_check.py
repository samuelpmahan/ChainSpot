import json,math
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from PIL import Image
ROOT=Path(__file__).resolve().parent.parent
x=json.loads((ROOT/'ternary-edge/output/all18/trace.json').read_text());r=next(r for r in x['rows'] if r['hole']==18 and r['distancePx']==180)
im=Image.open(ROOT/'restored/edge-diagnostic/edge-reading-inspection/DashsTrack-full.jpg');c=r['center'];nx=-math.sin(r['headingRad']);ny=math.cos(r['headingRad'])
fig,axs=plt.subplots(1,3,figsize=(13,5.4),gridspec_kw={'width_ratios':[1,1,1.3]});fig.subplots_adjust(top=.78,bottom=.18,wspace=.18)
for ax,key,col,label in zip(axs[:2],['methodB','methodBFullWindowAblation'],['#d24a24','#087fa3'],['Initial window: ±48 px','Wider window: ±96 px']):
 b=r[key];a,z=[v-96 for v in b['edges']];ax.imshow(im);ax.set_xlim(c['xPx']-75,c['xPx']+45);ax.set_ylim(c['yPx']+45,c['yPx']-75)
 pts=[(c['xPx']+nx*v,c['yPx']+ny*v) for v in [a,z]];ax.plot([p[0] for p in pts],[p[1] for p in pts],c=col,lw=3,marker='o',ms=5)
 ax.scatter(c['xPx'],c['yPx'],c='yellow',edgecolors='black',s=30);ax.set_title(f'{label}\nFitted span: {z-a} px',fontsize=12);ax.axis('off')
ax=axs[2];p=r['profile'];ax.plot([q['offsetPx'] for q in p],[sum(q['meanRgb'])/3 if q['meanRgb'] else float('nan') for q in p],c='#555',lw=1.5)
for key,col,label in [('methodB','#d24a24','Initial fit'),('methodBFullWindowAblation','#087fa3','Wider fit')]:
 a,z=[v-96 for v in r[key]['edges']];ax.axvspan(a,z,color=col,alpha=.12,label=label);ax.axvline(a,c=col,lw=1);ax.axvline(z,c=col,lw=1)
ax.axvline(0,color='#aaa',ls=':');ax.set(xlabel='Offset across the initial ray (source px)',ylabel='Mean RGB brightness',xlim=(-96,96));ax.legend(fontsize=9);ax.grid(alpha=.15)
fig.suptitle('H18 at 180 px: the viewing window changes which structure is fitted',fontsize=15,y=.95)
fig.text(.5,.845,'Yellow = original center. Colored segment = fitted ribbon interval on the same cross-section.',ha='center',fontsize=10)
fig.text(.5,.045,'The narrow fit selects an interior patch. The wider fit is a different candidate, not a verified width.\nNeither fit changes the trajectory; both consume the same saved pixel profile.',ha='center',fontsize=10)
fig.savefig(ROOT/'ternary-review/H18-window-comparison.png',dpi=150)
