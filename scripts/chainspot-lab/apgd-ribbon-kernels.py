from __future__ import annotations
import argparse, json, math, os, time, hashlib, gc
from pathlib import Path
from dataclasses import dataclass
import numpy as np
import cv2
from PIL import Image
from sklearn.linear_model import Ridge
from sklearn.metrics import roc_auc_score

# Experiment-only. Point these at the extracted Annotated corpus and a disposable output dir.
ROOT=Path(os.environ.get('CHAINSPOT_ANNOTATED_ROOT','/mnt/data/annotated_extract/Annotated'))
OUT=Path(os.environ.get('CHAINSPOT_APGD_OUT','/mnt/data/apgd_ribbon'))
OUT.mkdir(exist_ok=True)
COURSES={
 'DashsTrack':('DashsTrack/DashsTrack-full.jpg','DashsTrack/DashsTrack-full.annotation.json',0),
 'Heritage':('Heritage/HeritagePark-full.png','Heritage/HeritagePark-full.annotation.json',429),
 'Lenard':('Lenard/Lenard-full.PNG','Lenard/Lenard-full.annotation.json',429),
 'TowneLake':('TowneLake/TowneLake-full.png','TowneLake/TowneLake-full.annotation.json',532),
}
OFFSETS=np.array([-1.25,-1.0,-.8,-.65,-.5,-.35,-.2,0,.2,.35,.5,.65,.8,1.0,1.25],float)
OVERLAY=np.array([179.,179.,179.])
LUMA=np.array([.2126,.7152,.0722])
TOPK=6
STEP=7.0


def sha256(p:Path):
 h=hashlib.sha256();
 with open(p,'rb') as f:
  for b in iter(lambda:f.read(1<<20),b''):h.update(b)
 return h.hexdigest()

def unit(v):
 v=np.asarray(v,float);return v/max(float(np.linalg.norm(v)),1e-9)

def bilinear(img, pts):
 pts=np.asarray(pts,float)
 if len(pts)==0:return np.zeros((0,3),float)
 h,w=img.shape[:2];x=np.clip(pts[:,0],0,w-1.001);y=np.clip(pts[:,1],0,h-1.001)
 x0=np.floor(x).astype(int);y0=np.floor(y).astype(int);x1=x0+1;y1=y0+1;dx=x-x0;dy=y-y0
 return ((1-dx)[:,None]*(1-dy)[:,None]*img[y0,x0]+dx[:,None]*(1-dy)[:,None]*img[y0,x1]+(1-dx)[:,None]*dy[:,None]*img[y1,x0]+dx[:,None]*dy[:,None]*img[y1,x1])

def closest_projection(p, poly):
 p=np.asarray(p,float);best=(1e99,0,0.,np.asarray(poly[0],float))
 for i in range(len(poly)-1):
  a=np.asarray(poly[i],float);b=np.asarray(poly[i+1],float);v=b-a;den=float(np.dot(v,v))
  t=0. if den<1e-9 else float(np.clip(np.dot(p-a,v)/den,0,1));q=a+t*v;d=float(np.linalg.norm(p-q))
  if d<best[0]:best=(d,i,t,q)
 return best

def prefix_to_projection(poly, seg, q):
 out=[np.asarray(x,float) for x in poly[:seg+1]]+[np.asarray(q,float)]
 return dedupe_poly(out)

def suffix_from_projection(poly, seg, q):
 out=[np.asarray(q,float)]+[np.asarray(x,float) for x in poly[seg+1:]]
 return dedupe_poly(out)

def dedupe_poly(poly):
 out=[]
 for p in poly:
  p=np.asarray(p,float)
  if not out or np.linalg.norm(p-out[-1])>1e-6:out.append(p)
 return out

