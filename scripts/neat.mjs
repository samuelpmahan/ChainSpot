#!/usr/bin/env node
import { cpSync, existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const [command, stage] = process.argv.slice(2);
if(command!=='work'||!stage){console.error('usage: neat work <Stage>');process.exit(2);}
const root=resolve('packages/alg/src/stages',stage);
const clean=resolve(root,'clean'), work=resolve(root,'work');
if(!existsSync(clean)){console.error(`neat: ${stage}/clean does not exist`);process.exit(2);}
if(existsSync(work)){console.error(`neat: ${stage}/work already exists; refusing to clobber active work`);process.exit(2);}
cpSync(clean,work,{recursive:true});
console.log(`neat: seeded ${stage}/work from promoted clean baseline`);
