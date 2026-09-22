import assert from 'node:assert/strict';
import test from 'node:test';
import { createExecBoard } from '../../packages/alg/dist/exec/board.js';

test('fork is a lineage resolution context over shared Part editions',()=>{
 const clean=createExecBoard();
 clean.set('product',35);
 const exp=clean.fork('exp/repeated-add');
 assert.equal(exp.get('product'),35,'fork inherits snapshot fallback before publishing its edition');
 exp.set('product',35);
 assert.equal(exp.get('product'),35);
 assert.equal(clean.get('product'),35);
 exp.set('product',36);
 assert.equal(exp.get('product'),36);
 assert.equal(clean.get('product'),35,'experimental editions never mutate clean resolution');
});
test('sibling lineages remain structurally isolated',()=>{
 const root=createExecBoard(); root.set('x',4);
 const a=root.fork('exp/a'), b=root.fork('exp/b');
 a.set('answer',5); b.set('answer',8);
 assert.equal(a.get('answer'),5); assert.equal(b.get('answer'),8);
 assert.equal(root.has('answer'),false);
});
