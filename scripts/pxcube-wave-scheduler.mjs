/**
 * Deterministic DAG waves from Part dependencies.
 * Physical execution inside a wave may be parallel; wave/receipt order stays stable.
 */
export function executionWaves(ops, seeded=[]){
  const available=new Set(seeded), remaining=[...ops], waves=[];
  while(remaining.length){
    const wave=remaining.filter(op=>(op.consumes??[]).every(p=>available.has(p)));
    if(!wave.length) throw new Error('scheduler: unresolved dependency cycle or missing Part');
    waves.push(wave);
    for(const op of wave) for(const p of op.produces??[]) available.add(p);
    const ids=new Set(wave.map(x=>x.id));
    for(let i=remaining.length-1;i>=0;i--) if(ids.has(remaining[i].id)) remaining.splice(i,1);
  }
  return waves;
}

export async function executeWaves({ops,seeded=[],run}){
  const waves=executionWaves(ops,seeded);
  const testimony=[];
  for(let wi=0;wi<waves.length;wi++){
    const wave=waves[wi];
    const results=await Promise.all(wave.map((op,index)=>run(op,{wave:wi,index})));
    for(let i=0;i<wave.length;i++) testimony.push({wave:wi,index:i,opId:wave[i].id,result:results[i]});
  }
  return {waves:waves.map(w=>w.map(x=>x.id)),testimony};
}
