#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const HERE=dirname(fileURLToPath(import.meta.url));
const LAB_DIR=resolve(HERE,'..');
const REPO_ROOT=resolve(LAB_DIR,'../..');
const requireFromLab=createRequire(import.meta.url);
let tsxImportPath=null;

const COMMANDS={
  ui:{group:'LOOK',summary:'open the local clickable LAB workbench',examples:['ui','ui --port 4317','ui --no-open'],run:a=>runTs('ui/server.ts',a)},
  scope:{group:'LOOK',summary:'stateless canonical raster inspection',examples:['scope --help','scope course.png 880,429','scope full course.png'],run:a=>runTs('scope/scopeCli.ts',a)},
  search:{group:'LOOK',summary:'stateful visual investigation with Pages/pins/trails',examples:['search --help','search start course.png h7 1143,1105','search page show scratch'],run:a=>runTs('search/searchCli.ts',a)},
  traverse:{group:'LOOK',summary:'hex-assisted Cartesian/polar navigation over Search',examples:['traverse --help','traverse start course.png walk 700,900','traverse go walk --polar 100,245'],run:a=>runTs('traverse/traverseCli.ts',a)},
  invariants:{group:'KNOW',summary:'observed renderer truths',examples:['invariants','invariants I21'],run:a=>runTs('invariants.ts',a)},
  detectors:{group:'KNOW',summary:'detector registry',examples:['detectors','detectors D04'],run:a=>runTs('detectors.ts',a)},
  gates:{group:'KNOW',summary:'pipeline/gate vocabulary',examples:['gates','gates 3'],run:a=>runTs('gates.ts',a)},
  cases:{group:'KNOW',summary:'hard-evidence cases',examples:['cases'],run:a=>runTs('cases.ts',a)},
  compile:{group:'RUN',summary:'inspect/compile algorithm config; no raster execution',examples:['compile packages/alg/src/detectors/threeFactor/configs/default.json'],run:a=>runTs('sweep/sweepCli.ts',['compile',...a])},
  sweep:{group:'RUN',summary:'StripChrome/AutoStitch + only algorithm execution path',examples:['sweep CONFIG.json IMAGE.png','sweep CONFIG.json TILE1.png TILE2.png'],run:a=>runTs('sweep/sweepCli.ts',['sweep',...a])},
  orient:{group:'PROVENANCE',summary:'machine-bound frozen-reference auditor',examples:['orient 3fd72','orient 3fd72 --verbose'],run:a=>runOrient(a)}
};
const BUILT_INS=new Set(['help','history','run-script','exit','quit']);