def path_points(poly, step=STEP):
 pts=[];dirs=[];svals=[];acc=0.;total=sum(float(np.linalg.norm(np.asarray(b)-np.asarray(a))) for a,b in zip(poly,poly[1:]))
 if total<1:return np.zeros((0,2)),np.zeros((0,2)),np.zeros(0)
 for a,b in zip(poly,poly[1:]):
  a=np.asarray(a,float);b=np.asarray(b,float);v=b-a;L=float(np.linalg.norm(v))
  if L<1e-6:continue
  u=v/L;n=max(1,int(math.ceil(L/step)))
  for t in np.linspace(0,1,n,endpoint=False):
   pts.append(a+t*v);dirs.append(u);svals.append((acc+t*L)/total)
  acc+=L
 pts.append(np.asarray(poly[-1],float));dirs.append(unit(np.asarray(poly[-1])-np.asarray(poly[-2])));svals.append(1.)
 return np.asarray(pts),np.asarray(dirs),np.asarray(svals)

def longest_run(mask, step=STEP):
 best=cur=0
 for x in mask:
  if x:cur+=1;best=max(best,cur)
  else:cur=0
 return best*step

def q(a,p,default=0.):
 a=np.asarray(a,float);a=a[np.isfinite(a)]
 return float(np.quantile(a,p)) if len(a) else default

@dataclass
class Hole:
 course:str; number:int; tee:np.ndarray; badge:np.ndarray; basket:np.ndarray; bends:list[np.ndarray]; W:float
 @property
 def poly(self):return dedupe_poly([self.tee,self.badge,*self.bends,self.basket])


def detect_badges(img, holes):
 v=img.max(axis=2);dark=(v<=45).astype(np.uint8);n,lab,stats,cens=cv2.connectedComponentsWithStats(dark,8)
 cand=[]
 for i in range(1,n):
  x,y,w,h,area=stats[i];fill=area/max(1,w*h)
  if 34<=w<=58 and 24<=h<=46 and .38<=fill<=.98:cand.append((np.array(cens[i],float),w,h,area,fill))
 # Evaluation-only attachment: nearest annotated corridor, one plate per hole.
 scored=[]
 for c in cand:
  p=c[0];ds=[]
  for H in holes:
   d,_,_,_=closest_projection(p,[H.tee,*H.bends,H.basket]);ds.append((d,H.number))
  ds.sort();scored.append((ds[0][0],ds[0][1],ds[1][0]-ds[0][0],c))
 scored.sort();chosen={}
 for d,hn,margin,c in scored:
  if hn not in chosen and d<35:chosen[hn]=c[0]
 return chosen

def load_course(course):
 imrel,anrel,top=COURSES[course];ip=ROOT/imrel;ap=ROOT/anrel
 img=np.asarray(Image.open(ip).convert('RGB'),float);ann=json.load(open(ap));h=ann['sourceImage']['heightPx'];source_h=img.shape[0]
 if img.shape[0]!=h:img=img[top:top+h]
 class H0:pass
 tmp=[]
 for H in ann['holes']:
  z=H0();z.number=H['number'];z.tee=np.array([H['tee']['xPx'],H['tee']['yPx']],float);z.basket=np.array([H['basket']['xPx'],H['basket']['yPx']],float);z.bends=[np.array([b['xPx'],b['yPx']],float) for b in H.get('corridorBends',[])];tmp.append(z)
 badges=detect_badges(img,tmp)
 if len(badges)!=18:raise RuntimeError(f'{course}: expected 18 badge plates, got {len(badges)}')
 holes=[]
 for H,z in zip(ann['holes'],tmp):holes.append(Hole(course,H['number'],z.tee,badges[H['number']],z.basket,z.bends,float(H['corridorWidthPx'])))
 return img,holes,{'imageSha256':sha256(ip),'annotationSha256':sha256(ap),'cropTop':top if source_h!=h else 0,'raster':[img.shape[1],img.shape[0]]}

