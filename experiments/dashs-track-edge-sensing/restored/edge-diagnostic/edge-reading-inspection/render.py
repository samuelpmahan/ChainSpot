import json, numpy as np, matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from PIL import Image
from pathlib import Path
root=Path(__file__).resolve().parent.parent
a=json.load(open(root/'edge-readings-work/readings.json'))
im=np.asarray(Image.open(root/'edge-reading-inspection/DashsTrack-full.jpg'))
colors={'left':'#bc2d9f','right':'#087fa3'}
r=[r for r in a['rows'] if r['hole']==18 and r['width']==40 and r['distancePx']<=180]
fig,(ax,bx)=plt.subplots(1,2,figsize=(12,7),gridspec_kw={'width_ratios':[1,1.35]},)
fig.subplots_adjust(left=.02,right=.98,top=.86,bottom=.22,wspace=.18)
ax.imshow(im);ax.set_xlim(765,1045);ax.set_ylim(860,580)
for s,col in colors.items():
 pts=np.array([[v[s]['railPoint']['xPx'],v[s]['railPoint']['yPx']] for v in r])
 ax.plot(pts[:,0],pts[:,1],color=col,lw=1.3,label=f'{s.title()} reader')
 for d in [70,110,130]:
  p=r[d][s]['railPoint'];ax.scatter(p['xPx'],p['yPx'],s=45,facecolor=col,edgecolor='white',zorder=5)
  ax.annotate(str(d),(p['xPx'],p['yPx']),xytext=(-28,0) if s=='left' else (7,0),textcoords='offset points',color=col,fontsize=10,fontweight='bold',bbox=dict(fc='white',alpha=.85,ec='none',pad=1))
ax.set_title('H18: readers continue on the initial heading\nDots = distance from Badge center, source px',fontsize=11);ax.axis('off');ax.legend(loc='lower right',fontsize=9)
for s,col in colors.items():
 y=[np.nan if v[s]['occluded'] else v[s]['rawDiff'] for v in r]
 bx.plot([v['distancePx'] for v in r],y,color=col,label=s.title(),lw=2)
 for d in [70,110,130]:bx.scatter(d,y[d],color=col,s=28,zorder=5)
bx.axhline(0,color='#555',lw=1);bx.axhline(3.15,color='#777',ls=':',lw=1,label='Old score threshold (3.15)')
for d in [70,110,130]:bx.axvline(d,color='#888',lw=.6,alpha=.4)
bx.set(xlim=(20,180),ylim=(-15,60),xlabel='Distance along initial heading from Badge center (source px)',ylabel='Inside brightness minus outside brightness (0–255 scale)',title='The two readers lose support differently\nRaw values retained; negative values are not clipped')
bx.grid(alpha=.15);bx.legend(loc='upper right',fontsize=9)
fig.suptitle('DashsTrack · H18 edge readings · diagnostic W = 40 px',fontsize=15)
fig.text(.51,.05,'At 110 px: left +11.7, right +1.7. At 130 px: left −0.5, right +0.3.\nFixed initial ray, not a tracked route. Width is recorded annotation setup, not learned.\n5 samples span 8 px along each reading. Badge occlusions masked; circles unmodeled.',fontsize=9,ha='center',bbox=dict(facecolor='white',edgecolor='#ddd',pad=6))
fig.savefig(root/'edge-reading-inspection/DashsTrack-H18-edge-readings.png',dpi=150)
plt.close(fig)
fig,axs=plt.subplots(6,3,figsize=(15,18),layout='constrained')
for h,ax in zip(range(1,19),axs.flat):
 rr=[v for v in a['rows'] if v['hole']==h and v['width']==40 and v['distancePx']<=220]
 for s,col in colors.items():ax.plot([v['distancePx'] for v in rr],[np.nan if v[s]['occluded'] else v[s]['rawDiff'] for v in rr],color=col,lw=1,label=s)
 ax.axhline(0,color='#888',lw=.6);ax.set_title(f'H{h}');ax.set_xlim(0,220);ax.set_ylim(-60,80);ax.grid(alpha=.15)
 ax.set_xlabel('px from Badge');ax.set_ylabel('inside − outside')
axs.flat[0].legend()
fig.suptitle('All 18 initial rays · W40 · values outside −60…80 clipped only in this plot\nRaw complete readings in JSON/CSV. Circles/Baskets unmodeled: drops are not automatically bends.',fontsize=13)
fig.savefig(root/'edge-reading-inspection/DashsTrack-all18-readings.png',dpi=120)
plt.close(fig)
