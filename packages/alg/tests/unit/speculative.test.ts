import { describe, expect, it } from 'vitest';
import { convergeOnEquivalence, propagateWhileParity, semanticDelta, surgicalExecutionCone } from '../../src/exec/speculative';

describe('production speculative kernel', () => {
	it('opens only the semantic divergence cone', () => {
		const deltas=semanticDelta({membership:{bottom:4},meta:{filename:'a'}},{membership:{bottom:20},meta:{filename:'a'}});
		expect(surgicalExecutionCone(deltas,[
			{id:'edge',semanticConsumes:['membership.bottom'],produces:['edges']},
			{id:'measure',consumes:['edges'],produces:['stats']},
			{id:'meta',semanticConsumes:['meta.filename'],produces:['receipt']}
		])).toEqual([
			{id:'edge',resolution:'EXECUTE'},
			{id:'measure',resolution:'EXECUTE'},
			{id:'meta',resolution:'REUSE'}
		]);
	});
	it('closes on parity and stops pass-while at first rebuke', () => {
		expect(convergeOnEquivalence('candidate','clean',{parity:true,comparator:'fn.compare'}).converged).toBe(true);
		let after=false;
		const result=propagateWhileParity([
			{id:'S0',compare:()=>({parity:true})},
			{id:'S1',compare:()=>({parity:false,where:'Badge 7'})},
			{id:'S2',compare:()=>{after=true; return {parity:true};}}
		]);
		expect(result.status).toBe('REBUKED');
		expect(result.stoppedAt).toBe('S1');
		expect(after).toBe(false);
	});
});
