#!/usr/bin/env python3
"""Whole-raster transition observations; no hole seeds, widths or ownership."""
from pathlib import Path
import argparse, hashlib, json
import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter, map_coordinates
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

ROOT=Path(__file__).resolve().parent
DEFAULT_SOURCE=ROOT.parent/'restored/edge-diagnostic/edge-reading-inspection/DashsTrack-full.jpg'

def measure(rgb, stride=2):
    lum=rgb.astype(np.float32).mean(axis=2)
    yy,xx=np.mgrid[0:lum.shape[0]:stride,0:lum.shape[1]:stride].astype(np.float32)
    fields={'x':xx,'y':yy}
    for sigma in [1.,2.,4.]:
        gx=gaussian_filter(lum,sigma,order=(0,1));gy=gaussian_filter(lum,sigma,order=(1,0))
        fields[f'gradient_sigma{int(sigma)}']=np.hypot(gx,gy)[::stride,::stride]
        if sigma==2:
            normal_x=gx[::stride,::stride];normal_y=gy[::stride,::stride]
            Jxx=gaussian_filter(gx*gx,4)[::stride,::stride];Jyy=gaussian_filter(gy*gy,4)[::stride,::stride];Jxy=gaussian_filter(gx*gy,4)[::stride,::stride]
            fields['orientation_coherence']=np.sqrt((Jxx-Jyy)**2+4*Jxy**2)/(Jxx+Jyy+1e-8)
    norm=np.hypot(normal_x,normal_y)
    nx=normal_x/np.maximum(norm,1e-8);ny=normal_y/np.maximum(norm,1e-8)
    fields['normal_x']=nx;fields['normal_y']=ny
    # Raw profiles are retained; one-pixel smoothing only stabilizes the differentiated profile.
    offsets=np.arange(-12,13,dtype=np.float32)
    profiles=np.stack([map_coordinates(lum,[yy+t*ny,xx+t*nx],order=1,mode='nearest') for t in offsets],axis=0)
    smoothed=gaussian_filter(lum,1)
    smooth_profiles=np.stack([map_coordinates(smoothed,[yy+t*ny,xx+t*nx],order=1,mode='nearest') for t in offsets],axis=0)
    diff=np.diff(smooth_profiles,axis=0);positive=np.maximum(diff,0);negative=np.maximum(-diff,0)
    mass=positive.sum(axis=0);net=diff.sum(axis=0)
    cumulative=np.cumsum(positive,axis=0)/np.maximum(mass,1e-8)
    qs=[np.argmax(cumulative>=q,axis=0).astype(np.float32)-11.5 for q in [.1,.5,.9]]
    fields['positive_change_mass']=mass;fields['negative_change_mass']=negative.sum(axis=0)
    fields['net_change']=net
    fields['monotonicity']=net/(positive.sum(axis=0)+negative.sum(axis=0)+1e-8)
    fields['mass_q10_offset']=qs[0];fields['mass_q50_offset']=qs[1];fields['mass_q90_offset']=qs[2]
    fields['positive_gradient_mass_span']=qs[2]-qs[0]
    valid=(xx-12*np.abs(nx)>=0)&(xx+12*np.abs(nx)<lum.shape[1]-1)&(yy-12*np.abs(ny)>=0)&(yy+12*np.abs(ny)<lum.shape[0]-1)
    # Boundary activity is a flag, not proof of the true transition endpoint.
    boundary=(positive[:2].sum(axis=0)+positive[-2:].sum(axis=0))/4 > .25*np.maximum(positive.max(axis=0),1e-8)
    fields['profile_in_bounds']=valid;fields['boundary_active']=boundary
    fields['raw_profiles']=profiles;fields['smoothed_profiles']=smooth_profiles
    fields['normal_valid']=norm>1e-4
    fields['span_resolved']=(fields['monotonicity']>=.8)&(mass>=5)&(~boundary)&valid&(norm>1e-4)
    return fields

