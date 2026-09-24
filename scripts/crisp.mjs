#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const [command,stage,lineage='work']=process.argv.slice(2);
if(command!=='delta'||!stage){console.error('usage: crisp delta <Stage> [work|exp/name]');process.exit(2);}
const root=resolve('packages/alg/src/stages',stage), clean=resolve(root,'clean'), target=resolve(root,lineage);
if(!existsSync(clean)||!existsSync(target)){console.error(`crisp: missing baseline or target: ${stage}/clean vs ${stage}/${lineage}`);process.exit(2);}
function files(dir,c=dir){return readdirSync(c).sort().flatMap(n=>{const p=resolve(c,n);return statSync(p).isDirectory()?files(dir,p):[p]});}
function digest(p){return createHash('sha256').update(readFileSync(p)).digest('hex');}
const a=new Map(files(clean).map(p=>[relative(clean,p),digest(p)]));
const b=new Map(files(target).map(p=>[relative(target,p),digest(p)]));
const paths=[...new Set([...a.keys(),...b.keys()])].sort();
const changed=paths.filter(p=>a.get(p)!==b.get(p)).map(p=>({path:p,kind:!a.has(p)?'added':!b.has(p)?'removed':'changed'}));
const receipt={stage,baseline:'clean',lineage,changed,delta:changed.length};
console.log(JSON.stringify(receipt,null,2));
