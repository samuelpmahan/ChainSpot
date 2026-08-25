import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PNG } from 'pngjs';
import { resolveScopeView } from './viewOptions';
import type { PointTuple, RasterImage, Rect, ScopeCanonicalMeta, ScopePanelMeta, ScopePinOverlay, ScopeRenderMeta, ScopeResolvedRequest } from './types';
import { getScopeTemplate, inspectionAnchor } from './templates';

const BG = [24, 26, 30, 255] as const;
const FRAME = [210, 214, 220, 255] as const;
const INNER = [70, 76, 84, 255] as const;
const CLAIM = [255, 235, 90, 255] as const;
const TEMP_PIN = [105, 235, 215, 255] as const;
const GRID = [182, 188, 194, 255] as const;
const TEXT = [238, 240, 244, 255] as const;
const LABEL_BG = [38, 42, 48, 255] as const;
const PATH_COLORS = [[255,90,90,255],[90,180,255,255],[120,230,130,255],[225,130,255,255],[255,175,80,255],[110,225,215,255]] as const;
const CHROME = 8;
const LABEL_H = 24;
type Rgba = readonly number[];
interface DestRect { readonly x: number; readonly y: number; readonly w: number; readonly h: number; }

function rgbaIndex(width: number, x: number, y: number): number { return (y * width + x) * 4; }
function setPixel(data: Uint8Array, width: number, height: number, x: number, y: number, rgba: Rgba): void {
	if (x < 0 || y < 0 || x >= width || y >= height) return;
	const i = rgbaIndex(width, x, y); data[i]=rgba[0]; data[i+1]=rgba[1]; data[i+2]=rgba[2]; data[i+3]=rgba[3];
}
function fill(data: Uint8Array, width: number, height: number, rgba: Rgba): void { for (let y=0;y<height;y++) for (let x=0;x<width;x++) setPixel(data,width,height,x,y,rgba); }
function fillRect(data: Uint8Array,width:number,height:number,x:number,y:number,w:number,h:number,rgba:Rgba):void { for(let yy=y;yy<y+h;yy++) for(let xx=x;xx<x+w;xx++) setPixel(data,width,height,xx,yy,rgba); }
function drawLine(data:Uint8Array,width:number,height:number,x0:number,y0:number,x1:number,y1:number,rgba:Rgba,thickness=1):void {
	let x=Math.round(x0),y=Math.round(y0); const tx=Math.round(x1),ty=Math.round(y1); const dx=Math.abs(tx-x),sx=x<tx?1:-1; const dy=-Math.abs(ty-y),sy=y<ty?1:-1; let err=dx+dy;
	for(;;){const r=Math.max(0,Math.floor((thickness-1)/2)); fillRect(data,width,height,x-r,y-r,Math.max(1,thickness),Math.max(1,thickness),rgba); if(x===tx&&y===ty)break; const e2=2*err; if(e2>=dy){err+=dy;x+=sx;} if(e2<=dx){err+=dx;y+=sy;}}
}
function drawDashedLine(data:Uint8Array,width:number,height:number,x0:number,y0:number,x1:number,y1:number,rgba:Rgba):void { const dx=x1-x0,dy=y1-y0,steps=Math.max(1,Math.ceil(Math.max(Math.abs(dx),Math.abs(dy)))); for(let i=0;i<=steps;i++){if(Math.floor(i/4)%2)continue;setPixel(data,width,height,Math.round(x0+dx*i/steps),Math.round(y0+dy*i/steps),rgba);} }
function drawRect(data:Uint8Array,width:number,height:number,x:number,y:number,w:number,h:number,rgba:Rgba,thickness=1):void { for(let t=0;t<thickness;t++){drawLine(data,width,height,x-t,y-t,x+w+t,y-t,rgba);drawLine(data,width,height,x-t,y+h+t,x+w+t,y+h+t,rgba);drawLine(data,width,height,x-t,y-t,x-t,y+h+t,rgba);drawLine(data,width,height,x+w+t,y-t,x+w+t,y+h+t,rgba);} }
function drawCircle(data:Uint8Array,width:number,height:number,cx:number,cy:number,radius:number,rgba:Rgba):void { const r2=radius*radius; for(let y=-radius;y<=radius;y++)for(let x=-radius;x<=radius;x++)if(x*x+y*y<=r2)setPixel(data,width,height,Math.round(cx+x),Math.round(cy+y),rgba); }
function drawRing(data:Uint8Array,width:number,height:number,cx:number,cy:number,radius:number,rgba:Rgba):void { const inner2=(radius-1)*(radius-1),outer2=(radius+1)*(radius+1); for(let y=-radius-1;y<=radius+1;y++)for(let x=-radius-1;x<=radius+1;x++){const d=x*x+y*y;if(d>=inner2&&d<=outer2)setPixel(data,width,height,Math.round(cx+x),Math.round(cy+y),rgba);} }
function drawDiamond(data:Uint8Array,width:number,height:number,cx:number,cy:number,r:number,rgba:Rgba):void { drawLine(data,width,height,cx,cy-r,cx+r,cy,rgba);drawLine(data,width,height,cx+r,cy,cx,cy+r,rgba);drawLine(data,width,height,cx,cy+r,cx-r,cy,rgba);drawLine(data,width,height,cx-r,cy,cx,cy-r,rgba);drawCircle(data,width,height,cx,cy,1,rgba); }