def known_mask(pts, holes):
 pts=np.asarray(pts,float);ok=np.ones(len(pts),bool);x=pts[:,0];y=pts[:,1]
 for H in holes:
  ok &= ~((abs(x-H.badge[0])<=30)&(abs(y-H.badge[1])<=26))
  ok &= ~((abs(x-H.tee[0])<=22)&(abs(y-H.tee[1])<=22))
  ok &= ~((abs(x-H.basket[0])<=27)&(y>=H.basket[1]-76)&(y<=H.basket[1]+12))
 return ok

def build_candidate(H, teeH, basketH):
 badge=H.badge
 if teeH.number==H.number:head=[H.tee,badge]
 else:
  p=teeH.poly;_,seg,_,proj=closest_projection(badge,p);head=prefix_to_projection(p,seg,proj)+[badge]
 if basketH.number==H.number:tail=[badge,*H.bends,H.basket]
 else:
  p=basketH.poly;_,seg,_,proj=closest_projection(badge,p);tail=[badge,proj]+suffix_from_projection(p,seg,proj)[1:]
 return dedupe_poly(head+tail[1:])

def profile_features(img, holes, poly, W):
 pts,dirs,sfrac=path_points(poly)
 if len(pts)<3:return None
 ok=known_mask(pts,holes);pts=pts[ok];dirs=dirs[ok];sfrac=sfrac[ok]
 if len(pts)<3:return None
 normals=np.c_[-dirs[:,1],dirs[:,0]];P=pts[:,None,:]+normals[:,None,:]*(OFFSETS[None,:,None]*W)
 RGB=bilinear(img,P.reshape(-1,2)).reshape(len(pts),len(OFFSETS),3)
 far=np.where(np.abs(OFFSETS)>=1.0)[0];bg=RGB[:,far,:].mean(axis=1);o=OVERLAY[None,:]-bg;den=np.sum(o*o,axis=1)+30.;dd=RGB-bg[:,None,:]
 alpha=np.sum(dd*o[:,None,:],axis=2)/den[:,None];alpha=np.clip(alpha,-1.5,2.5);pred=bg[:,None,:]+alpha[:,:,None]*o[:,None,:]
 resid=np.linalg.norm(RGB-pred,axis=2)/(np.linalg.norm(dd,axis=2)+10.);lum=RGB@LUMA;bl=bg@LUMA;lumrel=(lum-bl[:,None])/80.
 feat={}
 for j,u in enumerate(OFFSETS):
  tag=f'u{u:+.2f}';feat[f'a_mean_{tag}']=float(np.mean(alpha[:,j]));feat[f'a_q25_{tag}']=q(alpha[:,j],.25);feat[f'l_mean_{tag}']=float(np.mean(lumrel[:,j]))
 inner=np.where(np.abs(OFFSETS)<=.35)[0];outer=np.where(np.abs(OFFSETS)>=.8)[0];ai=alpha[:,inner].mean(axis=1);ao=alpha[:,outer].mean(axis=1);contrast=ai-ao
 def idx(v):return int(np.argmin(np.abs(OFFSETS-v)))
 el=np.abs(alpha[:,idx(-.35)]-alpha[:,idx(-.65)]);er=np.abs(alpha[:,idx(.35)]-alpha[:,idx(.65)]);paired=np.minimum(el,er);single=np.maximum(el,er)-paired;sym=np.mean(np.abs(alpha-alpha[:,::-1]),axis=1)
 prof=np.maximum(alpha-alpha[:,outer].mean(axis=1)[:,None],0);mass=prof.sum(axis=1)+1e-6;com=(prof*OFFSETS[None,:]).sum(axis=1)/mass;width2=np.sqrt((prof*(OFFSETS[None,:]-com[:,None])**2).sum(axis=1)/mass)
 seqs={'contrast':contrast,'paired_edge':paired,'single_edge':single,'symmetry':sym,'com_abs':np.abs(com),'width2':width2,'inner_alpha':ai,'inner_resid':resid[:,inner].mean(axis=1),'outer_alpha':ao}
 for name,a in seqs.items():
  feat[f'{name}_mean']=float(np.mean(a));feat[f'{name}_q10']=q(a,.10);feat[f'{name}_q25']=q(a,.25);feat[f'{name}_std']=float(np.std(a));glob=float(np.mean(a))
  for bi in range(8):
   ix=(sfrac>=bi/8)&(sfrac<((bi+1)/8 if bi<7 else 1.000001));feat[f'{name}_s{bi}']=float(np.mean(a[ix])) if ix.any() else glob
  aa=np.asarray(a,float);ss=np.asarray(sfrac,float)
  for k in (1,2,3):feat[f'{name}_cos{k}']=float(np.mean((aa-glob)*np.cos(k*math.pi*ss)))
  sd=float(np.std(aa))+1e-6;feat[f'{name}_tv_z']=float(np.mean(np.abs(np.diff(aa)))/sd) if len(aa)>1 else 0.;feat[f'{name}_lag1']=float(np.corrcoef(aa[:-1],aa[1:])[0,1]) if len(aa)>2 and np.std(aa[:-1])>1e-6 and np.std(aa[1:])>1e-6 else 0.
 def tied(prefix,u):
  if u==0:return feat[f'{prefix}_u+0.00']
  return .5*(feat[f'{prefix}_u+{u:.2f}']+feat[f'{prefix}_u-{u:.2f}'])
 for u in (.20,.35,.50,.65,.80,1.00,1.25):feat[f'tied_a_mean_{u:.2f}']=tied('a_mean',u);feat[f'tied_a_q25_{u:.2f}']=tied('a_q25',u);feat[f'tied_l_mean_{u:.2f}']=tied('l_mean',u)
 feat['tied_edge_035_065']=abs(tied('a_mean',.35)-tied('a_mean',.65));feat['tied_center_outer']=tied('a_mean',.20)-.5*(tied('a_mean',.80)+tied('a_mean',1.00));feat['tied_center_flatness']=abs(tied('a_mean',.20)-tied('a_mean',.35))
 feat['contrast_frac_neg']=float(np.mean(contrast<0));feat['contrast_frac_low']=float(np.mean(contrast<.10));feat['contrast_longest_neg_W']=longest_run(contrast<0)/W;feat['contrast_longest_low_W']=longest_run(contrast<.10)/W;feat['paired_frac_low']=float(np.mean(paired<.08));feat['paired_longest_low_W']=longest_run(paired<.08)/W
 for name,a in [('contrast',contrast),('paired',paired),('inner_alpha',ai),('outer_alpha',ao)]:
  front=a[sfrac<=.42];back=a[sfrac>=.58];fm=float(np.mean(front)) if len(front) else float(np.mean(a));bm=float(np.mean(back)) if len(back) else float(np.mean(a));feat[f'{name}_front']=fm;feat[f'{name}_back']=bm;feat[f'{name}_front_minus_back']=fm-bm
 seglens=[];turns=[]
 for a,b in zip(poly,poly[1:]):seglens.append(float(np.linalg.norm(np.asarray(b)-np.asarray(a))))
 for a,b,c in zip(poly,poly[1:],poly[2:]):
  u=unit(np.asarray(b)-np.asarray(a));v=unit(np.asarray(c)-np.asarray(b));turns.append(math.degrees(math.acos(float(np.clip(np.dot(u,v),-1,1)))))
 L=sum(seglens);ch=float(np.linalg.norm(np.asarray(poly[-1])-np.asarray(poly[0])));feat['g_length_W']=L/W;feat['g_efficiency']=L/max(ch,1e-6);feat['g_turn_sum']=sum(turns);feat['g_turn_max']=max(turns) if turns else 0.;feat['g_vertices']=len(poly)-2;feat['known_points']=len(pts);feat['known_frac']=float(len(pts)/max(1,len(ok)))
 return feat

