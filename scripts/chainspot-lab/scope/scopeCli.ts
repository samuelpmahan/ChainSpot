import { existsSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CanonicalTruth } from '@chainspot/alg/g0/truth';
import { decodeInput } from '../sweep/inputShim';
import { loadTruth } from '../sweep/truthScoring';
import { loadScopeManifest, resolveManifestCasePaths } from './manifest';
import { makeContactSheet, renderScope } from './render';
import { SCOPE_TEMPLATES } from './templates';
import { consumeViewOptions, resolveScopeView } from './viewOptions';
import type { BoxTuple, PointTuple, Rect, ScopeCanonicalMeta, ScopeRequest, ScopeResolvedRequest } from './types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const DEFAULT_OUT = resolve(REPO_ROOT, 'artifacts', 'scope');

function usage(exitCode = 0): never {
	console.error([
		'SCOPE — inspect Sweep-canonical visual evidence',
		'',
		'Raster contract:',
		'  raw capture(s) -> Sweep StripChrome -> Sweep AutoStitch -> canonical raster -> Scope AutoCrop',
		'  `scope full` shows the entire canonical raster AFTER StripChrome/AutoStitch and BEFORE Scope AutoCrop.',
		'',
		'Usage:',
		'  lab scope IMAGE x,y [view flags]',
		'  lab scope IMAGE x,y,w,h [view flags]',
		'  lab scope full IMAGE [view flags]',
		'  lab scope mark IMAGE NAME x,y [view flags]',
		'  lab scope dots IMAGE NAME x,y x,y ... [view flags]',
		'  lab scope path IMAGE NAME x,y x,y ... [view flags]     # one-shot geometry only',
		'  lab scope --hole N IMAGE ANNOTATION.json [view flags]',
		'  lab scope --manifest MANIFEST.json [--case NAME] [--out-dir DIR]',
		'  lab scope contact-sheet MANIFEST.json [--case NAME] [--out FILE]',
		'  lab scope templates',
		'',
		'Views:',
		'  full                whole canonical raster, pre-ScopeCrop',
		'  default             CONTEXT -> LOCAL -> FORENSIC WIDE -> MID -> TIGHT',
		'',
		'View tuning:',
		'  --context N         Context source span (default 800 canonical px)',
		'  --context-out N     Context output size (default 800)',
		'  --full-out N        full-view output box (default 1200; aspect preserved)',
		'  --local-extra-w N   total extra Local width (default 100)',
		'  --local-extra-h N   total extra Local height (default 100)',
		'  --local-out N       Local output box',
		'  --fw N --fm N --ft N   forensic source spans',
		'  --forensic-out N    forensic tile output size',
		'  --no-grid           suppress coordinate grid on non-forensic views',
		'',
		'For persistent investigation and overlays: lab search --help',
		'For spatial navigation: lab traverse --help',
		'Scope does not execute detector plans; Sweep remains the only algorithm executor.'
	].join('\n'));
	process.exit(exitCode);
}

function slug(value: string): string { return value.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'scope'; }
function parsePoint(text: string): PointTuple { const parts=text.split(',').map(Number); if(parts.length!==2||parts.some(n=>!Number.isFinite(n)))throw new Error(`lab scope: expected x,y, got '${text}'.`); return[parts[0],parts[1]]; }
function parsePointOrBox(text:string):{point?:PointTuple;box?:BoxTuple}{const p=text.split(',').map(Number);if(p.some(n=>!Number.isFinite(n)))throw new Error(`lab scope: invalid coordinate '${text}'.`);if(p.length===2)return{point:[p[0],p[1]]};if(p.length===4&&p[2]>0&&p[3]>0)return{box:[p[0],p[1],p[2],p[3]]};throw new Error(`lab scope: expected x,y or x,y,w,h, got '${text}'.`);}
function bounds(points:readonly PointTuple[],pad=0):Rect{const xs=points.map(p=>p[0]),ys=points.map(p=>p[1]),x0=Math.min(...xs),x1=Math.max(...xs),y0=Math.min(...ys),y1=Math.max(...ys);return{x:x0-pad,y:y0-pad,w:Math.max(1,x1-x0+pad*2),h:Math.max(1,y1-y0+pad*2)};}
function option(args:string[],name:string):string|undefined{const i=args.indexOf(name);if(i<0)return undefined;if(i+1>=args.length)throw new Error(`lab scope: ${name} needs a value.`);const v=args[i+1];args.splice(i,2);return v;}