const GLYPHS: Record<string, readonly string[]> = {
'0':['111','101','101','101','111'],'1':['010','110','010','010','111'],'2':['111','001','111','100','111'],'3':['111','001','111','001','111'],'4':['101','101','111','001','001'],'5':['111','100','111','001','111'],'6':['111','100','111','101','111'],'7':['111','001','010','010','010'],'8':['111','101','111','101','111'],'9':['111','101','111','001','111'],
'A':['010','101','111','101','101'],'B':['110','101','110','101','110'],'C':['011','100','100','100','011'],'D':['110','101','101','101','110'],'E':['111','100','110','100','111'],'F':['111','100','110','100','100'],'G':['011','100','101','101','011'],'H':['101','101','111','101','101'],'I':['111','010','010','010','111'],'J':['001','001','001','101','010'],'K':['101','101','110','101','101'],'L':['100','100','100','100','111'],'M':['101','111','111','101','101'],'N':['101','111','111','111','101'],'O':['010','101','101','101','010'],'P':['110','101','110','100','100'],'Q':['010','101','101','111','011'],'R':['110','101','110','101','101'],'S':['011','100','010','001','110'],'T':['111','010','010','010','010'],'U':['101','101','101','101','111'],'V':['101','101','101','101','010'],'W':['101','101','111','111','101'],'X':['101','101','010','101','101'],'Y':['101','101','010','010','010'],'Z':['111','001','010','100','111'],'+':['010','010','111','010','010'],'-':['000','000','111','000','000'],':':['000','010','000','010','000'],'/':['001','001','010','100','100'],'.':['000','000','000','000','010'],' ':['000','000','000','000','000']};
function drawText(data:Uint8Array,width:number,height:number,x:number,y:number,text:string,scale=1,rgba:Rgba=TEXT):void { let ox=x; for(const raw of text.toUpperCase()){const glyph=GLYPHS[raw]??GLYPHS[' '];for(let gy=0;gy<5;gy++)for(let gx=0;gx<3;gx++)if(glyph[gy][gx]==='1')fillRect(data,width,height,ox+gx*scale,y+gy*scale,scale,scale,rgba);ox+=4*scale;} }
function drawNumber(data:Uint8Array,width:number,height:number,cx:number,cy:number,n:number):void { const text=String(n),scale=2,totalW=text.length*8-2;drawText(data,width,height,Math.round(cx-totalW/2),Math.round(cy-5),text,scale,[15,15,15,255]); }