def extract_course(course):
 t0=time.perf_counter();img,holes,prov=load_course(course);rows=[]
 for H in holes:
  nt=sorted(holes,key=lambda T:float(np.linalg.norm(T.tee-H.badge)))[:TOPK];nb=sorted(holes,key=lambda B:float(np.linalg.norm(B.basket-H.badge)))[:TOPK]
  if H not in nt:nt[-1]=H
  if H not in nb:nb[-1]=H
  nt=sorted({x.number:x for x in nt}.values(),key=lambda x:x.number);nb=sorted({x.number:x for x in nb}.values(),key=lambda x:x.number)
  for T in nt:
   for B in nb:
    poly=build_candidate(H,T,B);f=profile_features(img,holes,poly,H.W)
    if f is None:continue
    rows.append({'course':course,'badgeHole':H.number,'teeHole':T.number,'basketHole':B.number,'truth':T.number==H.number and B.number==H.number,'features':f})
 doc={'course':course,'provenance':prov,'parameters':{'offsetsW':OFFSETS.tolist(),'topK':TOPK,'stepPx':STEP,'overlayRGB':OVERLAY.tolist()},'rows':rows,'seconds':time.perf_counter()-t0};p=OUT/f'{course}.features.json';json.dump(doc,open(p,'w'),separators=(',',':'));return doc,p

