// Core types for the config-driven threeFactor engine.
//
// The algorithm is executed as an ordered list of UNITS over a shared
// evidence board; the order comes from the CONFIG (the single readable
// source of truth for the alg), validated against each unit's declared
// consumes/produces. ABFeatures are behavior with an A/B-style easy-off:
// baseline units default ON and deviations default OFF so the default config
// remains the explicit recovered production behavior.

import type { ABFeatureOperation } from '../../../exec/feature-set';
import { OcclusionDetector } from '../occlusion';
import type { StraightTestTrace } from './st.straightTest.contract';

export type GateId = 'G1' | 'G2' | 'G3' | 'G4' | 'G5' | 'G6' | 'G7' | 'shared';
export const CANONICAL_GATE_ORDER = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7'] as const;
export const GATE_TITLES: Record<GateId, string> = {
	G1: 'Badges', G2: 'Baskets', G3: 'Visible Tees', G4: 'Recovery (Tee + Basket)', G5: 'Straight Test', G6: 'Assignment', G7: 'Bend Refinement', shared: 'Shared Infrastructure'
};
export const LAB_GATE_MAPPING: Record<number, GateId | 'pre-detector'> = {0:'pre-detector',1:'G1',2:'G2',3:'G3',4:'G4',5:'G5',6:'G6',7:'G7'};
export interface KnobSpec<T>{readonly default:T;readonly note?:string;readonly validate?:(value:T)=>string|null;}
export type KnobSpecs=Record<string,KnobSpec<unknown>>;
export type KnobValues<K extends KnobSpecs>={readonly [P in keyof K]:K[P]['default']};
export interface ABFeature<K extends KnobSpecs=KnobSpecs>{readonly id:string;readonly gate:GateId;readonly kind:'baseline'|'deviation';readonly defaultEnabled:boolean;readonly resolveOnlyWhenConfigured?:boolean;readonly note?:string;readonly knobs:K;readonly operations?:readonly ABFeatureOperation[];readonly render?:FeatureRender;}
export interface ResolvedFeature{readonly enabled:boolean;readonly knobs:Record<string,unknown>;}
export type Verdict='accepted'|'rejected'|'info';
export interface DrawableBase{readonly verdict:Verdict;readonly reason?:string;readonly ref?:string;readonly values?:Record<string,number>;readonly metadata?:Readonly<Record<string,string>>;readonly visualRole?:'badge-pixels'|'basket-tip'|'tee-visible-pixels'|'tee-border'|'tee-center'|'tee-shard'|'tee-corner-tick'|'tee-diagonal'|'tee-rejection'|'phantom-center'|'tee-badge-path'|'tee-badge-abstention'|'hole-label'|'badge-glyph-template-verdict';}
export interface PointDrawable extends DrawableBase{readonly type:'point';readonly xPx:number;readonly yPx:number;}
export interface BoxDrawable extends DrawableBase{readonly type:'box';readonly bbox:readonly[number,number,number,number];}
export interface PolylineDrawable extends DrawableBase{readonly type:'polyline';readonly path:readonly(readonly[number,number])[];}
export interface PixelSetDrawable extends DrawableBase{readonly type:'pixelSet';readonly pixels:readonly(readonly[number,number])[];}
export interface HeatmapDrawable extends DrawableBase{readonly type:'heatmap';readonly key:string;readonly widthCells:number;readonly heightCells:number;readonly cellPx:number;readonly originXPx:number;readonly originYPx:number;}
export type Drawable=PointDrawable|BoxDrawable|PolylineDrawable|PixelSetDrawable|HeatmapDrawable;
export interface MeasurementAggregate{readonly name:string;count:number;min:number;max:number;sum:number;}
export interface UnitTrace{readonly id:string;readonly gate:GateId;readonly featureId?:string;readonly featureIds:readonly string[];readonly enabled:boolean;readonly knobs:Record<string,unknown>;readonly knobsDeviating:readonly string[];ms:number;readonly drawables:Drawable[];readonly measurements:MeasurementAggregate[];}
export interface RunTrace{readonly configName:string;readonly paramsHash:string;readonly runId?:string;readonly imageId?:string;readonly traceHash?:string;readonly canonicalFrame?:string;readonly execution:readonly string[];readonly features:Readonly<Record<string,ResolvedFeature>>;readonly units:UnitTrace[];readonly heatmaps:Record<string,Float32Array>;readonly straightTest?:StraightTestTrace;}
export interface FeatureRenderLayer{readonly name:string;readonly note?:string;readonly drawables:readonly Drawable[];}
export interface FeatureRenderPlan{readonly title:string;readonly base?:string;readonly layers:readonly FeatureRenderLayer[];readonly notes:readonly string[];}
export interface FeatureRender{readonly units:readonly string[];draw(unit:UnitTrace,run:RunTrace):FeatureRenderPlan;}
export interface FeatureContext{resolve(feature:ABFeature):ResolvedFeature;measure(unitId:string,name:string,value:number):void;overlay(unitId:string,drawable:Drawable):void;heatmap(unitId:string,key:string,data:Float32Array):void;recordStraightTest?(trace:StraightTestTrace):void;span(unitId:string):()=>void;readonly occlusion:OcclusionDetector;}
export const nullFeatureContext:FeatureContext={occlusion:new OcclusionDetector(),resolve(feature){return{enabled:feature.defaultEnabled,knobs:defaultKnobs(feature)};},measure(){},overlay(){},heatmap(){},span(){return()=>{};}};
export function defaultKnobs(feature:ABFeature):Record<string,unknown>{const out:Record<string,unknown>={};for(const[name,spec]of Object.entries(feature.knobs))out[name]=spec.default;return out;}
export type EvidenceSlot='image'|'localImage'|'params'|'viewport'|'stage'|'badges'|'supportField'|'sprites'|'baskets'|'tees'|'rawPairs'|'measurement'|'recoveredTees'|'straightProposals'|'straightTestTruthAssistance'|'assignment'|'teeBadgeLock'|'teeBadgeCompass'|'badgeGlyphTemplate'|'objectPerimetersV1';
export interface EvidenceBoard{get<T>(slot:EvidenceSlot):T;has(slot:EvidenceSlot):boolean;set(slot:EvidenceSlot,value:unknown):void;}
export interface EngineUnit{readonly id:string;readonly gate:GateId;readonly consumes:readonly EvidenceSlot[];readonly produces:readonly EvidenceSlot[];readonly note?:string;run(board:EvidenceBoard,ctx:FeatureContext):void;}