function contentRect(panel:ScopePanelMeta,px:number,py:number):DestRect { const scale=Math.min(panel.outputPx/panel.source.w,panel.outputPx/panel.source.h);const w=Math.max(1,Math.round(panel.source.w*scale)),h=Math.max(1,Math.round(panel.source.h*scale));return{x:px+Math.floor((panel.outputPx-w)/2),y:py+Math.floor((panel.outputPx-h)/2),w,h}; }
function sampleNearest(src:RasterImage,sx:number,sy:number):Rgba { const x=Math.max(0,Math.min(src.width-1,Math.round(sx))),y=Math.max(0,Math.min(src.height-1,Math.round(sy))),i=rgbaIndex(src.width,x,y);return[src.data[i],src.data[i+1],src.data[i+2],src.data[i+3]]; }
function sampleBilinear(src:RasterImage,sx:number,sy:number):Rgba { const x0=Math.max(0,Math.min(src.width-1,Math.floor(sx))),y0=Math.max(0,Math.min(src.height-1,Math.floor(sy))),x1=Math.min(src.width-1,x0+1),y1=Math.min(src.height-1,y0+1),fx=Math.max(0,Math.min(1,sx-x0)),fy=Math.max(0,Math.min(1,sy-y0)),out=[0,0,0,0];for(let c=0;c<4;c++){const a=src.data[rgbaIndex(src.width,x0,y0)+c]*(1-fx)+src.data[rgbaIndex(src.width,x1,y0)+c]*fx;const b=src.data[rgbaIndex(src.width,x0,y1)+c]*(1-fx)+src.data[rgbaIndex(src.width,x1,y1)+c]*fx;out[c]=Math.round(a*(1-fy)+b*fy);}return out; }
function copyPanel(src:RasterImage,panel:ScopePanelMeta,out:Uint8Array,outWidth:number,outHeight:number,px:number,py:number):DestRect { const dest=contentRect(panel,px,py);for(let oy=0;oy<dest.h;oy++)for(let ox=0;ox<dest.w;ox++){const sx=panel.source.x+((ox+.5)/dest.w)*panel.source.w-.5,sy=panel.source.y+((oy+.5)/dest.h)*panel.source.h-.5;setPixel(out,outWidth,outHeight,dest.x+ox,dest.y+oy,panel.resampling==='nearest'?sampleNearest(src,sx,sy):sampleBilinear(src,sx,sy));}return dest; }
function imageToPanel(panel:ScopePanelMeta,dest:DestRect,p:PointTuple):PointTuple { return[dest.x+((p[0]-panel.source.x)/panel.source.w)*dest.w,dest.y+((p[1]-panel.source.y)/panel.source.h)*dest.h]; }
function isForensic(panel:ScopePanelMeta):boolean{return panel.name.startsWith('forensic-');}
function pointInside(rect:Rect,p:PointTuple):boolean{return p[0]>=rect.x&&p[1]>=rect.y&&p[0]<=rect.x+rect.w&&p[1]<=rect.y+rect.h;}
function niceGridStep(span:number):number{const raw=Math.max(1,span/8),power=10**Math.floor(Math.log10(raw)),n=raw/power,nice=n<=1?1:n<=2?2:n<=2.5?2.5:n<=5?5:10;return nice*power;}
function drawGrid(data:Uint8Array,width:number,height:number,panel:ScopePanelMeta,dest:DestRect):void{if(!panel.grid||isForensic(panel))return;const step=niceGridStep(Math.max(panel.source.w,panel.source.h)),firstX=Math.ceil(panel.source.x/step)*step,firstY=Math.ceil(panel.source.y/step)*step;for(let x=firstX;x<=panel.source.x+panel.source.w;x+=step){const p=imageToPanel(panel,dest,[x,panel.source.y]);drawDashedLine(data,width,height,p[0],dest.y,p[0],dest.y+dest.h,GRID);drawText(data,width,height,Math.round(p[0])+3,dest.y+3,String(Math.round(x)),1,TEXT);}for(let y=firstY;y<=panel.source.y+panel.source.h;y+=step){const p=imageToPanel(panel,dest,[panel.source.x,y]);drawDashedLine(data,width,height,dest.x,p[1],dest.x+dest.w,p[1],GRID);drawText(data,width,height,dest.x+3,Math.round(p[1])+3,String(Math.round(y)),1,TEXT);}}