def feature_matrix(docs, include_geometry=False):
 rows=[r for d in docs for r in d['rows']];names=sorted(k for k in rows[0]['features'] if (include_geometry or not k.startswith('g_')) and k!='known_points');X=np.array([[r['features'].get(k,np.nan) for k in names] for r in rows],float);y=np.array([1 if r['truth'] else 0 for r in rows],int);return rows,names,X,y

def basis_fit(Xtrain, variant):
 mu=np.nanmean(Xtrain,axis=0);sd=np.nanstd(Xtrain,axis=0);sd=np.where(sd<1e-6,1,sd)
 def tr(X):
  z=np.nan_to_num((X-mu)/sd,nan=0,posinf=0,neginf=0)
  if variant=='linear':return z
  if variant=='u':return np.c_[z,z*z]
  if variant=='uabs':return np.c_[z,z*z,np.abs(z)]
  if variant=='hinge':return np.c_[z,z*z,np.maximum(0,z+1),np.maximum(0,z),np.maximum(0,z-1)]
  if variant=='rbf':return np.concatenate([z,z*z]+[np.exp(-.5*((z-c)/.75)**2) for c in (-2.,-1.,0.,1.,2.)],axis=1)
  raise ValueError(variant)
 return tr

def pairwise_dataset(rows,X,y,train_courses,score_filter=None):
 groups={}
 for i,r in enumerate(rows):
  if r['course'] in train_courses:groups.setdefault((r['course'],r['badgeHole']),[]).append(i)
 A=[];Y=[];W=[]
 for ii in groups.values():
  t=[i for i in ii if y[i]==1]
  if len(t)!=1:continue
  ti=t[0];rivals=[i for i in ii if y[i]==0]
  if score_filter is not None:rivals=score_filter(ti,rivals)
  if not rivals:continue
  wt=1/max(1,len(rivals))
  for ri in rivals:
   d=X[ti]-X[ri];A.extend([d,-d]);Y.extend([1.,-1.]);W.extend([wt,wt])
 return np.asarray(A),np.asarray(Y),np.asarray(W)

