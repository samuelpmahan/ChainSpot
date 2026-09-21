import assert from 'node:assert/strict';
import test from 'node:test';
import { planS1BadgeSpeculation } from '../../scripts/pxcube-s1-real-cone.mjs';

const ops=[
 {id:'badgeStage.masks',unit:'badgeStage',semanticConsumes:['localImage.pixels','feature.sharedHsv.knobs'],consumes:['localImage'],produces:['badgeStage.masks']},
 {id:'badgeStage.components',unit:'badgeStage',semanticConsumes:['badgeStage.masks.bright','badgeStage.masks.dark'],consumes:['badgeStage.masks'],produces:['badgeStage.components']},
 {id:'badgeStage.family',unit:'badgeStage',semanticConsumes:['localImage.width','badgeStage.masks.dark','badgeStage.components.bright','feature.g1Badges.knobs'],consumes:['badgeStage.masks','badgeStage.components','localImage'],produces:['badgeStage.family']},
 {id:'badgeStage.badges',unit:'badgeStage',semanticConsumes:['localImage.width','badgeStage.masks','badgeStage.components','badgeStage.family','feature.g1Badges.knobs'],consumes:['badgeStage.masks','badgeStage.components','badgeStage.family','localImage'],produces:['stage']}
];

test('localImage pixel delta lights the real S1 badge cone',()=>{
 const plan=planS1BadgeSpeculation(ops,[{path:'localImage.pixels',before:'clean',after:'candidate'}]);
 assert.deepEqual(plan.map(x=>[x.id,x.resolution]),[
  ['badgeStage.masks','EXECUTE'],
  ['badgeStage.components','EXECUTE'],
  ['badgeStage.family','EXECUTE'],
  ['badgeStage.badges','EXECUTE']
 ]);
});

test('irrelevant filename delta reuses fully declared badge cone',()=>{
 const plan=planS1BadgeSpeculation(ops,[{path:'localImage.filename',before:'a',after:'b'}]);
 assert.ok(plan.every(x=>x.resolution==='REUSE'));
});