function overlayForensicTarget(data:Uint8Array,width:number,height:number,panel:ScopePanelMeta,dest:DestRect,request:ScopeResolvedRequest):void{const p=imageToPanel(panel,dest,inspectionAnchor(request)),cx=Math.round(p[0]),cy=Math.round(p[1]),gap=3,arm=9;drawLine(data,width,height,cx-arm,cy,cx-gap,cy,CLAIM);drawLine(data,width,height,cx+gap,cy,cx+arm,cy,CLAIM);drawLine(data,width,height,cx,cy-arm,cx,cy-gap,CLAIM);drawLine(data,width,height,cx,cy+gap,cx,cy+arm,CLAIM);}
function overlayRequest(data:Uint8Array,width:number,height:number,panel:ScopePanelMeta,dest:DestRect,request:ScopeResolvedRequest,allowForensic=true):void{
	if(isForensic(panel)){if(allowForensic)overlayForensicTarget(data,width,height,panel,dest,request);return;} if(request.richOverlay===false||request.kind==='full')return;
	const color=PATH_COLORS[((request.color%PATH_COLORS.length)+PATH_COLORS.length)%PATH_COLORS.length];
	if(request.kind==='box'||request.kind==='hole'){const a=imageToPanel(panel,dest,[request.focus.x,request.focus.y]),b=imageToPanel(panel,dest,[request.focus.x+request.focus.w,request.focus.y+request.focus.h]);drawRect(data,width,height,Math.round(a[0]),Math.round(a[1]),Math.round(b[0]-a[0]),Math.round(b[1]-a[1]),CLAIM,2);}
	if(request.kind==='point'||request.kind==='mark'){const p=imageToPanel(panel,dest,request.points[0]);drawRing(data,width,height,p[0],p[1],6,CLAIM);drawCircle(data,width,height,p[0],p[1],1,CLAIM);}
	if(request.kind==='dots'||request.kind==='path'||request.kind==='hole'){for(let i=1;i<request.points.length;i++){const a=imageToPanel(panel,dest,request.points[i-1]),b=imageToPanel(panel,dest,request.points[i]);drawLine(data,width,height,a[0],a[1],b[0],b[1],color,request.kind==='path'?2:3);}for(let i=0;i<request.points.length;i++){const p=imageToPanel(panel,dest,request.points[i]);drawCircle(data,width,height,p[0],p[1],9,color);drawNumber(data,width,height,p[0],p[1],request.pointLabels?.[i]??i+1);}}
}
function drawPin(data:Uint8Array,width:number,height:number,x:number,y:number,pin:ScopePinOverlay):void{const color=pin.kind==='kept'?CLAIM:TEMP_PIN,r=pin.kind==='kept'?9:8;if(pin.style==='crosshair'){const gap=3;drawLine(data,width,height,x-r,y,x-gap,y,color);drawLine(data,width,height,x+gap,y,x+r,y,color);drawLine(data,width,height,x,y-r,x,y-gap,color);drawLine(data,width,height,x,y+gap,x,y+r,color);drawCircle(data,width,height,x,y,1,color);}else if(pin.style==='diamond')drawDiamond(data,width,height,x,y,r,color);else{drawRing(data,width,height,x,y,r,color);drawCircle(data,width,height,x,y,1,color);}if(pin.kind==='temp'&&pin.ttlRemaining!==undefined)drawText(data,width,height,Math.round(x+r+4),Math.round(y-3),String(pin.ttlRemaining),2,color);}
function overlayPins(data:Uint8Array,width:number,height:number,panel:ScopePanelMeta,dest:DestRect,pins:readonly ScopePinOverlay[]):void{if(isForensic(panel))return;for(const pin of pins){if(!pointInside(panel.source,pin.point))continue;const p=imageToPanel(panel,dest,pin.point);drawPin(data,width,height,p[0],p[1],pin);}}

export interface RenderScopeInput { readonly raster:RasterImage; readonly imagePath:string; readonly annotationPath?:string; readonly canonical:ScopeCanonicalMeta; readonly request:ScopeResolvedRequest; readonly overlays?:readonly ScopeResolvedRequest[]; readonly pins?:readonly ScopePinOverlay[]; readonly outputPath:string; }
function panelGapAfter(panels:readonly ScopePanelMeta[],index:number):number{if(index>=panels.length-1)return 0;return isForensic(panels[index])&&isForensic(panels[index+1])?6:18;}

// --- readout ------------------------------------------------------------
// An agent cannot diff two pictures. It can diff two numbers. Every value a
// repeatable check needs is printed here in a fixed order at a fixed place,
// so two runs are comparable line by line and a drift shows up as a changed
// digit rather than as "the image looks different".

const READOUT_W = 360;
const READOUT_SCALE = 2;
const READOUT_LINE = 14;

function rgbToHsv(r:number,g:number,b:number):[number,number,number]{
	const mx=Math.max(r,g,b),mn=Math.min(r,g,b),d=mx-mn;
	let h=0;
	if(d!==0){
		if(mx===r)h=60*(((g-b)/d)%6);
		else if(mx===g)h=60*(((b-r)/d)+2);
		else h=60*(((r-g)/d)+4);
	}
	if(h<0)h+=360;
	return [Math.round(h),mx===0?0:Math.round((d/mx)*100),Math.round((mx/255)*100)];
}