def train_ranker(rows,names,X,y,holdout,variant='u',alpha=10.,hard_mine=False):
 train=[c for c in COURSES if c!=holdout];tr=np.array([i for i,r in enumerate(rows) if r['course'] in train]);te=np.array([i for i,r in enumerate(rows) if r['course']==holdout]);transform=basis_fit(X[tr],variant);P=transform(X);A,Y,W=pairwise_dataset(rows,P,y,train);model=Ridge(alpha=alpha,fit_intercept=False).fit(A,Y,sample_weight=W)
 if hard_mine:
  raw=P@model.coef_
  def filt(ti,rivals):return sorted(rivals,key=lambda i:raw[i],reverse=True)[:5]
  A,Y,W=pairwise_dataset(rows,P,y,train,filt);model=Ridge(alpha=alpha,fit_intercept=False).fit(A,Y,sample_weight=W)
 scores=P@model.coef_;groups={}
 for i in te:groups.setdefault(rows[i]['badgeHole'],[]).append(i)
 ranks=[];margins=[];details=[]
 for h,ii in sorted(groups.items()):
  t=[i for i in ii if y[i]==1]
  if len(t)!=1:continue
  ti=t[0];ordered=sorted(ii,key=lambda i:(-scores[i],rows[i]['teeHole'],rows[i]['basketHole']));rank=ordered.index(ti)+1;rival=max((scores[i] for i in ii if i!=ti),default=-1e9);ranks.append(rank);margins.append(float(scores[ti]-rival));best=ordered[0];details.append({'hole':h,'rank':rank,'best':[rows[best]['teeHole'],rows[best]['basketHole']]})
 return {'holdout':holdout,'variant':variant+('-hard1' if hard_mine else ''),'rank1':sum(r==1 for r in ranks),'n':len(ranks),'meanRank':float(np.mean(ranks)),'medianMargin':float(np.median(margins)),'auc':float(roc_auc_score(y[te],scores[te])),'details':details}

def fit_suite(include_geometry=False):
 docs=[json.load(open(OUT/f'{c}.features.json')) for c in COURSES];rows,names,X,y=feature_matrix(docs,include_geometry);specs=[('linear',10.,False),('u',10.,False),('uabs',10.,False),('hinge',15.,False),('rbf',25.,False),('u',10.,True)];results=[]
 for variant,alpha,hard in specs:
  t0=time.perf_counter();folds=[train_ranker(rows,names,X,y,h,variant,alpha,hard) for h in COURSES];summary={'variant':variant+('-hard1' if hard else ''),'includeGeometry':include_geometry,'rank1':sum(f['rank1'] for f in folds),'n':sum(f['n'] for f in folds),'meanRank':float(np.mean([f['meanRank'] for f in folds])),'medianFoldMargin':float(np.median([f['medianMargin'] for f in folds])),'folds':folds,'seconds':time.perf_counter()-t0};results.append(summary);open(OUT/'runs.jsonl','a').write(json.dumps(summary,separators=(',',':'))+'\n');misses=[f"{f['holdout']}:{d['hole']}r{d['rank']}" for f in folds for d in f['details'] if d['rank']!=1];open(OUT/'NOTES.md','a').write(f"\n- {summary['variant']} geom={include_geometry}: {summary['rank1']}/{summary['n']} rank1; meanRank={summary['meanRank']:.3f}; misses={','.join(misses[:24]) or 'none'}; {summary['seconds']:.2f}s\n");gc.collect()
 return {'featureNames':names,'results':results}

def main():
 ap=argparse.ArgumentParser();ap.add_argument('--extract-course',choices=COURSES);ap.add_argument('--fit-suite',action='store_true');ap.add_argument('--with-geometry',action='store_true');args=ap.parse_args()
 if args.extract_course:
  doc,p=extract_course(args.extract_course);print(json.dumps({'course':args.extract_course,'rows':len(doc['rows']),'truthRows':sum(r['truth'] for r in doc['rows']),'seconds':doc['seconds'],'path':str(p),'provenance':doc['provenance']},indent=2))
 if args.fit_suite:
  out=fit_suite(args.with_geometry);json.dump(out,open(OUT/('suite-geometry.json' if args.with_geometry else 'suite-ribbon.json'),'w'),indent=2);print(json.dumps([{k:v for k,v in r.items() if k!='folds'} for r in out['results']],indent=2))
if __name__=='__main__':main()
