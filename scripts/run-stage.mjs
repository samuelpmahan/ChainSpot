import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {PNG} from 'pngjs';
import {executeNodeCanonicalInputTick} from '../packages/alg/dist/exec/node-intake.js';
import {renderPqlHtml} from '../packages/alg/dist/exec/render.js';
// Usage: node scripts/run-stage.mjs <compiled-stage-directory> <input-image> <output-directory>
const [directory,input,output]=process.argv.slice(2);
if(!directory||!input||!output)throw new Error('Provide compiled Stage directory, input image, and output directory.');
const {createStage}=await import(pathToFileURL(resolve(directory,'stage.js')).href);
const stage=createStage(readFileSync(resolve(directory,'PrincipleComponentRender.yaml'),'utf8'));
const warm=await executeNodeCanonicalInputTick(resolve(input));
const results=stage.run({pxc:warm.pxc});mkdirSync(output,{recursive:true});
const r=warm.croppedImage;
const source='data:image/png;base64,'+PNG.sync.write({width:r.widthPx,height:r.heightPx,data:Buffer.from(r.rgba)}).toString('base64');
for(const [index,result] of results.entries()) {
 if(result.run)writeFileSync(join(output,`${index}-inspect.html`),renderPqlHtml(result.run,r.widthPx,r.heightPx,source));
}
writeFileSync(join(output,'results.json'),JSON.stringify(results, (key,value)=>{
 if(key==='pxc')return undefined;
 return ArrayBuffer.isView(value)?Array.from(value):value;
}));
console.log(results.map(r=>({variant:r.variant,status:r.status,error:r.error})));
if(results.some(r=>r.status==='failed'))process.exitCode=1;