function meanBox(src:RasterImage,cx:number,cy:number,half:number):[number,number,number]{
	let r=0,g=0,b=0,n=0;
	for(let y=Math.round(cy)-half;y<=Math.round(cy)+half;y++)for(let x=Math.round(cx)-half;x<=Math.round(cx)+half;x++){
		if(x<0||y<0||x>=src.width||y>=src.height)continue;
		const i=rgbaIndex(src.width,x,y);r+=src.data[i];g+=src.data[i+1];b+=src.data[i+2];n++;
	}
	return n===0?[0,0,0]:[Math.round(r/n),Math.round(g/n),Math.round(b/n)];
}

function readoutLines(input:RenderScopeInput,request:ScopeResolvedRequest,panels:readonly ScopePanelMeta[]):string[] {
	const [ax,ay]=inspectionAnchor(request);
	const px=Math.max(0,Math.min(input.raster.width-1,Math.round(ax)));
	const py=Math.max(0,Math.min(input.raster.height-1,Math.round(ay)));
	const i=rgbaIndex(input.raster.width,px,py);
	const r=input.raster.data[i],g=input.raster.data[i+1],b=input.raster.data[i+2];
	const [h,s,v]=rgbToHsv(r,g,b);
	const m3=meanBox(input.raster,px,py,1);
	const m9=meanBox(input.raster,px,py,4);
	const c=input.canonical;
	const ins=c.stripChrome.insets;
	const lines=[
		'INPUT',
		`  ID      ${c.imageId.slice(0,16).toUpperCase()}`,
		`  MODE    ${input.annotationPath?'TRUTH':'BLIND'}`,
		`  SIZE    ${c.widthPx}X${c.heightPx}`,
		`  STRIP   ${c.stripChrome.source.toUpperCase()}`,
		`  INSETS  ${ins?`${ins.top}/${ins.right}/${ins.bottom}/${ins.left}`:'NONE'}`,
		`  STITCH  ${c.autoStitch.sourceCount} SRC${c.autoStitch.hadFallback?' FALLBACK':''}`,
		'',
		'ANCHOR PIXEL',
		`  KIND    ${String(request.kind).toUpperCase()}`,
		`  AT      ${px} ${py}`,
		`  RGB     ${r}/${g}/${b}`,
		`  HSV     ${h} ${s} ${v}`,
		`  MEAN3   ${m3[0]}/${m3[1]}/${m3[2]}`,
		`  MEAN9   ${m9[0]}/${m9[1]}/${m9[2]}`,
		'',
		'PANELS'
	];
	for(const panel of panels){
		const scale=panel.outputPx/Math.max(panel.source.w,panel.source.h);
		lines.push(`  ${panel.label.slice(0,34).toUpperCase()}`);
		lines.push(`    ${panel.source.x} ${panel.source.y} ${panel.source.w}X${panel.source.h} ${scale.toFixed(2)}X`);
	}
	return lines;
}

function drawReadout(out:Uint8Array,width:number,height:number,x:number,lines:readonly string[]):void{
	fillRect(out,width,height,x,0,READOUT_W,LABEL_H,LABEL_BG);
	drawText(out,width,height,x+6,7,'READOUT',1,TEXT);
	fillRect(out,width,height,x,LABEL_H,READOUT_W,height-LABEL_H,FRAME);
	fillRect(out,width,height,x+CHROME,LABEL_H+CHROME,READOUT_W-CHROME*2,height-LABEL_H-CHROME*2,BG);
	let y=LABEL_H+CHROME+8;
	for(const line of lines){
		if(y+6>height-CHROME)break;
		if(line)drawText(out,width,height,x+CHROME+8,y,line,READOUT_SCALE,TEXT);
		y+=READOUT_LINE;
	}
}