function requestToResolved(request:ScopeRequest,truth:CanonicalTruth|undefined,width:number,height:number):ScopeResolvedRequest{
	const template=request.full?'full':request.template??'default',color=request.color??0,common={template,color,view:request.view,richOverlay:request.richOverlay};
	if(request.full)return{...common,name:request.name??'full',kind:'full',focus:{x:0,y:0,w:width,h:height},points:[],richOverlay:false};
	if(request.point)return{...common,name:request.name??`point-${Math.round(request.point[0])}-${Math.round(request.point[1])}`,kind:'point',focus:{x:request.point[0],y:request.point[1],w:1,h:1},points:[request.point]};
	if(request.box)return{...common,name:request.name??`box-${request.box.map(n=>Math.round(n)).join('-')}`,kind:'box',focus:{x:request.box[0],y:request.box[1],w:request.box[2],h:request.box[3]},points:[]};
	if(request.mark)return{...common,name:request.name??'mark',kind:'mark',focus:{x:request.mark[0],y:request.mark[1],w:1,h:1},points:[request.mark]};
	if(request.dots){if(request.dots.length<2)throw new Error('lab scope: dots requires at least two points.');return{...common,name:request.name??'dots',kind:'dots',focus:bounds(request.dots),points:request.dots};}
	if(request.path){if(request.path.length<1)throw new Error('lab scope: path requires at least one point.');if(request.pointLabels&&request.pointLabels.length!==request.path.length)throw new Error('lab scope: path pointLabels must match path point count.');return{...common,name:request.name??'path',kind:'path',focus:bounds(request.path),points:request.path,pointLabels:request.pointLabels};}
	if(request.hole!==undefined){if(!truth)throw new Error(`lab scope: hole ${request.hole} requires annotation; BLIND mode will not derive truth.`);const hole=truth.holes.find(h=>h.number===request.hole);if(!hole)throw new Error(`lab scope: annotation has no hole ${request.hole}.`);const points:PointTuple[]=[[hole.tee.xPx,hole.tee.yPx],...hole.corridorBends.map(p=>[p.xPx,p.yPx] as PointTuple),[hole.basket.xPx,hole.basket.yPx]],pad=Math.max(0,hole.corridorWidthPx/2);return{...common,name:request.name??`hole-${request.hole}`,kind:'hole',focus:bounds(points,pad),points,hole:request.hole};}
	throw new Error('lab scope: empty request.');
}

function validateRequest(request:ScopeResolvedRequest,width:number,height:number):void{const inside=([x,y]:PointTuple)=>x>=0&&y>=0&&x<width&&y<height;for(const p of request.points)if(!inside(p))throw new Error(`lab scope: canonical point ${p[0]},${p[1]} is outside ${width}x${height}.`);if(request.kind==='box'){const r=request.focus;if(r.x<0||r.y<0||r.x+r.w>width||r.y+r.h>height)throw new Error(`lab scope: canonical box exceeds ${width}x${height}.`);}}

async function renderOne(imagePath:string,annotationPath:string|undefined,request:ScopeRequest,outputPath?:string,outDir=DEFAULT_OUT):Promise<string>{
	if(!existsSync(imagePath))throw new Error(`lab scope: image does not exist: ${imagePath}`);if(annotationPath&&!existsSync(annotationPath))throw new Error(`lab scope: annotation does not exist: ${annotationPath}`);
	const rawTruth=annotationPath?loadTruth(annotationPath):undefined,{report,image,canonicalTruth}=await decodeInput(imagePath,rawTruth);if(rawTruth&&!report.truthMatch)throw new Error(`lab scope: supplied annotation does not correspond to canonicalized raster ${imagePath}.`);const resolvedRequest=requestToResolved(request,canonicalTruth??rawTruth,image.width,image.height);validateRequest(resolvedRequest,image.width,image.height);
	const base=slug(basename(imagePath,extname(imagePath))),output=outputPath?resolve(outputPath):resolve(outDir,base,`${slug(resolvedRequest.name)}.png`),canonical:ScopeCanonicalMeta={imageId:report.imageId,widthPx:report.widthPx,heightPx:report.heightPx,stripChrome:report.stripChrome,autoStitch:{sourceCount:report.autoStitch.sourceCount,hadFallback:report.autoStitch.hadFallback}};
	const meta=renderScope({raster:{width:image.width,height:image.height,data:image.data,imageId:report.imageId},imagePath:resolve(imagePath),annotationPath:annotationPath?resolve(annotationPath):undefined,canonical,request:resolvedRequest,outputPath:output});console.log(`${meta.mode} · ${resolvedRequest.name} -> ${output}`);console.log(`  canonical: ${report.widthPx}x${report.heightPx} · StripChrome=${report.stripChrome.source} · AutoStitch=${report.autoStitch.sourceCount}`);return output;
}

