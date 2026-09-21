export function resolutionTestimony({lineage, deltas, plan, calculations}) {
  const changed=deltas.map(d=>d.path);
  const byId=new Map(calculations.map(c=>[c.id,c]));
  const executing=new Set(plan.filter(p=>p.resolution==='EXECUTE').map(p=>p.id));
  const producer=new Map();
  for(const c of calculations) for(const part of c.produces ?? []) producer.set(part,c.id);

  return plan.map(item=>{
    const calc=byId.get(item.id);
    let cause=[];
    if(item.reason==='semantic-dependency-unknown') cause=['semantic dependency undeclared'];
    else if(item.resolution==='REUSE') cause=['declared semantic dependencies unaffected'];
    else {
      cause=(calc.semanticConsumes ?? []).filter(dep=>changed.some(path=>path===dep||path.startsWith(dep+'.')||dep.startsWith(path+'.')));
      if(!cause.length) cause=(calc.consumes ?? []).flatMap(part=>{
        const p=producer.get(part); return p && executing.has(p) ? [`${part} changed by ${p}`] : [];
      });
    }
    return {lineage,calculation:item.id,resolution:item.resolution,reason:item.reason,cause};
  });
}
