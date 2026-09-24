#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { invalidationClosure, comparisonObligations } from './pxcube-graph.mjs';

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

const contractPath=resolve('artifacts/crisp',`${stage}.stage.json`);
let semantic;
if(existsSync(contractPath)){
	const contract=JSON.parse(readFileSync(contractPath,'utf8'));
	const ticks=contract.ticks??[];
	// crisp contracts are authoritative for fn.* membership. Changed source is
	// conservatively mapped to any Calculation whose semantic tail appears in
	// the changed path; if mapping is ambiguous, fail loudly rather than claim a
	// surgical DeltaBuild.
	const seeds=[];
	for(const tick of ticks) for(const fn of tick.calculations??[]){
		const tail=fn.slice(3).split('.').at(-1).toLowerCase();
		if(changed.some(x=>x.path.toLowerCase().includes(tail))) seeds.push(tick.id);
	}
	const unique=[...new Set(seeds)];
	if(changed.length&&unique.length===0){
		semantic={status:'UNMAPPED',reason:'changed source has no registered fn.* identity; DeltaBuild refused'};
	}else{
		const affectedTicks=invalidationClosure(ticks,unique);
		semantic={
			status:'MAPPED',
			seedTicks:unique,
			affectedTicks,
			affectedParts:[...new Set(ticks.filter(t=>affectedTicks.includes(t.id)).flatMap(t=>t.produces??[]))],
			comparisonObligations:comparisonObligations(ticks,unique)
		};
	}
}else semantic={status:'NO_CONTRACT',reason:`missing crisp contract ${relative(process.cwd(),contractPath)}`};

console.log(JSON.stringify({stage,baseline:'clean',lineage,changed,delta:changed.length,semantic},null,2));