function printRootHelp(){console.log('LAB — tools for seeing, navigating, measuring, testing, and learning ChainSpot CV\n\nUsage:\n  lab <command> [args]     one-shot\n  lab                      interactive shell\n');for(const group of ['LOOK','KNOW','RUN','PROVENANCE']){console.log(group);for(const [name,c] of Object.entries(COMMANDS))if(c.group===group)console.log(`  ${name.padEnd(12)} ${c.summary}`);console.log('');}console.log('SHELL\n  help [command]            show discoverable help\n  history                   show commands entered in this shell\n  run-script FILE           execute LAB commands in order\n  exit | quit               leave interactive LAB\n\nRaster contract:\n  raw capture(s) -> Sweep StripChrome -> AutoStitch -> canonical raster -> Scope/Search/Traverse/algorithm\n\nDiscover:\n  lab ui\n  lab scope --help\n  lab search --help\n  lab traverse --help\n  lab sweep --help\n\n`ui` and CLI call the same LAB operation modules. LAB exposes no arbitrary shell/eval escape. `sweep` remains the only algorithm execution path.');}
function printCommandHelp(name){const c=COMMANDS[name];if(!c){console.error(`lab: unknown command '${name}'.`);return 2;}console.log(`${name.toUpperCase()} — ${c.summary}\n\nExamples:`);for(const e of c.examples)console.log(`  lab ${e}`);console.log(`\nFor the full surface: lab ${name} --help`);return 0;}
function ensureTsxImport(){if(tsxImportPath)return tsxImportPath;try{tsxImportPath=requireFromLab.resolve('tsx');return tsxImportPath;}catch{throw new Error('LAB dependencies are not installed. Run: (cd scripts/chainspot-lab && npm install)');}}
function spawnProcess(command,args,options={}){return new Promise((res,rej)=>{const child=spawn(command,args,{cwd:REPO_ROOT,stdio:'inherit',shell:process.platform==='win32'&&command.toLowerCase().endsWith('.cmd'),...options});child.once('error',rej);child.once('exit',(code,signal)=>signal?rej(new Error(`command terminated by ${signal}`)):res(code??1));});}
async function runTs(file,args){return spawnProcess(process.execPath,['--import',pathToFileURL(ensureTsxImport()).href,resolve(LAB_DIR,file),...args]);}
async function runOrient(args){if(args[0]!=='3fd72'||args.length>2||(args[1]&&args[1]!=='--verbose')){console.error('Usage: lab orient 3fd72 [--verbose]');return 2;}return spawnProcess(process.execPath,[resolve(REPO_ROOT,'scripts/lab-orient-3fd72.mjs'),...args.slice(1)]);}
function splitCommandLine(line){const out=[];let token='',quote=null;for(let i=0;i<line.length;i++){const ch=line[i],next=line[i+1];if(quote){if(ch===quote){quote=null;continue;}if(ch==='\\'&&next===quote){token+=next;i++;continue;}token+=ch;continue;}if(ch==='"'||ch==="'"){quote=ch;continue;}if(/\s/.test(ch)){if(token){out.push(token);token='';}continue;}if(ch==='\\'&&next&&(/\s/.test(next)||next==='"'||next==="'"||next==='\\')){token+=next;i++;continue;}token+=ch;}if(quote)throw new Error(`unterminated ${quote} quote`);if(token)out.push(token);return out;}
async function runScript(filePath,state){const path=resolve(process.cwd(),filePath);let text;try{text=readFileSync(path,'utf8');}catch(e){console.error(`lab: could not read script ${path}: ${e.message}`);return 1;}let n=0;for(const raw of text.split(/\r?\n/)){n++;const line=raw.trim();if(!line||line.startsWith('#'))continue;console.log(`lab[${n}]> ${line}`);let argv;try{argv=splitCommandLine(line);}catch(e){console.error(`lab: ${path}:${n}: ${e.message}`);return 2;}const code=await dispatch(argv,state,{fromScript:true});if(code!==0)return code;}return 0;}
async function dispatch(argv,state={history:[]},options={}){if(!argv.length)return 0;const [name,...args]=argv;if(name==='--help'||name==='-h'){printRootHelp();return 0;}if(name==='help')return args.length?printCommandHelp(args[0]):(printRootHelp(),0);if(name==='history'){state.history.forEach((e,i)=>console.log(`${String(i+1).padStart(3)}  ${e}`));return 0;}if(name==='run-script'){if(args.length!==1){console.error('Usage: lab run-script FILE');return 2;}return runScript(args[0],state);}if(name==='exit'||name==='quit')return options.fromScript?0:'exit';const command=COMMANDS[name];if(!command){console.error(`lab: unknown command '${name}'. Try: lab --help`);return 2;}if(args.length===1&&(args[0]==='--help'||args[0]==='-h'))return command.run(args);try{return await command.run(args);}catch(e){console.error(`lab: ${e.message}`);return 1;}}
async function repl(){const names=[...Object.keys(COMMANDS),...BUILT_INS].sort(),state={history:[]},rl=createInterface({input,output,prompt:'lab> ',completer(line){const p=line.trimStart(),hits=names.filter(n=>n.startsWith(p));return[hits.length?hits:names,p];}});console.log('ChainSpot LAB. `help` to discover; `exit` to leave.');rl.prompt();for await(const raw of rl){const line=raw.trim();if(!line){rl.prompt();continue;}state.history.push(line);try{const result=await dispatch(splitCommandLine(line),state);if(result==='exit')break;}catch(e){console.error(`lab: ${e.message}`);}rl.prompt();}rl.close();}
const argv=process.argv.slice(2);if(!argv.length)await repl();else{const code=await dispatch(argv);process.exitCode=code==='exit'?0:code;}