async function runManifest(manifestPath:string,caseName?:string,outDir?:string):Promise<string[]>{const loaded=loadScopeManifest(manifestPath),selected=caseName?loaded.cases.filter(c=>c.name===caseName):loaded.cases;if(!selected.length)throw new Error(`lab scope: manifest has no case '${caseName}'.`);const outputs:string[]=[];for(const rawCase of selected){const c=resolveManifestCasePaths(loaded.dir,rawCase);console.log(`\n=== scope case ${c.name} · ${c.annotation?'TRUTH AVAILABLE':'BLIND'} ===`);for(let i=0;i<c.scopes.length;i++){const req=c.scopes[i],caseOut=resolve(outDir??DEFAULT_OUT,slug(c.name));outputs.push(await renderOne(c.image,c.annotation,{...req,name:req.name??`scope-${i+1}`,color:req.color??i},undefined,caseOut));}}return outputs;}

async function main():Promise<void>{const raw=process.argv.slice(2),args=raw[0]==='scope'?raw.slice(1):raw;if(!args.length||args.includes('--help')||args.includes('-h'))usage(0);if(args[0]==='templates'){for(const t of Object.values(SCOPE_TEMPLATES))console.log(`${t.id}\t${t.description}`);return;}if(args[0]==='full'){const image=args[1],rest=args.slice(2);if(!image)usage(2);const out=option(rest,'--out'),view=consumeViewOptions(rest);if(rest.length)throw new Error(`lab scope: unexpected args: ${rest.join(' ')}`);await renderOne(image,undefined,{name:'full',full:true,view:resolveScopeView(view)},out);return;}if(args[0]==='--manifest'){const manifest=args[1];if(!manifest)usage(2);const rest=args.slice(2),caseName=option(rest,'--case'),outDir=option(rest,'--out-dir');if(rest.length)throw new Error(`lab scope: unexpected args: ${rest.join(' ')}`);await runManifest(manifest,caseName,outDir);return;}if(args[0]==='contact-sheet'){const manifest=args[1];if(!manifest)usage(2);const rest=args.slice(2),caseName=option(rest,'--case'),out=option(rest,'--out');if(rest.length)throw new Error(`lab scope: unexpected args: ${rest.join(' ')}`);const outputs=await runManifest(manifest,caseName),output=resolve(out??resolve(DEFAULT_OUT,`contact-sheet-${slug(caseName??basename(manifest,extname(manifest)))}.png`));makeContactSheet(outputs,output);console.log(`contact-sheet -> ${output}`);return;}if(args[0]==='--hole'){const hole=Number(args[1]),image=args[2],annotation=args[3],rest=args.slice(4);if(!Number.isInteger(hole)||hole<=0||!image||!annotation)usage(2);const out=option(rest,'--out'),view=consumeViewOptions(rest);if(rest.length)throw new Error(`lab scope: unexpected args: ${rest.join(' ')}`);await renderOne(image,annotation,{name:`hole-${hole}`,hole,view},out);return;}if(args[0]==='mark'||args[0]==='dots'||args[0]==='path'){const kind=args[0],image=args[1],name=args[2],rest=args.slice(3);if(!image||!name)usage(2);const out=option(rest,'--out'),colorText=option(rest,'--color'),color=colorText===undefined?0:Number(colorText),view=consumeViewOptions(rest),points=rest.map(parsePoint);if(!Number.isFinite(color))throw new Error('lab scope: --color must be numeric.');if(kind==='mark'&&points.length!==1)throw new Error('lab scope: mark requires exactly one x,y point.');if(kind==='dots'&&points.length<2)throw new Error('lab scope: dots requires at least two points.');if(kind==='path'&&points.length<1)throw new Error('lab scope: path requires at least one point.');const req:ScopeRequest=kind==='mark'?{name,mark:points[0],color,view}:kind==='dots'?{name,dots:points,color,view}:{name,path:points,color,view};await renderOne(image,undefined,req,out);return;}const image=args[0],coordinate=args[1],rest=args.slice(2);if(!image||!coordinate)usage(2);const name=option(rest,'--name'),out=option(rest,'--out'),template=option(rest,'--template'),view=consumeViewOptions(rest);if(rest.length)throw new Error(`lab scope: unexpected args: ${rest.join(' ')}`);await renderOne(image,undefined,{name,template,view,...parsePointOrBox(coordinate)},out);}
main().catch(error=>{console.error((error as Error).message);process.exit(1);});