def raster(field, shape):
    return np.asarray(Image.fromarray(field.astype(np.float32)).resize((shape[1],shape[0]),Image.Resampling.BILINEAR))

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--source',type=Path,default=DEFAULT_SOURCE);ap.add_argument('--out',type=Path,default=ROOT/'output');ap.add_argument('--render-only',action='store_true');args=ap.parse_args()
    args.out.mkdir(parents=True,exist_ok=True)
    rgb=np.array(Image.open(args.source).convert('RGB'))
    if args.render_only:
        with np.load(args.out/'transition-fields.npz') as z: fields={k:z[k] for k in z.files}
    else:
        fields=measure(rgb)
        np.savez_compressed(args.out/'transition-fields.npz',**fields)
    shape=rgb.shape[:2]
    fine=raster(fields['gradient_sigma1']*5,shape) # gradient times 5 is a local linear approximation, not exact 5px sampler.
    total=raster(np.maximum(fields['net_change'],0),shape)
    # These masks are display only; all measurements retained in NPZ.
    mono=raster(np.clip(fields['monotonicity'],0,1),shape)
    coh=raster(fields['orientation_coherence'],shape)
    opacity_weight=np.clip(total/50,0,1)*mono*coh
    span=np.asarray(Image.fromarray(fields['positive_gradient_mass_span']).resize((shape[1],shape[0]),Image.Resampling.NEAREST))
    resolved=np.asarray(Image.fromarray(fields['span_resolved']).resize((shape[1],shape[0]),Image.Resampling.NEAREST))
    span_show=np.ma.array(span,mask=~resolved)
    signed_x=raster(fields['net_change']*fields['normal_x'],shape)
    signed_y=raster(fields['net_change']*fields['normal_y'],shape)
    plt.rcParams.update({'font.size':11,'figure.facecolor':'white'})
    def imagepanel(ax,data,title,cmap=None,vmin=None,vmax=None):
        im=ax.imshow(data,cmap=cmap,vmin=vmin,vmax=vmax,interpolation='nearest');ax.set_title(title);ax.set_xticks([]);ax.set_yticks([]);return im
    fig,axs=plt.subplots(1,3,figsize=(18,10.8),layout='constrained')
    imagepanel(axs[0],rgb,'Source — all of DashsTrack')
    a=imagepanel(axs[1],fine,'Fine gradient × 5\nlocal sharpness proxy','magma',0,60)
    b=imagepanel(axs[2],total,'Brightness change across local normal\n24 px end-to-end; bends included','magma',0,60)
    fig.colorbar(b,ax=axs[1:],label='Brightness units (both panels use 0–60)',shrink=.6)
    fig.suptitle('Whole-raster transition readings — no endpoint assignment or fixed ribbon width',fontsize=17)
    fig.savefig(args.out/'DashsTrack-transition-comparison.png',dpi=130);plt.close(fig)
    # Standalone full resolution materializations allow source/field toggling without a tiny overview.
    for name,data,cmap,lo,hi in [('fine-gradient',fine,'magma',0,60),('normal-total-change',total,'magma',0,60),('signed-x-change',signed_x,'RdBu_r',-60,60),('signed-y-change',signed_y,'RdBu_r',-60,60)]:
        rgba=plt.get_cmap(cmap)(np.clip((data-lo)/(hi-lo),0,1));Image.fromarray((rgba[:,:,:3]*255).astype(np.uint8)).save(args.out/f'DashsTrack-{name}.png')
    Image.fromarray(rgb).save(args.out/'DashsTrack-source.png')
    # Sparse-looking continuous overlay. No threshold or ownership interpretation.
    overlay=rgb.astype(float)/255;alpha=.65*opacity_weight
    color=np.array([0,.95,1.]);overlay=overlay*(1-alpha[:,:,None])+color*alpha[:,:,None]
    Image.fromarray((overlay*255).astype(np.uint8)).save(args.out/'DashsTrack-transition-overlay.png')
    crops={'H18-bends':(760,340,1085,880),'H16-straight':(1060,660,1245,1210),'H11-straight':(50,1650,450,1890)}
    for name,(x0,y0,x1,y1) in crops.items():
        sl=np.s_[y0:y1,x0:x1];fig,axs=plt.subplots(1,4,figsize=(14,7),layout='constrained')
        imagepanel(axs[0],rgb[sl],'Source')
        imagepanel(axs[1],fine[sl],'Fine gradient × 5','magma',0,60)
        b=imagepanel(axs[2],total[sl],'24 px normal change','magma',0,60)
        c=imagepanel(axs[3],span_show[sl],'Positive-change span\nblank = unresolved','viridis',0,24)
        fig.colorbar(b,ax=axs[1:3],label='Brightness change',shrink=.6)
        fig.colorbar(c,ax=axs[3],label='10–90% gradient-mass span (px)',shrink=.6)
        fig.suptitle(name+' — measured transitions also include terrain, glyphs, and circles',fontsize=14)
        fig.savefig(args.out/f'{name}-transition-detail.png',dpi=170);plt.close(fig)
    # Continuous signed fields reproduce the useful opposing-color view in both source axes.
    fig,axs=plt.subplots(1,3,figsize=(18,10.8),layout='constrained')
    imagepanel(axs[0],rgb,'Source');imagepanel(axs[1],signed_x,'Signed horizontal change','RdBu_r',-60,60)
    b=imagepanel(axs[2],signed_y,'Signed vertical change','RdBu_r',-60,60)
    fig.colorbar(b,ax=axs[1:],label='Normal change projected onto source axis',shrink=.6)
    fig.suptitle('Two-dimensional signed transition field — red increases, blue decreases',fontsize=17)
    fig.savefig(args.out/'DashsTrack-signed-transition-fields.png',dpi=160);plt.close(fig)
    receipt={'source':str(args.source),'sha256':hashlib.sha256(args.source.read_bytes()).hexdigest(),'source_size':[shape[1],shape[0]],'grid_stride_px':2,'grid_samples':int(fields['x'].size),'normal_sigma_px':2,'gradient_sigmas_px':[1,2,4],'profile_offsets_px':list(range(-12,13)),'brightness':'arithmetic RGB mean','profile_smoothing_sigma_px':1,'span':'10–90% positive derivative mass, conditional monotonicity>=0.8, mass>=5, no active boundary or out of bounds','unresolved_spans':int((~fields['span_resolved']).sum()),'cropping_view_only':crops,'boundary_active_rule':'mean positive derivative in first/last two intervals > 0.25 * profile peak','span_display_resampling':'nearest neighbor for both values and validity','comparison_display_range':[0,60],'detected_geometry':False,'ownership':False}
    (args.out/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
    for png in args.out.glob('*.png'):
        im=Image.open(png).convert('RGB');im.thumbnail((2000,2400));im.save(png.with_suffix('.jpg'),quality=90)
    print(json.dumps(receipt,indent=2))
if __name__=='__main__':main()