export function renderScope(input:RenderScopeInput):ScopeRenderMeta{
	const view=resolveScopeView(input.request.view);
	const request:ScopeResolvedRequest={...input.request,view};
	const template=getScopeTemplate(request.template);
	const panels=template.panels({imageWidth:input.raster.width,imageHeight:input.raster.height,request});

	// Main panels run left to right. Forensic panels stack in ONE column instead
	// of extending the row -- they are small, and a row of them left ~70% of the
	// canvas empty under each. Stacking costs nothing and removes the dead space.
	const main=panels.filter(p=>!isForensic(p));
	const forensic=panels.filter(p=>isForensic(p));
	const FGAP=6;

	const mainWidth=main.reduce((sum,p,i)=>sum+p.outputPx+CHROME*2+(i<main.length-1?18:0),0);
	const forensicWidth=forensic.length?Math.max(...forensic.map(p=>p.outputPx))+CHROME*2:0;
	const forensicHeight=forensic.reduce((sum,p,i)=>sum+LABEL_H+p.outputPx+CHROME*2+(i<forensic.length-1?FGAP:0),0);
	const mainHeight=main.length?LABEL_H+Math.max(...main.map(p=>p.outputPx))+CHROME*2:0;

	const width=mainWidth+(forensic.length?18+forensicWidth:0)+18+READOUT_W;
	const height=Math.max(mainHeight,forensicHeight,LABEL_H+120);
	const png=new PNG({width,height});
	const out=png.data as Uint8Array;
	fill(out,width,height,BG);

	const paint=(panel:ScopePanelMeta,cardX:number,cardY:number):void=>{
		const cardWidth=panel.outputPx+CHROME*2,imageY=cardY+LABEL_H+CHROME;
		fillRect(out,width,height,cardX,cardY,cardWidth,LABEL_H,LABEL_BG);
		drawText(out,width,height,cardX+6,cardY+7,panel.label,1,TEXT);
		fillRect(out,width,height,cardX,cardY+LABEL_H,cardWidth,panel.outputPx+CHROME*2,FRAME);
		fillRect(out,width,height,cardX+CHROME,imageY,panel.outputPx,panel.outputPx,INNER);
		const dest=copyPanel(input.raster,panel,out,width,height,cardX+CHROME,imageY);
		drawGrid(out,width,height,panel,dest);
		overlayRequest(out,width,height,panel,dest,request,true);
		for(const overlay of input.overlays??[])overlayRequest(out,width,height,panel,dest,overlay,false);
		overlayPins(out,width,height,panel,dest,input.pins??[]);
	};

	let x=0;
	for(let i=0;i<main.length;i++){paint(main[i],x,0);x+=main[i].outputPx+CHROME*2+(i<main.length-1?18:0);}
	if(forensic.length){
		x+=18;let fy=0;
		for(let i=0;i<forensic.length;i++){paint(forensic[i],x,fy);fy+=LABEL_H+forensic[i].outputPx+CHROME*2+FGAP;}
		x+=forensicWidth;
	}
	drawReadout(out,width,height,x+18,readoutLines(input,request,panels));

	mkdirSync(dirname(input.outputPath),{recursive:true});
	writeFileSync(input.outputPath,PNG.sync.write(png));
	const meta:ScopeRenderMeta={schemaVersion:1,mode:input.annotationPath?'TRUTH_AVAILABLE':'BLIND',image:input.imagePath,annotation:input.annotationPath,canonical:input.canonical,request,overlays:input.overlays,view,pins:input.pins,panels,output:input.outputPath};
	writeFileSync(`${input.outputPath}.json`,JSON.stringify(meta,null,2)+'\n');
	return meta;
}

export function makeContactSheet(renderedPaths:readonly string[],outputPath:string):void{if(!renderedPaths.length)throw new Error('lab scope: contact-sheet has no rendered scopes.');const images=renderedPaths.map(path=>({path,png:PNG.sync.read(readFileSync(path))})),tileW=Math.max(...images.map(i=>i.png.width)),tileH=Math.max(...images.map(i=>i.png.height)),cols=Math.max(1,Math.ceil(Math.sqrt(images.length))),rows=Math.ceil(images.length/cols),gap=14,width=cols*tileW+(cols-1)*gap,height=rows*tileH+(rows-1)*gap,sheet=new PNG({width,height}),out=sheet.data as Uint8Array;fill(out,width,height,BG);for(let i=0;i<images.length;i++){const col=i%cols,row=Math.floor(i/cols),dx=col*(tileW+gap),dy=row*(tileH+gap),src=images[i].png;for(let y=0;y<src.height;y++)for(let x=0;x<src.width;x++){const si=rgbaIndex(src.width,x,y),di=rgbaIndex(width,dx+x,dy+y);out[di]=src.data[si];out[di+1]=src.data[si+1];out[di+2]=src.data[si+2];out[di+3]=src.data[si+3];}drawRing(out,width,height,dx+18,dy+18,14,FRAME);drawNumber(out,width,height,dx+18,dy+18,i+1);}mkdirSync(dirname(outputPath),{recursive:true});writeFileSync(outputPath,PNG.sync.write(sheet));writeFileSync(`${outputPath}.json`,JSON.stringify({schemaVersion:1,scopes:renderedPaths.map((path,index)=>({index:index+1,path})),output:outputPath},null,2)+'\n');}

