#!/usr/bin/env python3
"""Source-registered views of raw signals; no fit or classification is rendered."""
from pathlib import Path
import json,numpy as np,matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from PIL import Image
ROOT=Path(__file__).resolve().parents[2]
a=json.loads((ROOT/'output/bands.json').read_text());im=np.asarray(Image.open(ROOT/'data/source.jpg'))
ds=np.array(a['distances']);os=np.array(a['offsets']);holes={h['hole']:h for h in a['holes']}
colors=['#bc2d9f','#087fa3']
def xy(h,d,n):
 return np.array([h['badge']['xPx']+h['tx']*np.asarray(d)+h['nx']*n,h['badge']['yPx']+h['ty']*np.asarray(d)+h['ny']*n])
def signals(h):
 b=np.array(h['bands'],float);g=b[:,10:]-b[:,:-10];go=os[5:-5]
 return g[:,np.where(go==-20)[0][0]],-g[:,np.where(go==20)[0][0]]
fig,axes=plt.subplots(3,2,figsize=(12,11),gridspec_kw={'width_ratios':[1,1.55]})
fig.subplots_adjust(left=.06,right=.98,top=.90,bottom=.12,hspace=.48,wspace=.22)
for (hole,start,end),axs in zip([(18,105,155),(16,57,107),(11,40,90)],axes):
 h=holes[hole];ax,bx=axs
 corners=np.concatenate([xy(h,np.array([start-30,end+30]),n) for n in [-50,50]],axis=1)
 ax.imshow(im);ax.set_xlim(corners[0].min(),corners[0].max());ax.set_ylim(corners[1].max(),corners[1].min())
 for n,col in zip([-20,20],colors):
  p=xy(h,np.arange(start-20,end+21),n);ax.plot(*p,color=col,lw=1,alpha=.6)
  p=xy(h,np.arange(start,end+1),n);ax.plot(*p,color=col,lw=2)
  for d in [start,end]:
   p=xy(h,d,n);ax.scatter(*p,s=24,c=col,edgecolor='white',zorder=5)
 ax.axis('off');ax.set_title(f'H{hole}: source pixels and original readers',fontsize=11)
 for sig,col,label in zip(signals(h),colors,['Left reader','Right reader']):
  mask=(ds>=start-20)&(ds<=end+20);bx.plot(ds[mask],sig[mask],color=col,lw=1.8,label=label)
 bx.axhline(0,color='#555',lw=.8);bx.axvspan(start,end,color='#999',alpha=.12)
 bx.set(xlabel='Distance from Badge (source px)',ylabel='Inside − outside brightness',title=('Reference: initial ray leaves bent ribbon' if hole==18 else 'Straight ribbon: opposite waves recur'))
 bx.grid(alpha=.15);bx.legend(fontsize=9,loc='best');bx.set_xlim(start-20,end+20)
fig.suptitle('Opposite movement also occurs along straight ribbon edges',fontsize=16)
fig.text(.5,.025,'Magenta / blue use the SAME original sampler and ±20 px reader positions in every row.\nShading marks the compared 50 px interval. H16 / H11 retain positive edge support while their readings move in opposition.',ha='center',fontsize=10)
fig.savefig(ROOT/'output/straight-edge-recurrence.png',dpi=150);plt.close(fig)

# 2D measured field: distance and transverse offset stay visible together.
h=holes[16];sel=(ds>=20)&(ds<=170);dd=ds[sel];nn=np.arange(-55,56)
xx=h['badge']['xPx']+dd[None,:]*h['tx']+nn[:,None]*h['nx'];yy=h['badge']['yPx']+dd[None,:]*h['ty']+nn[:,None]*h['ny']
pixels=im[np.floor(yy+.5).astype(int),np.floor(xx+.5).astype(int)]
fig,axs=plt.subplots(3,1,figsize=(11,9),layout='constrained',sharex=True)
axs[0].imshow(pixels,extent=[dd[0]-.5,dd[-1]+.5,55.5,-55.5],aspect='auto');axs[0].set_title('H16 source strip, rotated into the reader frame — source pixels retained')
b=np.array(h['bands'],float);g=(b[:,10:]-b[:,:-10])[sel].T;go=os[5:-5]
v=axs[1].imshow(g,extent=[dd[0]-.5,dd[-1]+.5,go[-1]+.25,go[0]-.25],cmap='RdBu_r',vmin=-60,vmax=60,aspect='auto');axs[1].set_title('Sideways brightness change: red = increasing, blue = decreasing (display ±60)')
for ax in axs[:2]:
 for n,col in zip([-20,20],colors):ax.axhline(n,color=col,lw=1.5)
 ax.set_ylabel('Sideways offset (source px)');ax.axvline(57,color='gold',lw=1);ax.axvline(107,color='gold',lw=1)
for sig,col,name in zip(signals(h),colors,['Left','Right']):axs[2].plot(dd,sig[sel],color=col,label=name)
axs[2].axhline(0,color='#555',lw=.8);axs[2].axvspan(57,107,color='#999',alpha=.15);axs[2].set(xlabel='Distance beyond Badge (source px)',ylabel='Inside − outside brightness',title='Two slices through that field: the original edge readers');axs[2].legend();axs[2].grid(alpha=.15)
fig.savefig(ROOT/'output/H16-two-dimensional-readings.png',dpi=150);plt.close(fig)

fig,axs=plt.subplots(3,3,figsize=(14,10),layout='constrained')
for h,ax in zip([h for h in holes.values() if h['straight']],axs.flat):
 mask=(ds>=h['teeDistance'])&(ds<=h['basketDistance'])
 for sig,col in zip(signals(h),colors):ax.plot(ds[mask],sig[mask],color=col,lw=1)
 ax.axhline(0,color='#777',lw=.7);ax.axvline(0,color='#888',lw=.7);ax.set(title=f'H{h["hole"]}',xlabel='px from Badge',ylabel='Inside − outside');ax.grid(alpha=.15)
fig.suptitle('All nine straight examples · original ±20 px readers · full plotted amplitude\nBefore Badge = negative distance. Badge masks leave gaps; Basket / circle marks remain visible.',fontsize=12)
fig.savefig(ROOT/'output/all-straight-curves.png',dpi=130);plt.close(fig)
print('Rendered source comparison, H16 2D field, and all-nine curve atlas.')