export const TRAVERSE_DIRECTIONS = [
	{n:1,angleDeg:270},{n:2,angleDeg:330},{n:3,angleDeg:30},{n:4,angleDeg:90},{n:5,angleDeg:150},{n:6,angleDeg:210}
] as const;
export function polarOffset(distance:number,angleDeg:number):PointTuple{const radians=angleDeg*Math.PI/180;return[distance*Math.cos(radians),distance*Math.sin(radians)];}
function centeredSource(cx:number,cy:number,span:number,width:number,height:number):Rect{const w=Math.max(1,Math.min(width,Math.round(span))),h=Math.max(1,Math.min(height,Math.round(span))),x=Math.max(0,Math.min(width-w,Math.round(cx-w/2))),y=Math.max(0,Math.min(height-h,Math.round(cy-h/2)));return{x,y,w,h};}
export interface RenderTraverseInput { readonly raster:RasterImage; readonly imagePath:string; readonly canonical:ScopeCanonicalMeta; readonly current:PointTuple; readonly radiusPx:number; readonly overlays?:readonly ScopeResolvedRequest[]; readonly pins?:readonly ScopePinOverlay[]; readonly grid?:boolean; readonly tileOutputPx?:number; readonly outputPath:string; }
export function renderTraverseScope(input:RenderTraverseInput):void{
	const tile=input.tileOutputPx??220,span=Math.max(48,input.radiusPx*2),gap=8,card=tile+CHROME*2,width=card*3+gap*2,height=(LABEL_H+card)*3+gap*2,png=new PNG({width,height}),out=png.data as Uint8Array;fill(out,width,height,BG);
	const centers=new Map<number,PointTuple>();centers.set(0,input.current);for(const d of TRAVERSE_DIRECTIONS){const off=polarOffset(input.radiusPx,d.angleDeg);centers.set(d.n,[input.current[0]+off[0],input.current[1]+off[1]]);}
	const slots=[{n:1,c:1,r:0},{n:6,c:0,r:1},{n:0,c:1,r:1},{n:2,c:2,r:1},{n:5,c:0,r:2},{n:4,c:1,r:2},{n:3,c:2,r:2}];
	for(const slot of slots){const center=centers.get(slot.n)!,x=slot.c*(card+gap),y=slot.r*(LABEL_H+card+gap),source=centeredSource(center[0],center[1],span,input.raster.width,input.raster.height),angle=slot.n===0?'NOW':`${TRAVERSE_DIRECTIONS.find(d=>d.n===slot.n)!.angleDeg}DEG`,panel:ScopePanelMeta={name:'context',label:`${slot.n} ${angle}`,source,outputPx:tile,resampling:'bilinear',nearestNeighbor:false,grid:input.grid??true};fillRect(out,width,height,x,y,card,LABEL_H,LABEL_BG);drawText(out,width,height,x+6,y+7,panel.label,1,TEXT);fillRect(out,width,height,x,y+LABEL_H,card,card,FRAME);fillRect(out,width,height,x+CHROME,y+LABEL_H+CHROME,tile,tile,INNER);const dest=copyPanel(input.raster,panel,out,width,height,x+CHROME,y+LABEL_H+CHROME);drawGrid(out,width,height,panel,dest);for(const overlay of input.overlays??[])overlayRequest(out,width,height,panel,dest,overlay,false);overlayPins(out,width,height,panel,dest,input.pins??[]);const marker=imageToPanel(panel,dest,center);drawRing(out,width,height,marker[0],marker[1],6,CLAIM);drawCircle(out,width,height,marker[0],marker[1],1,CLAIM);}
	mkdirSync(dirname(input.outputPath),{recursive:true});writeFileSync(input.outputPath,PNG.sync.write(png));writeFileSync(`${input.outputPath}.json`,JSON.stringify({schemaVersion:1,image:input.imagePath,canonical:input.canonical,current:input.current,radiusPx:input.radiusPx,directions:TRAVERSE_DIRECTIONS,centers:Object.fromEntries(centers),output:input.outputPath},null,2)+'\n');
}
